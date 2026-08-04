import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * THE DIRECTIVE — the human speaking to a watcher without being asked.
 *
 * The inbox is an AGENT-initiated conversation: a run asks, a person answers.
 * This is the other direction, and the tests below pin the four rulings that
 * make the two legible side by side:
 *
 *  1. it is its OWN run reason, so a run can tell an unasked-for instruction
 *     from a reply to its own question;
 *  2. a pending question refuses it — the person already has the floor;
 *  3. it obeys the transactional open-run join, reporting rather than stacking;
 *  4. the run CARRIES THE WORDS VERBATIM, which the claim body proves.
 *
 * The last one is the acceptance criterion that matters: an agent woken by a
 * person must be told what they said, not merely that something changed.
 */

let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/kernel-schema.js");
let legacySchema: typeof import("../db/schema.js");
let kernel: typeof import("./applyTransition.js");
let api: typeof import("./objectApi.js");
let queue: typeof import("./runQueue.js");
let ids: typeof import("./ids.js");

const TEAM = "team-directive";
const T0 = "2026-08-04T00:00:00.000Z";
const NOW = new Date("2026-08-04T01:00:00.000Z");
const human = { teamId: TEAM, actor: { entrance: "human", actorId: "u-owner" }, mode: "human" } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-directive-"));
  process.env.LOOPANY_DATA_DIR = temp; process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js"); await database.runMigrations();
  schema = await import("../db/kernel-schema.js"); legacySchema = await import("../db/schema.js");
  kernel = await import("./applyTransition.js"); api = await import("./objectApi.js");
  queue = await import("./runQueue.js"); ids = await import("./ids.js");
});
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(async () => { await database.db.delete(schema.events); await database.db.delete(schema.objects); await database.db.delete(legacySchema.runs); });

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "OK" : r.error!.code);

async function makeLoop(title = "Housekeeper") {
  const result = await kernel.createObject({ teamId: TEAM, kind: "loop", actor: human.actor, now: T0, title, cron: "0 7 * * *", body: "Sweep the repo." });
  if (!result.ok) throw new Error(result.message);
  return result.object;
}

async function makeTask(watcher: string, fields: Record<string, unknown> = {}) {
  const result = await kernel.createObject({ teamId: TEAM, kind: "task", actor: human.actor, now: T0, title: "Seed article bet", watcher, ...fields } as never);
  if (!result.ok) throw new Error(result.message);
  return result.object;
}

const TOLD = "Drop this bet — close the PR, delete the branch, then close the task.";

// ------------------------------------------------------------ the happy path

describe("a directive wakes the watcher, carrying what was said", () => {
  it("records a human event on the TASK and queues one run for its watcher", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id);
    const result = ok(await api.leaveDirective(task.id, TOLD, human, NOW));

    expect(result.directive).toBe(TOLD);
    const run = result.run as { id: string; reason: string; scope: string; entrance: string; alreadyQueued: boolean };
    expect(run).toMatchObject({ reason: "directive", scope: `task:${task.id}`, entrance: "human", alreadyQueued: false });

    const events = await database.db.select().from(schema.events).where(eq(schema.events.kind, "directive-left"));
    expect(events).toHaveLength(1);
    // On the TASK's timeline, entered by a HUMAN, with the words as the note —
    // so the directive is readable there whether or not a run was queued.
    expect(events[0]).toMatchObject({ objectId: task.id, entrance: "human", actorId: "u-owner", note: TOLD });
  });

  /** Its own reason, not a flavour of `answered`: the two conversations ask for
   *  different work, and a run that could not tell them apart would read an
   *  order as a reply to a question it never asked. */
  it("uses the directive run reason, distinct from answered", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id);
    const result = ok(await api.leaveDirective(task.id, TOLD, human, NOW));
    const row = (await database.db.select().from(legacySchema.runs).where(eq(legacySchema.runs.id, (result.run as { id: string }).id)))[0]!;
    expect(row.reason).toBe("directive");
    expect(row.queueState).toBe("queued");
    // The run's identity DERIVES from the directive event, so a retried
    // transaction queues one run rather than two.
    expect(row.id).toBe(ids.directiveRunId(result.event as string));
    expect(row.triggerEventId).toBe(result.event);
  });

  /**
   * THE ACCEPTANCE CRITERION. The claim body is the agent's work order, and the
   * person's words are in it VERBATIM — not summarized, not replaced by "a
   * directive was left", and labelled as a directive so it cannot be mistaken
   * for an answer.
   */
  it("puts the words verbatim into the claiming run's work order", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id);
    ok(await api.leaveDirective(task.id, TOLD, human, NOW));

    const machine = await enrolledMachine();
    const claim = await queue.claimRun(machine, { agent: "vitest" }, NOW);
    const body = claim.body as { run: { reason: string }; directive?: string; answer?: string; scopeNote: string; task?: { id: string } };
    expect(body.run.reason).toBe("directive");
    expect(body.directive).toBe(TOLD);
    expect(body.answer).toBeUndefined();
    expect(body.scopeNote).toContain("DIRECTIVE");
    // External reality first, kernel records last — the ordering rule the run
    // has to follow rides in the work order rather than only in the skill.
    expect(body.scopeNote).toMatch(/INTENT against reality/);
    expect(body.task?.id).toBe(task.id);
    // The daemon half — that this field reaches the agent's prompt verbatim —
    // is pinned in the DAEMON's own suite (`runs-v2.test.ts`). Importing its
    // source here would pull the whole package under this one's tsconfig.
  });

  it("does the same for an ANSWER, so the two never blur on the wire", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id, { pendingQuestion: "Revert or wait?" });
    ok(await api.verdict(task.id, "Wait one more day.", human, NOW));

    const machine = await enrolledMachine();
    const claim = await queue.claimRun(machine, { agent: "vitest" }, NOW);
    const body = claim.body as { answer?: string; directive?: string };
    expect(body.answer).toBe("Wait one more day.");
    expect(body.directive).toBeUndefined();
  });
});

// ------------------------------------------------------------ the guards

describe("the two conversations stay legible", () => {
  /** A person with a question open already HAS the floor and the wire for it,
   *  and the run this would queue could not clear the question anyway. */
  it("refuses a directive while a question is pending, and points at answer", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id, { pendingQuestion: "Revert or wait?" });
    const refused = await api.leaveDirective(task.id, TOLD, human, NOW);
    expect(code(refused)).toBe("OPEN_QUESTION");
    expect(refused.ok === false && refused.error.hint).toContain("loopany answer");
    expect(await database.db.select().from(legacySchema.runs)).toHaveLength(0);
  });

  it("refuses a closed task: a closed task is a record, and nothing wakes for it", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id);
    await kernel.applyTransition({ objectId: task.id, transition: "close", actor: human.actor, now: T0, note: "done" });
    expect(code(await api.leaveDirective(task.id, TOLD, human, NOW))).toBe("CLOSED");
  });

  it("refuses empty text, and refuses an agent outright", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id);
    expect(code(await api.leaveDirective(task.id, "   ", human, NOW))).toBe("INVALID_BODY");
    const agent = { teamId: TEAM, actor: { entrance: "agent", actorId: "run-1" }, mode: "agent", run: { id: "run-1", loopId: loop.id } } as never;
    expect(code(await api.leaveDirective(task.id, TOLD, agent, NOW))).toBe("NOT_HUMAN");
  });

  it("is enumeration-safe across teams", async () => {
    const foreign = await kernel.createObject({ teamId: "team-other", kind: "task", actor: human.actor, now: T0, title: "theirs", watcher: "loop-x" });
    if (!foreign.ok) throw new Error("fixture");
    expect(code(await api.leaveDirective(foreign.object.id, TOLD, human, NOW))).toBe("NOT_FOUND");
  });
});

// ------------------------------------------------------- the queue discipline

describe("it obeys the transactional open-run join rather than stacking", () => {
  it("reports the run already queued, and leaves the directive on the record", async () => {
    const loop = await makeLoop();
    const first = await makeTask(loop.id, { title: "first" });
    const second = await makeTask(loop.id, { title: "second" });
    ok(await api.leaveDirective(first.id, "Ship it.", human, NOW));
    const again = ok(await api.leaveDirective(second.id, TOLD, human, NOW));

    expect((again.run as { alreadyQueued: boolean }).alreadyQueued).toBe(true);
    expect(await database.db.select().from(legacySchema.runs)).toHaveLength(1);
    // The directive itself always lands, so the queued run reads it from the
    // task's timeline when it claims — nothing is lost by not stacking.
    expect(await database.db.select().from(schema.events).where(eq(schema.events.kind, "directive-left"))).toHaveLength(2);
  });

  it("is idempotent per directive: a replayed transaction derives the same run", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id);
    const result = ok(await api.leaveDirective(task.id, TOLD, human, NOW));
    const eventId = result.event as string;
    // Re-deriving with the SAME event id (what a retried transaction does)
    // resolves to the existing run, never a twin.
    const replay = await database.db.transaction(async (tx) =>
      queue.queueKernelRun(tx as never, { loop, now: NOW.toISOString(), reason: "directive", scope: `task:${task.id}`, triggerEventId: eventId }),
    );
    expect(replay.outcome).toBe("replay");
    expect(replay.run!.id).toBe(ids.directiveRunId(eventId));
  });

  it("says so when the watcher is retired, rather than queueing into silence", async () => {
    const loop = await makeLoop();
    const task = await makeTask(loop.id);
    await kernel.applyTransition({ objectId: loop.id, transition: "retire", actor: human.actor, now: T0 });
    const result = ok(await api.leaveDirective(task.id, TOLD, human, NOW));
    expect((result.notice as { code: string }).code).toBe("WATCHER_RETIRED");
  });
});

/** A registered machine for the claim half. The rewrite line enrolls on first
 *  claim, so this is the same door a real daemon comes through. */
async function enrolledMachine() {
  const token = "dk_directive_test_token";
  const machine = await queue.enrollDeviceForClaim(token, { host: "vitest", platform: "darwin", arch: "arm64", version: "test" });
  if (!machine) throw new Error("machine did not enroll");
  const legacyStore = await import("../db/store.js");
  // Open mode enrolls into the shared team; the fixtures live in this test's own
  // team, and `claimOnce` selects by the machine's team.
  await legacyStore.updateMachine(machine.id, { teamId: TEAM });
  return { ...machine, teamId: TEAM };
}
