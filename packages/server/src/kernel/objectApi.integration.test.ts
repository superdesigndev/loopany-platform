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

const TEAM = "team-api";
const T0 = "2026-08-03T00:00:00.000Z";
const T1 = new Date("2026-08-03T01:00:00.000Z");
const human = { teamId: TEAM, actor: { entrance: "human", actorId: "u-owner" }, mode: "human" } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-object-api-"));
  process.env.LOOPANY_DATA_DIR = temp; process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js"); await database.runMigrations();
  schema = await import("../db/kernel-schema.js"); legacySchema = await import("../db/schema.js");
  kernel = await import("./applyTransition.js"); store = await import("../db/kernelStore.js"); api = await import("./objectApi.js"); ids = await import("./ids.js"); queue = await import("./runQueue.js");
});
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(async () => { await database.db.delete(schema.events); await database.db.delete(schema.objects); await database.db.delete(legacySchema.runs); });

async function makeLoop(title = "Housekeeper") {
  const result = await kernel.createObject({ teamId: TEAM, kind: "loop", actor: human.actor, now: T0, title, cron: "0 7 * * *", body: "charter" });
  if (!result.ok) throw new Error(result.message); return result.object;
}

/** An agent context: a device credential PLUS run context, which is what makes a
 *  request an agent's (spec §2.1). The run row is only read for id/loopId here. */
function agentIn(loopId: string, runId = "run-exec"): never {
  return { teamId: TEAM, actor: { entrance: "agent", actorId: runId }, mode: "agent", run: { id: runId, loopId } } as never;
}

async function makeTask(fields: Record<string, unknown> = {}, loopId?: string) {
  const result = await kernel.createObject({
    teamId: TEAM, kind: "task", actor: loopId ? { entrance: "agent", actorId: "run-proposer" } : human.actor, now: T0,
    title: "Observe the impact of PR #201", ...(loopId ? { createdByLoop: loopId } : {}), ...fields,
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
  const file = (title: string, body: string) => `---\ntitle: ${title}\nkey: pr-201-impact\n---\n\n${body}\n`;

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
    expect(code(await api.createFromArtifact("task", "---\ntitle: A task\nkey: shared-key\n---\n\nbody\n", human, T1))).toBe("KEY_KIND_MISMATCH");
  });

  it("stamps provenance from the invisible run context, never from the wire", async () => {
    const loop = await makeLoop();
    const created = ok(await api.createFromArtifact("task", "---\ntitle: From a run\n---\n\nbody\n", agentIn(loop.id), T1));
    expect(created.task).toMatchObject({ createdByRun: "run-exec", createdByLoop: loop.id, watcher: null, status: "open" });
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
    // A clock fire already queued a routine run for this loop.
    const preexisting = await database.db.transaction(async (tx) => queue.queueKernelRun(tx as never, { loop, now: T0, reason: "clock", scheduledFor: T0 }));
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

  it("refuses a loop id — a loop is paused or retired, never closed", async () => {
    const loop = await makeLoop();
    expect(code(await api.closeTask(loop.id, "done", human, T1))).toBe("WRONG_KIND");
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
    expect(code(await api.replaceFromArtifact("task", task.id, "---\nkey: pr-202-impact\n---\n\nbody\n", human, T1))).toBe("IMMUTABLE_KEY");
    expect(ok(await api.replaceFromArtifact("task", task.id, "---\nkey: pr-201-impact\ntitle: Observe the impact of PR #201\n---\n\nbody\n", human, T1)).changed).toBe(true);
  });

  it("writes no event for an empty diff — a no-op is not a fact", async () => {
    const task = await makeTask({ title: "Observe" });
    const before = (await store.listObjectEvents(undefined, task.id)).length;
    expect(ok(await api.patchTask(task.id, { title: "Observe" }, human, T1))).toMatchObject({ changed: false, event: null });
    expect((await store.listObjectEvents(undefined, task.id)).length).toBe(before);
  });

  it("refuses the wrong kind for the verb", async () => {
    const loop = await makeLoop();
    expect(code(await api.patchTask(loop.id, { title: "x" }, human, T1))).toBe("WRONG_KIND");
    expect(code(await api.showObject("task", loop.id, human))).toBe("WRONG_KIND");
    expect(code(await api.showObject("task", "task-000000", human))).toBe("NOT_FOUND");
  });
});

// --------------------------------------------------------------- loop evolve

describe("loop evolve is the free zone, bounded by ownership and by cadence", () => {
  const charter = (body: string, cron = "0 7 * * *") => `---\ntitle: Housekeeper\ncron: "${cron}"\n---\n\n${body}\n`;

  it("writes the body and refuses another loop's charter by name", async () => {
    const mine = await makeLoop(); const theirs = await makeLoop("Reddit Outreach");
    const evolved = ok(await api.replaceFromArtifact("loop", mine.id, charter("You are the Housekeeper.\n\n## Lessons\n- lead with the problem"), agentIn(mine.id), T1, "charter-evolved"));
    expect(evolved.changed).toBe(true);
    expect((evolved.loop as { body: string }).body).toContain("## Lessons");
    const refused = await api.replaceFromArtifact("loop", theirs.id, charter("mine now"), agentIn(mine.id), T1, "charter-evolved");
    expect(code(refused)).toBe("NOT_YOUR_LOOP");
    expect(!refused.ok && refused.error.issues[0]).toMatchObject({ got: theirs.id, expected: mine.id });
  });

  it("accepts an unchanged cron (the round trip) and refuses a changed one as governance", async () => {
    const loop = await makeLoop();
    expect(ok(await api.replaceFromArtifact("loop", loop.id, charter("new body"), agentIn(loop.id), T1, "charter-evolved")).changed).toBe(true);
    expect(code(await api.replaceFromArtifact("loop", loop.id, charter("new body", "0 * * * *"), agentIn(loop.id), T1, "charter-evolved"))).toBe("APPROVAL_REQUIRED");
  });

  it("refuses a changed workdir as governance, exactly like a changed cron", async () => {
    // WHERE a loop executes is as consequential as WHEN: moving the bound
    // directory moves every future run's blast radius (captain ruling 2026-08-04).
    const loop = await makeLoop();
    const bound = (dir: string) => `---\ntitle: Housekeeper\ncron: "0 7 * * *"\nworkdir: ${dir}\n---\n\ncharter\n`;
    const refused = await api.replaceFromArtifact("loop", loop.id, bound("/Users/me/elsewhere"), agentIn(loop.id), T1, "charter-evolved");
    expect(code(refused)).toBe("APPROVAL_REQUIRED");
    expect(!refused.ok && refused.error.issues[0]).toMatchObject({ path: "workdir" });
    expect(!refused.ok && refused.error.hint).toContain(`POST /api/loops/${loop.id}`);
  });

  it("freezes a retired loop's charter", async () => {
    const loop = await makeLoop();
    const retired = await kernel.applyTransition({ objectId: loop.id, transition: "retire", actor: human.actor, now: T1.toISOString() });
    expect(retired.ok).toBe(true);
    expect(code(await api.replaceFromArtifact("loop", loop.id, charter("still mine"), agentIn(loop.id), T1, "charter-evolved"))).toBe("RETIRED");
  });
});

// ------------------------------------------------------------ loop CRUD (u6)

describe("loop create is a human entrance, armed at birth", () => {
  const file = (body: string, head = 'cron: "0 7 * * *"\nkey: housekeeper') => `---\ntitle: Housekeeper\n${head}\n---\n\n${body}\n`;

  it("creates the loop through the kernel, armed, with human provenance on its event", async () => {
    const created = ok(await api.createFromArtifact("loop", file("You are the Housekeeper."), human, T1));
    expect(created.created).toBe(true);
    const loop = created.loop as Record<string, unknown>;
    expect(loop).toMatchObject({ kind: "loop", status: "active", cron: "0 7 * * *", key: "housekeeper" });
    // Armed at birth: the cursor is what makes a cadence live, so a created loop
    // with a cron must already carry one, strictly in the future.
    expect(typeof loop.nextFire).toBe("string");
    expect(Date.parse(loop.nextFire as string)).toBeGreaterThan(T1.getTime());
    const history = await store.listObjectEvents(undefined, loop.id as string);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: "object-created", entrance: "human", actorId: "u-owner" });
  });

  it("binds the loop to a workdir the claim then hands the machine", async () => {
    const created = ok(await api.createFromArtifact("loop", `---\ntitle: Housekeeper (local)\ncron: "0 7 * * *"\nkey: hk-local\nworkdir: /Users/me/Workspace/repo\n---\n\ncharter\n`, human, T1));
    expect(created.loop).toMatchObject({ workdir: "/Users/me/Workspace/repo" });
    // Re-creating the SAME file is an idempotent replay, not a spurious diff.
    const replay = ok(await api.createFromArtifact("loop", `---\ntitle: Housekeeper (local)\ncron: "0 7 * * *"\nkey: hk-local\nworkdir: /Users/me/Workspace/repo\n---\n\ncharter\n`, human, T1));
    expect(replay).toMatchObject({ created: false, contentDiffers: false });
    // A DIFFERENT binding under the same key is reported, never silently applied.
    const moved = ok(await api.createFromArtifact("loop", `---\ntitle: Housekeeper (local)\ncron: "0 7 * * *"\nkey: hk-local\nworkdir: /Users/me/Workspace/other\n---\n\ncharter\n`, human, T1));
    expect(moved.differingFields).toContain("workdir");
  });

  it("creates an unarmed loop when the file carries no cadence", async () => {
    const created = ok(await api.createFromArtifact("loop", file("On demand only.", "key: adhoc"), human, T1));
    expect(created.loop).toMatchObject({ status: "active", cron: null, nextFire: null });
  });

  it("refuses a run — creating a loop is governance, and the refusal names the proposal path", async () => {
    const mine = await makeLoop();
    const refused = await api.createFromArtifact("loop", file("mine now", "key: sneaky"), agentIn(mine.id), T1);
    expect(code(refused)).toBe("NOT_HUMAN");
    expect(!refused.ok && refused.error.hint).toContain("--needs-human");
    expect(ok(await api.listLoops(human, new URLSearchParams())).loops).toHaveLength(1);
  });

  it("refuses an unreadable cron with teaching, and writes nothing", async () => {
    const refused = await api.createFromArtifact("loop", file("hourly-ish", 'cron: "every hour"\nkey: bad'), human, T1);
    expect(code(refused)).toBe("BAD_CRON");
    expect(!refused.ok && refused.error.issues[0]).toMatchObject({ path: "cron", got: "every hour" });
    expect(ok(await api.listLoops(human, new URLSearchParams())).loops).toHaveLength(0);
  });

  it("is idempotent by key and never silently applies the differing file", async () => {
    const first = ok(await api.createFromArtifact("loop", file("v1"), human, T1));
    const again = ok(await api.createFromArtifact("loop", file("v2"), human, T1));
    expect(again.created).toBe(false);
    expect((again.loop as { id: string }).id).toBe((first.loop as { id: string }).id);
    expect(again.contentDiffers).toBe(true);
    expect(again.differingFields).toContain("body");
  });

  it("round-trips its own `loop show --file` bytes back through create with nothing differing", async () => {
    const created = ok(await api.createFromArtifact("loop", file("You are the Housekeeper."), human, T1));
    const row = (await store.getObject(undefined, (created.loop as { id: string }).id))!;
    // The default loop carries NO payload, and the serializer must therefore emit
    // no `payload:` key: `payload: {}` re-parses to an empty mapping, which reads
    // as different from a null payload and reported a spurious `differs: payload`
    // on exactly the flow the help text teaches (review F1).
    expect(row.payload).toBeNull();
    const artifact = api.objectArtifact(row);
    expect(artifact).not.toContain("payload:");
    const replay = ok(await api.createFromArtifact("loop", artifact, human, T1));
    expect(replay.created).toBe(false);
    expect(replay.contentDiffers).toBe(false);
    expect(replay.differingFields).toEqual([]);
    expect(replay.notice).toBeUndefined();
  });

  it("names a route that exists when a keyed replay differs — never the unbuilt loop PATCH", async () => {
    ok(await api.createFromArtifact("loop", file("v1"), human, T1));
    const again = ok(await api.createFromArtifact("loop", file("v2"), human, T1));
    const hint = (again.notice as { hint: string }).hint;
    expect(hint).not.toContain("PATCH");
    expect(hint).toContain("/evolve");
    expect(hint).toContain("loop page");
  });
});

describe("loop list and loop show are the read half", () => {
  it("returns the whole roster by default and filters by status", async () => {
    const active = await makeLoop("Housekeeper");
    const retired = await makeLoop("Reddit Outreach");
    await kernel.applyTransition({ objectId: retired.id, transition: "retire", actor: human.actor, now: T1.toISOString() });
    expect(ok(await api.listLoops(human, new URLSearchParams())).loops).toHaveLength(2);
    const live = ok(await api.listLoops(human, new URLSearchParams("status=active"))).loops as { id: string }[];
    expect(live.map((l) => l.id)).toEqual([active.id]);
    const gone = ok(await api.listLoops(human, new URLSearchParams("status=retired"))).loops as { id: string }[];
    expect(gone.map((l) => l.id)).toEqual([retired.id]);
  });

  it("refuses a status a loop cannot hold, and an unknown filter, by name", async () => {
    const badStatus = await api.listLoops(human, new URLSearchParams("status=closed"));
    expect(code(badStatus)).toBe("UNKNOWN_FILTER");
    expect(!badStatus.ok && badStatus.error.issues[0]).toMatchObject({ got: "closed", expected: "active|paused|retired" });
    expect(code(await api.listLoops(human, new URLSearchParams("watcher=loop-x")))).toBe("UNKNOWN_FILTER");
  });

  it("is a team-scoped read an agent may make", async () => {
    const loop = await makeLoop();
    const seen = ok(await api.listLoops(agentIn(loop.id), new URLSearchParams()));
    expect((seen.loops as { id: string }[]).map((l) => l.id)).toEqual([loop.id]);
    expect(seen.viewerLoop).toBe(loop.id);
  });

  it("shows the loop with its seq-ordered event timeline", async () => {
    const loop = await makeLoop();
    await api.loopLifecycle(loop.id, "pause", { note: "muted for the migration" }, human, T1);
    const shown = ok(await api.showObject("loop", loop.id, human));
    expect(shown.loop).toMatchObject({ id: loop.id, status: "paused", cron: "0 7 * * *" });
    const timeline = shown.events as { seq: number; kind: string }[];
    expect(timeline.map((e) => e.kind)).toEqual(["object-created", "loop-paused"]);
    expect(timeline[1]!.seq).toBeGreaterThan(timeline[0]!.seq);
  });
});

describe("the loop lifecycle is the owner's, idempotent, and terminal at retire", () => {
  it("pauses by disarming the cursor, and a repeat is a success that changed nothing", async () => {
    const loop = await makeLoop();
    expect(loop.nextFire).not.toBeNull();
    const paused = ok(await api.loopLifecycle(loop.id, "pause", { note: "muted" }, human, T1));
    expect(paused.changed).toBe(true);
    expect(paused.loop).toMatchObject({ status: "paused", nextFire: null });
    expect(paused.diff).toMatchObject({ status: { old: "active", new: "paused" } });
    const event = await store.getEvent(undefined, paused.event as string);
    expect(event).toMatchObject({ kind: "loop-paused", transition: "pause", entrance: "human", note: "muted" });
    const again = ok(await api.loopLifecycle(loop.id, "pause", undefined, human, T1));
    expect(again.changed).toBe(false);
    expect(again.event).toBeNull();
  });

  it("resumes by re-arming to the NEXT occurrence — a long pause owes one fire, not a backlog", async () => {
    const loop = await makeLoop();
    await api.loopLifecycle(loop.id, "pause", undefined, human, T1);
    const late = new Date("2026-08-19T02:00:00.000Z");
    const resumed = ok(await api.loopLifecycle(loop.id, "resume", undefined, human, late));
    expect(resumed.loop).toMatchObject({ status: "active" });
    const nextFire = (resumed.loop as { nextFire: string }).nextFire;
    expect(Date.parse(nextFire)).toBeGreaterThan(late.getTime());
    // One occurrence ahead, not sixteen days of catch-up.
    expect(Date.parse(nextFire) - late.getTime()).toBeLessThan(25 * 3_600_000);
  });

  it("retires terminally: the charter freezes, cadence is refused, and there is no way back", async () => {
    const loop = await makeLoop();
    const retired = ok(await api.loopLifecycle(loop.id, "retire", { note: "the experiment is over" }, human, T1));
    expect(retired.loop).toMatchObject({ status: "retired", nextFire: null });

    const charter = `---\ntitle: Housekeeper\ncron: "0 7 * * *"\n---\n\nstill mine\n`;
    expect(code(await api.replaceFromArtifact("loop", loop.id, charter, agentIn(loop.id), T1, "charter-evolved"))).toBe("RETIRED");
    expect(code(await api.governLoop(loop.id, { cron: "0 * * * *", approval: "ev-x" }, agentIn(loop.id), T1))).toBe("RETIRED");
    for (const verb of ["resume", "pause"] as const) {
      const refused = await api.loopLifecycle(loop.id, verb, undefined, human, T1);
      expect(code(refused), verb).toBe("RETIRED");
      expect(!refused.ok && refused.error.hint).toContain("no un-retire");
    }
    // Retire IS the delete, so the record survives it: still listed, still readable.
    expect(ok(await api.loopLifecycle(loop.id, "retire", undefined, human, T1)).changed).toBe(false);
    expect(ok(await api.listLoops(human, new URLSearchParams("status=retired"))).loops).toHaveLength(1);
    expect(ok(await api.showObject("loop", loop.id, human)).loop).toMatchObject({ id: loop.id, status: "retired" });
  });

  it("refuses a run — the lifecycle is not a loop's to drive, not even its own", async () => {
    const loop = await makeLoop();
    for (const verb of ["pause", "resume", "retire"] as const) {
      const refused = await api.loopLifecycle(loop.id, verb, undefined, agentIn(loop.id), T1);
      expect(code(refused), verb).toBe("NOT_HUMAN");
      expect(!refused.ok && refused.error.hint).toContain("--needs-human");
    }
    expect((await store.getObject(undefined, loop.id))!.status).toBe("active");
  });

  it("guards the optional body: only a note, and it must be text", async () => {
    const loop = await makeLoop();
    expect(code(await api.loopLifecycle(loop.id, "pause", { reason: "x" }, human, T1))).toBe("UNKNOWN_KEY");
    expect(code(await api.loopLifecycle(loop.id, "pause", { note: 7 }, human, T1))).toBe("SCHEMA_VIOLATION");
    expect(code(await api.loopLifecycle(loop.id, "pause", "just do it", human, T1))).toBe("INVALID_BODY");
    expect(code(await api.loopLifecycle("loop-000000", "pause", undefined, human, T1))).toBe("NOT_FOUND");
    const task = await makeTask();
    expect(code(await api.loopLifecycle(task.id, "pause", undefined, human, T1))).toBe("WRONG_KIND");
  });
});

// ----------------------------------------------------------- governance zone

describe("governance refuses before it authorizes", () => {
  it("requires an approval key and rejects an invalid cron", async () => {
    const loop = await makeLoop();
    expect(code(await api.governLoop(loop.id, { cron: "0 * * * *" }, agentIn(loop.id), T1))).toBe("APPROVAL_REQUIRED");
    expect(code(await api.governLoop(loop.id, { cron: "0 * * * *", approval: "ev-x", status: "paused" }, agentIn(loop.id), T1))).toBe("UNKNOWN_KEY");
    const task = await makeTask({}, loop.id);
    const approval = await store.appendEvent(undefined, { id: ids.organicEventId(T1.getTime()), teamId: TEAM, objectId: task.id, kind: "question-answered", origin: "organic", entrance: "human", actorId: "u-owner", note: "yes", ts: T1.toISOString() });
    expect(code(await api.governLoop(loop.id, { cron: "every hour", approval: approval.event.id }, agentIn(loop.id), T1))).toBe("BAD_CRON");
  });
});

describe("governance moves the bound directory under the same approval gate", () => {
  it("applies an approved workdir change and refuses a relative one", async () => {
    const loop = await makeLoop();
    const task = await makeTask({}, loop.id);
    const approval = await store.appendEvent(undefined, { id: ids.organicEventId(T1.getTime()), teamId: TEAM, objectId: task.id, kind: "question-answered", origin: "organic", entrance: "human", actorId: "u-owner", note: "yes", ts: T1.toISOString() });
    expect(code(await api.governLoop(loop.id, { workdir: "repo", approval: approval.event.id }, agentIn(loop.id), T1))).toBe("SCHEMA_VIOLATION");
    const moved = ok(await api.governLoop(loop.id, { workdir: "/Users/me/Workspace/repo", approval: approval.event.id }, agentIn(loop.id), T1));
    expect(moved.loop).toMatchObject({ workdir: "/Users/me/Workspace/repo", cron: "0 7 * * *" });
    // The cadence is untouched when only the directory moves.
    expect((moved.diff as Record<string, unknown>).cron).toBeUndefined();
  });

  it("still needs one of the two governed facets", async () => {
    const loop = await makeLoop();
    expect(code(await api.governLoop(loop.id, { approval: "ev-x" }, agentIn(loop.id), T1))).toBe("INVALID_BODY");
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

  it("refuses a paused loop and names the resume route", async () => {
    const loop = await makeLoop();
    expect((await kernel.applyTransition({ objectId: loop.id, transition: "pause", actor: human.actor, now: T1.toISOString() })).ok).toBe(true);
    const refused = await api.runLoopNow(loop.id, human, T1);
    expect(code(refused)).toBe("PAUSED");
    expect(!refused.ok && refused.error.hint).toContain(`POST /api/loops/${loop.id}/resume`);
  });
});

// --------------------------------------------------------------------- inbox

describe("the inbox union is the safety floor", () => {
  it("returns each task once with every matching reason, questions first", async () => {
    const loop = await makeLoop();
    const question = await makeTask({ pendingQuestion: "revert or wait?", watcher: loop.id, createdAt: T0 }, loop.id);
    const dueUnwatched = await makeTask({ followUpAt: "2026-08-03T00:30:00.000Z" });
    const orphan = await makeTask({});
    await database.db.update(schema.objects).set({ createdAt: "2026-07-30T00:00:00.000Z" }).where(eq(schema.objects.id, orphan.id));
    // Fresh, watched, not due: below every arm of the floor.
    const quiet = await makeTask({ watcher: loop.id }, loop.id);

    const result = ok(await api.inbox(human, T1));
    const items = result.items as { task: { id: string }; reasons: string[]; askedAt: string | null }[];
    const ids_ = items.map((i) => i.task.id);
    expect(ids_).toContain(question.id); expect(ids_).toContain(dueUnwatched.id); expect(ids_).toContain(orphan.id);
    expect(ids_).not.toContain(quiet.id);
    expect(items[0]!.reasons).toEqual(["question"]);
    expect(items[0]!.askedAt).not.toBeNull();
    expect(items.find((i) => i.task.id === dueUnwatched.id)!.reasons).toEqual(["due-unwatched"]);
    expect(items.find((i) => i.task.id === orphan.id)!.reasons).toEqual(["orphan"]);
    expect(result.counts).toMatchObject({ question: 1, dueUnwatched: 1, orphan: 1, total: 3 });
    expect(result.now).toBe(T1.toISOString());
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
    expect(runRows).toHaveLength(1); expect(runRows[0]).toMatchObject({ loopId: loop.id, queueState: "queued", scope: `task:${created.object.id}`, reason: "answered" });
    const answerEvents = (await store.listObjectEvents(undefined, created.object.id)).filter((event) => event.kind === "question-answered");
    expect(answerEvents).toHaveLength(1); expect(answerEvents[0]!.note).toBe("yes");
  });
});

describe("approval key checks", () => {
  it("checks ownership first, then event existence, human entrance, and task ownership", async () => {
    const loop = await makeLoop(); const other = await makeLoop("Other");
    const context = { teamId: TEAM, actor: { entrance: "agent", actorId: "run-exec" }, mode: "agent", run: { id: "run-exec", loopId: loop.id } } as never;
    const wrongOwner = await api.governLoop(other.id, { cron: "0 * * * *", approval: "ev-nope" }, context, T1);
    expect(!wrongOwner.ok && wrongOwner.error.code).toBe("NOT_YOUR_LOOP");
    const unknown = await api.governLoop(loop.id, { cron: "0 * * * *", approval: "ev-nope" }, context, T1);
    expect(!unknown.ok && unknown.error.code).toBe("APPROVAL_UNKNOWN");

    const foreignTask = await kernel.createObject({ teamId: TEAM, kind: "task", actor: { entrance: "agent", actorId: "run-other" }, now: T0, title: "Foreign", createdByLoop: other.id });
    if (!foreignTask.ok) throw new Error(foreignTask.message);
    const notHuman = await api.governLoop(loop.id, { cron: "0 * * * *", approval: foreignTask.event!.id }, context, T1);
    expect(!notHuman.ok && notHuman.error.code).toBe("APPROVAL_NOT_HUMAN");
    const foreignApproval = await store.appendEvent(undefined, { id: ids.organicEventId(T1.getTime()), teamId: TEAM, objectId: foreignTask.object.id, kind: "question-answered", origin: "organic", entrance: "human", actorId: "u-owner", note: "yes", ts: T1.toISOString() });
    const foreign = await api.governLoop(loop.id, { cron: "0 * * * *", approval: foreignApproval.event.id }, context, T1);
    expect(!foreign.ok && foreign.error.code).toBe("APPROVAL_FOREIGN");

    const ownTask = await kernel.createObject({ teamId: TEAM, kind: "task", actor: { entrance: "agent", actorId: "run-proposer" }, now: T0, title: "Own", createdByLoop: loop.id });
    if (!ownTask.ok) throw new Error(ownTask.message);
    const approval = await store.appendEvent(undefined, { id: ids.organicEventId(T1.getTime() + 1), teamId: TEAM, objectId: ownTask.object.id, kind: "question-answered", origin: "organic", entrance: "human", actorId: "u-owner", note: "yes", ts: T1.toISOString() });
    const valid = await api.governLoop(loop.id, { cron: "0 * * * *", approval: approval.event.id }, context, T1);
    expect(valid.ok).toBe(true); expect(valid.ok && (valid.value.approval as { event: string }).event).toBe(approval.event.id);
  });
});
