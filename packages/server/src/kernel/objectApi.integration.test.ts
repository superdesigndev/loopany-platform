import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/kernel-schema.js");
let legacySchema: typeof import("../db/schema.js");
let kernel: typeof import("./applyTransition.js");
let store: typeof import("../db/kernelStore.js");
let api: typeof import("./objectApi.js");
let ids: typeof import("./ids.js");
let queue: typeof import("./runQueue.js");
let prodStore: typeof import("../db/store.js");

const TEAM = "team-api";
const T0 = "2026-08-03T00:00:00.000Z";
const T1 = new Date("2026-08-03T01:00:00.000Z");
const human = { teamId: TEAM, actor: { entrance: "human", actorId: "u-owner" }, mode: "human" } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-object-api-"));
  process.env.LOOPANY_DATA_DIR = temp; process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js"); await database.runMigrations();
  schema = await import("../db/kernel-schema.js"); legacySchema = await import("../db/schema.js");
  kernel = await import("./applyTransition.js"); store = await import("../db/kernelStore.js"); api = await import("./objectApi.js"); ids = await import("./ids.js"); queue = await import("./runQueue.js"); prodStore = await import("../db/store.js");
});
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(async () => {
  await database.db.delete(schema.events);
  await database.db.delete(schema.objects);
  await database.db.delete(legacySchema.runs);
  await database.db.delete(legacySchema.loops);
});

/** THE loop: a production row. `objects` holds task/doc/mirror only after
 *  convergence S5, so there is no second kind of loop to make. */
let loopSeq = 0;
async function makeLoop(title = "Housekeeper", enabled = true) {
  return prodStore.createLoop({
    id: `loop-objapi${loopSeq++}`,
    userId: "u-owner",
    teamId: TEAM,
    machineId: "m-object-api",
    name: title,
    cron: "0 7 * * *",
    timezone: null,
    enabled,
    notify: "auto",
    taskFileContent: `# ${title}\n\n## Spec\n\ncharter`,
  });
}

/** An agent context: a device credential PLUS run context, which is what makes a
 *  request an agent's (spec §2.1). The run row is only read for id/loopId here. */
function agentIn(loopId: string, runId = "run-exec"): never {
  return { teamId: TEAM, actor: { entrance: "agent", actorId: runId }, mode: "agent", run: { id: runId, loopId } } as never;
}

/** Every task names a watcher (`types.ts` WATCHER_HINT). A loop-created one
 *  falls back to its creator, so only the human-created fixtures name one. */
const WATCHER = "loop-fixture";
async function makeTask(fields: Record<string, unknown> = {}, loopId?: string) {
  const result = await kernel.createObject({
    teamId: TEAM, kind: "task", actor: loopId ? { entrance: "agent", actorId: "run-proposer" } : human.actor, now: T0,
    title: "Observe the impact of PR #201", watcher: loopId ?? WATCHER,
    ...(loopId ? { createdByLoop: loopId } : {}), ...fields,
  } as never);
  if (!result.ok) throw new Error(result.message); return result.object;
}

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "OK" : r.error!.code);

// ------------------------------------------------------------------ creation

describe("create is idempotent by key, and never silently discards", () => {
  const file = (title: string, body: string) => `---\ntitle: ${title}\nkey: pr-201-impact\nwatcher: ${WATCHER}\n---\n\n${body}\n`;

  it("replays byte-identical content with no second write and no notice", async () => {
    const first = ok(await api.createFromArtifact("task", file("Observe", "watch the error rate"), human, T1));
    const second = ok(await api.createFromArtifact("task", file("Observe", "watch the error rate"), human, T1));
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, contentDiffers: false, differingFields: [], event: null });
    expect(second.notice).toBeUndefined();
    expect((second.task as { id: string }).id).toBe((first.task as { id: string }).id);
  });

  it("says so, names the differing fields, and points at update when content differs", async () => {
    const first = ok(await api.createFromArtifact("task", file("Observe", "watch the error rate"), human, T1));
    const again = ok(await api.createFromArtifact("task", file("Observe harder", "watch p95 too"), human, T1));
    expect(again).toMatchObject({ created: false, contentDiffers: true });
    expect(again.differingFields).toEqual(expect.arrayContaining(["title", "body"]));
    expect(again.notice).toMatchObject({ code: "KEY_EXISTS_CONTENT_DIFFERS" });
    // The edits went nowhere; the stored object is untouched.
    expect((again.task as { title: string }).title).toBe("Observe");
    expect((again.notice as { hint: string }).hint).toContain(`PATCH /api/tasks/${(first.task as { id: string }).id}`);
  });

  it("refuses a key that already names a different kind, rather than returning the wrong object", async () => {
    await api.createFromArtifact("doc", "---\ntitle: A doc\nkey: shared-key\n---\n\nbody\n", human, T1);
    expect(code(await api.createFromArtifact("task", `---\ntitle: A task\nkey: shared-key\nwatcher: ${WATCHER}\n---\n\nbody\n`, human, T1))).toBe("KEY_KIND_MISMATCH");
  });

  it("stamps provenance from the invisible run context, never from the wire", async () => {
    const loop = await makeLoop();
    const created = ok(await api.createFromArtifact("task", "---\ntitle: From a run\n---\n\nbody\n", agentIn(loop.id), T1));
    expect(created.task).toMatchObject({ createdByRun: "run-exec", createdByLoop: loop.id, status: "open" });
  });
});

/**
 * THE WATCHER RULE at the create seam (captain ruling 2026-08-04). The two
 * halves are asymmetric on purpose: a run has a loop to fall back to and a
 * person does not, so one defaults and the other is taught.
 */
describe("a task is never created without a loop watching it", () => {
  it("DEFAULTS a run's task to the run's own loop", async () => {
    const loop = await makeLoop();
    const created = ok(await api.createFromArtifact("task", "---\ntitle: I will follow this up myself\n---\n\nbody\n", agentIn(loop.id), T1));
    expect(created.task).toMatchObject({ watcher: loop.id, createdByLoop: loop.id });
  });

  it("keeps an explicitly named watcher — the default is a fallback, not an override", async () => {
    const loop = await makeLoop();
    const other = await makeLoop("FollowUp");
    const created = ok(await api.createFromArtifact("task", `---\ntitle: Over to you\nwatcher: ${other.id}\n---\n\nbody\n`, agentIn(loop.id), T1));
    expect(created.task).toMatchObject({ watcher: other.id, createdByLoop: loop.id });
  });

  it("REFUSES a human create with no watcher, and teaches the flag and the roster", async () => {
    const result = await api.createFromArtifact("task", "---\ntitle: Somebody should do this\n---\n\nbody\n", human, T1);
    expect(code(result)).toBe("WATCHER_REQUIRED");
    const error = (result as { error: { issues: { path: string }[]; hint: string } }).error;
    expect(error.issues[0]!.path).toBe("watcher");
    expect(error.hint).toContain("--watcher <loop-id>");
    expect(error.hint).toContain("loopany loops");
    // Nothing was written: a refused create leaves no half-made task behind.
    expect(await database.db.select().from(schema.objects).where(eq(schema.objects.kind, "task"))).toHaveLength(0);
  });

  it("accepts the same human create once it names one", async () => {
    const loop = await makeLoop();
    const created = ok(await api.createFromArtifact("task", `---\ntitle: Somebody should do this\nwatcher: ${loop.id}\n---\n\nbody\n`, human, T1));
    expect(created.task).toMatchObject({ watcher: loop.id, createdByLoop: null });
  });
});

/**
 * NEITHER TRANSFER NOR RELEASE (captain ruling 2026-08-05). The watcher is
 * chosen at CREATE and kept: there is no `watcher` write on an existing task at
 * all, and both shapes an old caller might send are refused BY NAME rather than
 * ignored, so a habit is corrected instead of silently doing nothing.
 */
describe("a task keeps the watcher it was created with", () => {
  it("refuses a hand-off through the field patch, and teaches close-and-re-file", async () => {
    const loop = await makeLoop();
    const task = await makeTask({}, loop.id);
    const result = await api.patchTask(task.id, { watcher: "loop-steward" }, human, T1);
    expect(code(result)).toBe("WATCHER_IMMUTABLE");
    const error = (result as { error: { hint: string; issues: { path: string }[] } }).error;
    expect(error.hint).toContain("a task keeps its watcher; hand-off is not a thing today");
    expect(error.hint).toContain("file a fresh one");
    expect(error.issues[0]!.path).toBe("watcher");
    // Nothing was written: the stored watcher is untouched.
    expect((await store.getObject(undefined, task.id))!.watcher).toBe(loop.id);
  });

  // Re-sending the watcher a task ALREADY has is the one shape that passes: the
  // canonical show → edit → update roundtrip carries the line back verbatim, and
  // refusing a byte nobody touched would break it.
  it("accepts the watcher it already has — a roundtrip is not a hand-off", async () => {
    const task = await makeTask();
    expect(ok(await api.patchTask(task.id, { watcher: WATCHER, title: "Observe harder" }, human, T1)).task)
      .toMatchObject({ watcher: WATCHER, title: "Observe harder" });
  });

  it("refuses `watcher: null` on the field patch, by name", async () => {
    const task = await makeTask();
    const result = await api.patchTask(task.id, { watcher: null }, human, T1);
    expect(code(result)).toBe("WATCHER_IMMUTABLE");
    expect((result as { error: { hint: string } }).error.hint).toContain("hand-off is not a thing today");
    expect((await store.getObject(undefined, task.id))!.watcher).toBe(WATCHER);
  });

  // The whole-file replace is a watcher surface too: the file IS the object, so
  // an absent key would drop the watcher and a changed one would hand the task
  // on without ever touching the patch path.
  it("refuses a whole-file replace that drops the watcher line", async () => {
    const task = await makeTask();
    expect(code(await api.replaceFromArtifact("task", task.id, "---\ntitle: Observe the impact of PR #201\n---\n\nbody\n", human, T1))).toBe("WATCHER_IMMUTABLE");
    expect((await store.getObject(undefined, task.id))!.watcher).toBe(WATCHER);
  });

  it("refuses a whole-file replace that points the watcher at another loop", async () => {
    const task = await makeTask();
    const result = await api.replaceFromArtifact("task", task.id, "---\ntitle: Observe\nwatcher: loop-steward\n---\n\nbody\n", human, T1);
    expect(code(result)).toBe("WATCHER_IMMUTABLE");
    expect((result as { error: { hint: string } }).error.hint).toContain("hand-off is not a thing today");
    expect((await store.getObject(undefined, task.id))!.watcher).toBe(WATCHER);
  });

  it("accepts the same replace when the file keeps it", async () => {
    const task = await makeTask();
    expect(ok(await api.replaceFromArtifact("task", task.id, `---\ntitle: Observe harder\nwatcher: ${WATCHER}\n---\n\nbody\n`, human, T1)).changed).toBe(true);
  });

  it("has no unwatched list filter left to ask for", async () => {
    expect(code(await api.listTasks(human, new URLSearchParams({ watcher: "none" }), T1))).toBe("SCHEMA_VIOLATION");
  });
});

// ------------------------------------------------------- the human-only seams

describe("the human-only question guard is covered at both altitudes", () => {
  it("refuses a run clearing a question at the PATCH surface (NB-1), and again in the kernel", async () => {
    const loop = await makeLoop();
    const task = await makeTask({ pendingQuestion: "Post this reply?", watcher: loop.id }, loop.id);
    // Layer 1: the HTTP field surface.
    expect(code(await api.patchTask(task.id, { needsHuman: null }, agentIn(loop.id), T1))).toBe("NOT_HUMAN");
    expect(code(await api.patchTask(task.id, { needsHuman: "a different question" }, agentIn(loop.id), T1))).toBe("NOT_HUMAN");
    // Layer 2: the whole-file replacement path, where dropping the key is the clear.
    expect(code(await api.replaceFromArtifact("task", task.id, "---\ntitle: Observe\n---\n\nbody\n", agentIn(loop.id), T1))).toBe("NOT_HUMAN");
    // Layer 3: the kernel itself, reached with no HTTP seam in front of it.
    const direct = await kernel.applyUpdate({ objectId: task.id, actor: { entrance: "agent", actorId: "run-exec" }, now: T1.toISOString(), fields: { pendingQuestion: null } });
    expect(!direct.ok && direct.code).toBe("NOT_HUMAN");
    expect((await store.getObject(undefined, task.id))!.pendingQuestion).toBe("Post this reply?");
  });

  it("lets a run ATTACH a question to a task that has none", async () => {
    const loop = await makeLoop();
    const task = await makeTask({ watcher: loop.id }, loop.id);
    const patched = ok(await api.patchTask(task.id, { needsHuman: "revert or wait?" }, agentIn(loop.id), T1));
    expect(patched).toMatchObject({ changed: true });
    expect((patched.task as { pendingQuestion: string }).pendingQuestion).toBe("revert or wait?");
  });

  it("treats a human's PATCH clear as a WITHDRAWAL — no answer, no wake", async () => {
    const loop = await makeLoop();
    const task = await makeTask({ pendingQuestion: "Post this reply?", watcher: loop.id }, loop.id);
    expect(ok(await api.patchTask(task.id, { needsHuman: null }, human, T1))).toMatchObject({ changed: true });
    const kinds = (await store.listObjectEvents(undefined, task.id)).map((e) => e.kind);
    expect(kinds).toContain("question-withdrawn");
    expect(await database.db.select().from(legacySchema.runs)).toHaveLength(0);
  });

  it("refuses the inbox and the verdict to any request carrying run context", async () => {
    const loop = await makeLoop();
    const task = await makeTask({ pendingQuestion: "Post this?", watcher: loop.id }, loop.id);
    expect(code(await api.verdict(task.id, "yes", agentIn(loop.id), T1))).toBe("NOT_HUMAN");
  });
});

// ------------------------------------------------------------------- verdict

describe("verdict joins the queue rather than stacking or refusing", () => {
  it("reports the run already queued for the watcher, and still records the answer", async () => {
    const loop = await makeLoop();
    // A production run is already pending for this loop.
    const preexisting = await database.db.transaction(async (tx) => queue.queueKernelRun(tx as never, { loop, now: T0, reason: "manual" }));
    const task = await makeTask({ pendingQuestion: "Post this reply?", watcher: loop.id }, loop.id);
    const result = ok(await api.verdict(task.id, "approved — post it", human, T1));
    expect((result.run as { id: string; alreadyQueued: boolean })).toMatchObject({ id: preexisting.run!.id, alreadyQueued: true });
    expect((result.task as { pendingQuestion: null }).pendingQuestion).toBeNull();
    // One queued run per loop: joined, not stacked.
    expect(await database.db.select().from(legacySchema.runs)).toHaveLength(1);
  });

  it("records the answer and wakes nothing when the task has no watcher", async () => {
    const task = await makeTask({ pendingQuestion: "Drop it?" });
    const result = ok(await api.verdict(task.id, "drop it, reverted upstream", human, T1));
    expect(result.run).toBeNull();
    expect(await database.db.select().from(legacySchema.runs)).toHaveLength(0);
    const answered = (await store.listObjectEvents(undefined, task.id)).filter((e) => e.kind === "question-answered");
    expect(answered[0]).toMatchObject({ entrance: "human", note: "drop it, reverted upstream" });
  });

  it("refuses a verdict on a closed task and on one with nothing pending", async () => {
    const open = await makeTask({});
    expect(code(await api.verdict(open.id, "looks fine", human, T1))).toBe("NO_OPEN_QUESTION");
    const closed = await makeTask({});
    await api.closeTask(closed.id, "done", human, T1);
    expect(code(await api.verdict(closed.id, "looks fine", human, T1))).toBe("CLOSED");
  });
});

// --------------------------------------------------------------------- close

describe("close is attested and idempotent", () => {
  it("refuses while a question waits, and names the question verbatim", async () => {
    const task = await makeTask({ pendingQuestion: "Post this reply?" });
    const refused = await api.closeTask(task.id, "posted it", human, T1);
    expect(code(refused)).toBe("OPEN_QUESTION");
    expect(!refused.ok && refused.error.issues[0]).toMatchObject({ path: "pendingQuestion", got: "Post this reply?" });
  });

  it("requires a non-empty note — the close event's whole attestation", async () => {
    const task = await makeTask({});
    expect(code(await api.closeTask(task.id, "  ", human, T1))).toBe("INVALID_BODY");
  });

  it("makes a second close a no-op that SAYS the new note was not recorded", async () => {
    const task = await makeTask({});
    ok(await api.closeTask(task.id, "verified on day 2", human, T1));
    const again = ok(await api.closeTask(task.id, "closing again", human, T1));
    expect(again).toMatchObject({ changed: false, event: null, contentDiffers: true, differingFields: ["note"] });
    expect((again.notice as { code: string }).code).toBe("CLOSE_NOTE_DIFFERS");
    const closes = (await store.listObjectEvents(undefined, task.id)).filter((e) => e.kind === "task-closed");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.note).toBe("verified on day 2");
  });

  it("refuses a DOC id — closing is a task move and nothing else has one", async () => {
    const doc = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: human.actor, now: T0, title: "Report" });
    if (!doc.ok) throw new Error(doc.message);
    expect(code(await api.closeTask(doc.object.id, "done", human, T1))).toBe("WRONG_KIND");
  });
});

// -------------------------------------------------------------- update guards

describe("update guards", () => {
  it("refuses an unknown JSON patch key with the allowed set", async () => {
    const task = await makeTask({});
    const refused = await api.patchTask(task.id, { priority: "high" }, human, T1);
    expect(code(refused)).toBe("UNKNOWN_KEY");
    expect(!refused.ok && refused.error.hint).toContain("payloadMerge");
  });

  it("refuses a bad date in both the flag form and the file form", async () => {
    const task = await makeTask({});
    expect(code(await api.patchTask(task.id, { followUp: "next tuesday" }, human, T1))).toBe("BAD_DATE");
    expect(code(await api.replaceFromArtifact("task", task.id, "---\nfollow_up: 2026-08-06\n---\n\nbody\n", human, T1))).toBe("BAD_DATE");
  });

  it("merges payload shallowly and deletes a key set to null", async () => {
    const task = await makeTask({ payload: { pr: 201, draft: "old" } });
    const patched = ok(await api.patchTask(task.id, { payloadMerge: { mergedAt: "2026-08-02", draft: null } }, human, T1));
    expect((patched.task as { payload: Record<string, unknown> }).payload).toEqual({ pr: 201, mergedAt: "2026-08-02" });
  });

  it("refuses a closed task — closed is terminal and there is no reopen", async () => {
    const task = await makeTask({});
    ok(await api.closeTask(task.id, "done", human, T1));
    expect(code(await api.patchTask(task.id, { followUp: "+3d" }, human, T1))).toBe("CLOSED");
  });

  it("refuses a key change on the file path and accepts an identical one", async () => {
    const task = await makeTask({ key: "pr-201-impact" });
    expect(code(await api.replaceFromArtifact("task", task.id, `---\nkey: pr-202-impact\nwatcher: ${WATCHER}\n---\n\nbody\n`, human, T1))).toBe("IMMUTABLE_KEY");
    expect(ok(await api.replaceFromArtifact("task", task.id, `---\nkey: pr-201-impact\ntitle: Observe the impact of PR #201\nwatcher: ${WATCHER}\n---\n\nbody\n`, human, T1)).changed).toBe(true);
  });

  it("writes no event for an empty diff — a no-op is not a fact", async () => {
    const task = await makeTask({ title: "Observe" });
    const before = (await store.listObjectEvents(undefined, task.id)).length;
    expect(ok(await api.patchTask(task.id, { title: "Observe" }, human, T1))).toMatchObject({ changed: false, event: null });
    expect((await store.listObjectEvents(undefined, task.id)).length).toBe(before);
  });

  it("refuses the wrong kind for the verb", async () => {
    const doc = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: human.actor, now: T0, title: "Report" });
    if (!doc.ok) throw new Error(doc.message);
    expect(code(await api.patchTask(doc.object.id, { title: "x" }, human, T1))).toBe("WRONG_KIND");
    expect(code(await api.showObject("task", doc.object.id, human))).toBe("WRONG_KIND");
    expect(code(await api.showObject("task", "task-000000", human))).toBe("NOT_FOUND");
  });
});

describe("run-now is the manual fire, and it obeys the queue discipline", () => {
  it("queues one run for an active loop and reports the second as already queued", async () => {
    const loop = await makeLoop();
    const first = ok(await api.runLoopNow(loop.id, human, T1));
    expect(first).toMatchObject({ queued: true, alreadyQueued: false });
    expect((first.run as { state: string }).state).toBe("queued");
    const second = ok(await api.runLoopNow(loop.id, human, T1));
    expect(second).toMatchObject({ queued: false, alreadyQueued: true });
    const history = await store.listObjectEvents(undefined, loop.id);
    expect(history.filter((e) => e.kind === "run-queued")).toHaveLength(1);
    expect(history.at(-1)).toMatchObject({ kind: "run-queued", entrance: "human", actorId: "u-owner" });
  });

  it("is the owner's act — a run proposes it instead", async () => {
    const loop = await makeLoop();
    expect(code(await api.runLoopNow(loop.id, agentIn(loop.id), T1))).toBe("NOT_HUMAN");
  });

  /**
   * PAUSE GOVERNS THE CADENCE, NOT THE BUTTON (captain ruling 2026-08-04).
   *
   * A paused production loop has `enabled=false`, so the clock cannot select it.
   * A manual fire is an explicit human act rather than the clock, and accepting
   * it must not quietly restore the cadence. Firing is one run, then quiet again.
   */
  it("fires a PAUSED loop, and firing does not resume it", async () => {
    const loop = await makeLoop("Housekeeper", false);
    const before = await prodStore.getLoop(loop.id);
    expect(before).toMatchObject({ enabled: false, nextRunAt: null });

    const fired = ok(await api.runLoopNow(loop.id, human, T1));
    expect(fired).toMatchObject({ queued: true, alreadyQueued: false });
    expect((fired.run as { reason: string }).reason).toBe("manual");

    // The cadence stayed off: same status, still disarmed.
    const after = await prodStore.getLoop(loop.id);
    expect(after).toMatchObject({ enabled: false, nextRunAt: null });
    // …and no lifecycle event rode along with the fire.
    const history = await store.listObjectEvents(undefined, loop.id);
    expect(history.map((e) => e.kind)).not.toContain("loop-resumed");
    expect(history.at(-1)).toMatchObject({ kind: "run-queued", entrance: "human" });
  });

  it("still obeys the one-queued-run discipline on a paused loop", async () => {
    const loop = await makeLoop("Housekeeper", false);
    ok(await api.runLoopNow(loop.id, human, T1));
    expect(ok(await api.runLoopNow(loop.id, human, T1))).toMatchObject({ queued: false, alreadyQueued: true });
  });

  it("refuses an id that names no production loop, and queues nothing", async () => {
    const refused = await api.runLoopNow("loop-neverexisted", human, T1);
    expect(code(refused)).toBe("NOT_FOUND");
    expect(await database.db.select().from(legacySchema.runs)).toHaveLength(0);
  });
});

// --------------------------------------------------------------------- inbox

describe("the inbox union is the safety floor", () => {
  /**
   * ONE BRANCH. The floor used to have three; the other two were both
   * `watcher IS NULL` predicates, and the watcher rule removed that state — so
   * the near misses to pin are the tasks those arms USED to catch: an old task
   * with no follow-up (the former orphan floor) and a due one (the former
   * due-unwatched arm). Both are now somebody's work, and neither reaches a
   * person.
   */
  it("returns the questions, and nothing a retired arm used to catch", async () => {
    const loop = await makeLoop();
    const question = await makeTask({ pendingQuestion: "revert or wait?", watcher: loop.id, createdAt: T0 }, loop.id);
    const due = await makeTask({ followUpAt: "2026-08-03T00:30:00.000Z" }, loop.id);
    const old = await makeTask({}, loop.id);
    await database.db.update(schema.objects).set({ createdAt: "2026-07-30T00:00:00.000Z" }).where(eq(schema.objects.id, old.id));
    const quiet = await makeTask({ watcher: loop.id }, loop.id);

    const result = ok(await api.inbox(human, T1));
    const items = result.items as { task: { id: string }; reasons: string[]; askedAt: string | null }[];
    const ids_ = items.map((i) => i.task.id);
    expect(ids_).toEqual([question.id]);
    for (const below of [due, old, quiet]) expect(ids_).not.toContain(below.id);
    expect(items[0]!.reasons).toEqual(["question"]);
    expect(items[0]!.askedAt).not.toBeNull();
    expect(result.counts).toEqual({ question: 1, total: 1 });
    expect(result.now).toBe(T1.toISOString());
  });

  it("counts no retired branch — the two watcher-less arms are gone, not zeroed", () => {
    expect(Object.keys(api.inboxCounts([]))).toEqual(["question", "total"]);
  });

  it("drops a task out of the floor the moment it is closed", async () => {
    const task = await makeTask({ pendingQuestion: "revert or wait?" });
    await api.verdict(task.id, "wait", human, T1);
    await api.closeTask(task.id, "waited, all fine", human, T1);
    expect((ok(await api.inbox(human, T1)).counts as { total: number }).total).toBe(0);
  });
});

// ---------------------------------------------------------------------- list

describe("task list", () => {
  it("refuses an unknown filter and a malformed loop id rather than ignoring them", async () => {
    expect(code(await api.listTasks(human, new URLSearchParams("mine=true")))).toBe("UNKNOWN_FILTER");
    expect(code(await api.listTasks(human, new URLSearchParams("watcher=self")))).toBe("SCHEMA_VIOLATION");
    expect(code(await api.listTasks(human, new URLSearchParams("since=two+weeks")))).toBe("BAD_DATE");
    expect(code(await api.listTasks(human, new URLSearchParams("limit=500")))).toBe("UNKNOWN_FILTER");
  });

  it("excludes loops structurally and defaults to open", async () => {
    const loop = await makeLoop();
    const open = await makeTask({ watcher: loop.id }, loop.id);
    const closed = await makeTask({});
    await api.closeTask(closed.id, "done", human, T1);
    const listed = ok(await api.listTasks(human, new URLSearchParams(), T1));
    expect((listed.tasks as { id: string }[]).map((t) => t.id)).toEqual([open.id]);
    expect(listed.total).toBe(1);
    const closedOnly = ok(await api.listTasks(human, new URLSearchParams("status=closed"), T1));
    expect((closedOnly.tasks as { id: string }[]).map((t) => t.id)).toEqual([closed.id]);
    const byWatcher = ok(await api.listTasks(human, new URLSearchParams(`watcher=${loop.id}`), T1));
    expect((byWatcher.tasks as { id: string }[]).map((t) => t.id)).toEqual([open.id]);
    const byCreator = ok(await api.listTasks(human, new URLSearchParams(`creator=${loop.id}`), T1));
    expect((byCreator.tasks as { id: string }[]).map((t) => t.id)).toEqual([open.id]);
    // List rows never carry a body or a payload — that is what show is for.
    expect(Object.keys((listed.tasks as Record<string, unknown>[])[0]!)).not.toContain("body");
  });

  it("reports the total rather than clipping silently when a page overflows", async () => {
    for (let i = 0; i < 3; i++) await makeTask({ title: `t${i}` });
    const page = ok(await api.listTasks(human, new URLSearchParams("limit=2"), T1));
    expect(page).toMatchObject({ truncated: true, total: 3 });
    expect((page.tasks as unknown[]).length).toBe(2);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("verdict transaction", () => {
  it("double-submit records one answer and queues exactly one express run", async () => {
    const loop = await makeLoop();
    const created = await kernel.createObject({ teamId: TEAM, kind: "task", actor: { entrance: "agent", actorId: "run-proposer" }, now: T0, title: "Proposal", pendingQuestion: "Ship it?", watcher: loop.id, createdByLoop: loop.id });
    if (!created.ok) throw new Error(created.message);
    const first = await api.verdict(created.object.id, "yes", human, T1);
    const second = await api.verdict(created.object.id, "yes", human, T1);
    expect(first.ok).toBe(true); expect(!second.ok && second.error.code).toBe("NO_OPEN_QUESTION");
    const runRows = await database.db.select().from(legacySchema.runs);
    expect(runRows).toHaveLength(1); expect(runRows[0]).toMatchObject({ loopId: loop.id, phase: "pending", scope: `task:${created.object.id}`, reason: "answered" });
    const answerEvents = (await store.listObjectEvents(undefined, created.object.id)).filter((event) => event.kind === "question-answered");
    expect(answerEvents).toHaveLength(1); expect(answerEvents[0]!.note).toBe("yes");
  });
});
