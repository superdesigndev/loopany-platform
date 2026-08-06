/**
 * Shipped copy of the cv-s2-verify gate's 17-test scratch suite.
 * Independent reconstruction of the cv-s2-review reproductions F1-F6 + R1-R3
 * + the firstmate mirror-image check, driven against the REAL code paths
 * (Scheduler.runLoop, MachineGateway.sweep/poll/report, objectApi, tickDueTasks)
 * on a real pglite. Deliberately does NOT reuse the shipped regression tests'
 * assertions verbatim - several cases here assert MORE (eventual delivery,
 * canceled-row re-arm, never-claimed retention).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/schema.js");
let kernelSchema: typeof import("../db/kernel-schema.js");
let store: typeof import("../db/store.js");
let kernel: typeof import("./applyTransition.js");
let queue: typeof import("./runQueue.js");
let api: typeof import("./objectApi.js");
let gatewayModule: typeof import("../gateway/index.js");
let ids: typeof import("./ids.js");
let schedulerModule: typeof import("../scheduler/index.js");
let tokens: typeof import("../gateway/tokens.js");
let kernelStore: typeof import("../db/kernelStore.js");

const TEAM = "team-v";
const USER = "u-v";
const TOKEN = "dk_verify_device_token";
const NOW = new Date("2026-08-04T12:00:00.000Z");
const human = { teamId: TEAM, actor: { entrance: "human", actorId: USER }, mode: "owner" } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-cv-s2-verify-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/schema.js");
  kernelSchema = await import("../db/kernel-schema.js");
  store = await import("../db/store.js");
  kernel = await import("./applyTransition.js");
  queue = await import("./runQueue.js");
  api = await import("./objectApi.js");
  gatewayModule = await import("../gateway/index.js");
  ids = await import("./ids.js");
  schedulerModule = await import("../scheduler/index.js");
  tokens = await import("../gateway/tokens.js");
  kernelStore = await import("../db/kernelStore.js");
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

beforeEach(async () => {
  await database.db.delete(schema.runLeases);
  await database.db.delete(kernelSchema.events);
  await database.db.delete(kernelSchema.objects);
  await database.db.delete(schema.runs);
  await database.db.delete(schema.loops);
  await database.db.delete(schema.machines);
});

async function fixtures(enabled = true) {
  const { machineIdFromToken, sha256 } = await import("../gateway/tokens.js");
  const machineId = machineIdFromToken(TOKEN);
  await database.db.insert(schema.machines).values({
    id: machineId,
    userId: USER,
    name: "verify-host",
    tokenHash: sha256(TOKEN),
    teamId: TEAM,
    lastSeen: new Date().toISOString(),
    createdAt: NOW.toISOString(),
    online: true,
  });
  const loop = await store.createLoop({
    userId: USER,
    teamId: TEAM,
    machineId,
    name: "Verify watcher",
    cron: "0 7 * * *",
    enabled,
    notify: "never",
    taskFile: "/tmp/verify-loop/task.md",
  });
  return { loop, machineId };
}

async function task(watcher: string, extra: Record<string, unknown> = {}) {
  const made = await kernel.createObject({
    teamId: TEAM,
    kind: "task",
    actor: human.actor,
    now: NOW.toISOString(),
    title: "Verify fix round",
    watcher,
    payload: { probe: "VERIFY <keep> intact" },
    ...extra,
  } as never);
  if (!made.ok) throw new Error(made.message);
  return made.object;
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function gateway() {
  const scheduler = {
    removeLoop(): void {},
    async maybeFlagEvolve(): Promise<void> {},
    async finishEvolution(): Promise<void> {},
    async finishEdit(): Promise<void> {},
  } as never;
  return new gatewayModule.MachineGateway(scheduler);
}

function realRunLoop(scheduler: InstanceType<typeof schedulerModule.Scheduler>, id: string) {
  return (scheduler as unknown as { runLoop(id: string): Promise<void> }).runLoop(id);
}

describe("cv-s2-verify: F1 - trigger rows survive cron supersede", () => {
  it("F1a: a due trigger row survives the real runLoop tick AND the cron's own routine row is created (mirror-image)", async () => {
    const { loop } = await fixtures();
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const dueId = ids.dueRunId(loop.id, due.id, due.followUpAt!);

    const scheduler = new schedulerModule.Scheduler({ dispatch(): void {} });
    await realRunLoop(scheduler, loop.id);

    const rows = await database.db.select().from(schema.runs);
    // The trigger row survived, still pending, provenance intact.
    expect(rows.find((r) => r.id === dueId)).toMatchObject({
      phase: "pending",
      reason: "due",
      scope: `task:${due.id}`,
    });
    // MIRROR IMAGE: the cron fire was NOT absorbed into the surviving trigger
    // row - a provenance-free routine row of its own exists, also pending.
    const routine = rows.filter((r) => r.id !== dueId && r.reason == null && r.scope == null);
    expect(routine).toHaveLength(1);
    expect(routine[0]).toMatchObject({ phase: "pending", role: "exec" });
    // The instant stays represented (no consumed-forever): rescan replays.
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ replayed: 1, queued: 0 });
  });

  it("F1b: a DIRECTIVE trigger row also survives the cron tick (the owner's words are never dropped)", async () => {
    const { loop } = await fixtures();
    const watched = await task(loop.id);
    const result = ok(await api.leaveDirective(watched.id, "Survive the cron fire.", human, NOW));
    expect(result.run).toMatchObject({ alreadyQueued: false });

    const scheduler = new schedulerModule.Scheduler({ dispatch(): void {} });
    await realRunLoop(scheduler, loop.id);

    const rows = await database.db.select().from(schema.runs);
    const directiveRow = rows.find((r) => r.reason === "directive");
    expect(directiveRow).toMatchObject({ phase: "pending", scope: `task:${watched.id}` });
    expect(rows.filter((r) => r.reason == null && r.scope == null && r.phase === "pending")).toHaveLength(1);
  });

  it("F1c: a due instant canceled by the 7-day backstop stays queueable (re-arms the SAME frozen id)", async () => {
    const { loop, machineId } = await fixtures();
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const dueId = ids.dueRunId(loop.id, due.id, due.followUpAt!);
    // Machine offline past the catch-up horizon: the backstop cancels the row as skipped.
    await store.updateMachine(machineId, { online: false, lastSeen: "2000-01-01T00:00:00.000Z" });
    await store.updateRun(dueId, { ts: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    await gateway().sweep();
    expect(await store.getRun(dueId)).toMatchObject({ phase: "canceled", outcome: "skipped" });

    // The instant is NOT consumed forever: the level trigger re-arms the same id.
    await store.updateMachine(machineId, { online: true, lastSeen: new Date().toISOString() });
    expect(await queue.tickDueTasks(new Date())).toMatchObject({ queued: 1, replayed: 0 });
    expect(await store.getRun(dueId)).toMatchObject({ id: dueId, phase: "pending", outcome: null, reason: "due" });
  });
});

describe("cv-s2-verify: F2 - sweep vs guard-held rows", () => {
  it("F2a: a 21-min pending trigger behind a healthy RUNNING sibling is NOT reclaimed", async () => {
    const { loop, machineId } = await fixtures();
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    const executing = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: old,
      progress: { step: 2, label: "long agent run", at: new Date().toISOString() },
    });
    const held = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: old,
      reason: "directive", scope: "task:held",
    });
    await gateway().sweep();
    expect(await store.getRun(held.id)).toMatchObject({ phase: "pending", claimableAt: null, error: null, outcome: null });
    // No failure notification side effects: no run-finished event either.
    expect(await database.db.select().from(kernelSchema.events).where(eq(kernelSchema.events.kind, "run-finished"))).toHaveLength(0);

    // S3 rider: when the sibling has only just finished, the row starts aging
    // from THIS first claimable moment, not its 21-minute-old creation time.
    await store.updateRun(executing.id, { phase: "done", outcome: "exec" });
    const claimableFloor = Date.now();
    await gateway().sweep();
    const released = await store.getRun(held.id);
    expect(released).toMatchObject({ phase: "pending", error: null, outcome: null });
    expect(Date.parse(released!.claimableAt!)).toBeGreaterThanOrEqual(claimableFloor);
    await gateway().sweep();
    expect(await store.getRun(held.id)).toMatchObject({ phase: "pending", error: null, outcome: null });
  });

  it("F2b (soundness): a genuinely wedged 21-min pending row with NO running sibling is still reclaimed", async () => {
    const { loop, machineId } = await fixtures();
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    const wedged = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: old,
      claimableAt: old,
      reason: "directive", scope: "task:wedged",
    });
    await gateway().sweep();
    expect(await store.getRun(wedged.id)).toMatchObject({ phase: "error", error: "run never claimed" });
    // F4 coverage for THIS path: the reclaim appended run-finished.
    const finished = await database.db.select().from(kernelSchema.events).where(eq(kernelSchema.events.kind, "run-finished"));
    expect(finished).toHaveLength(1);
    expect(finished[0]!.payload).toMatchObject({ outcome: "failure", reason: "directive", scope: "task:wedged" });
  });
});

describe("cv-s2-verify: F3 - trigger during EXECUTION queues fresh and eventually DELIVERS", async () => {
  it("F3: directive during a running run queues its own scoped row, is guard-held, then delivers with the words after the sibling finishes", async () => {
    const { loop, machineId } = await fixtures();
    const watched = await task(loop.id);
    const executing = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: NOW.toISOString(),
    });

    const words = "Deliver this after the active run.";
    const result = ok(await api.leaveDirective(watched.id, words, human, NOW));
    expect(result.run).toMatchObject({ alreadyQueued: false, reason: "directive" });
    const rows = await database.db.select().from(schema.runs);
    expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.id !== executing.id)!;
    expect(fresh).toMatchObject({ phase: "pending", scope: `task:${watched.id}`, triggerEventId: result.event });

    // Guard-held while the sibling runs.
    const gw = gateway();
    expect(((await gw.poll(TOKEN)).body as { deliveries: unknown[] }).deliveries).toHaveLength(0);

    // Sibling finishes -> the deferred trigger row is claimed and its delivery
    // carries the owner's words (the context IS eventually delivered - the
    // exact loss the review proved).
    await store.updateRun(executing.id, { phase: "done", outcome: "exec" });
    const polled = await gw.poll(TOKEN);
    const deliveries = (polled.body as { deliveries: Array<{ runId: string; task: string }> }).deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.runId).toBe(fresh.id);
    expect(deliveries[0]!.task).toContain(`directive: ${words}`);
    expect(deliveries[0]!.task).toContain("VERIFY <keep> intact");
  });
});

describe("cv-s2-verify: F4 - terminal paths append run-finished", () => {
  it("F4a: sweep reclaim of a silent RUNNING provenance run appends failure run-finished", async () => {
    const { loop, machineId } = await fixtures();
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    const run = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: old,
      reason: "due", scope: "task:silent", progress: { step: 1, label: "stale", at: old },
    });
    await gateway().sweep();
    expect(await store.getRun(run.id)).toMatchObject({ phase: "error" });
    const finished = await database.db.select().from(kernelSchema.events).where(eq(kernelSchema.events.kind, "run-finished"));
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ actorId: run.id, objectId: loop.id, origin: "derived" });
    expect(finished[0]!.payload).toMatchObject({ outcome: "failure", reason: "due" });
    // Frozen seed law: the event id is the derived id for exactly this seed.
    expect(finished[0]!.id).toBe(ids.derivedEventId({ runId: run.id, kind: "run-finished", outcome: "failure" }));
  });

  it("F4b: the 7-day backstop appends a skipped run-finished", async () => {
    const { loop, machineId } = await fixtures();
    await store.updateMachine(machineId, { online: false, lastSeen: "2000-01-01T00:00:00.000Z" });
    const expired = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec",
      ts: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      reason: "directive", scope: "task:expired",
    });
    await gateway().sweep();
    expect(await store.getRun(expired.id)).toMatchObject({ phase: "canceled", outcome: "skipped" });
    const finished = await database.db.select().from(kernelSchema.events).where(eq(kernelSchema.events.kind, "run-finished"));
    expect(finished.find((e) => e.actorId === expired.id)?.payload).toMatchObject({ outcome: "skipped", reason: "directive" });
  });

  it("F4c: ordinary provenance-free terminal runs remain event-silent", async () => {
    const { loop, machineId } = await fixtures();
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: old,
      progress: { step: 1, label: "stale", at: old },
    });
    await gateway().sweep();
    expect(await database.db.select().from(kernelSchema.events).where(eq(kernelSchema.events.kind, "run-finished"))).toHaveLength(0);
  });
});

describe("cv-s2-verify: F5 - due dedup keys COMPLETED rows only", () => {
  it("F5a: an ERROR due row re-arms the SAME frozen id and kills the old lease authority", async () => {
    const { loop, machineId } = await fixtures();
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const dueId = ids.dueRunId(loop.id, due.id, due.followUpAt!);
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    await store.updateRun(dueId, { phase: "running", ts: old, progress: { step: 1, label: "stale", at: old } });
    const oldLease = await tokens.registerRunLease({ runId: dueId, loopId: loop.id, machineId, role: "exec", allowControl: true });
    await gateway().sweep();
    expect(await store.getRun(dueId)).toMatchObject({ phase: "error" });
    expect((await tokens.resolveLease(oldLease))?.state).toBe("terminal-grace");

    expect(await queue.tickDueTasks(new Date())).toMatchObject({ queued: 1, replayed: 0 });
    const rearmed = await store.getRun(dueId);
    expect(rearmed).toMatchObject({ id: dueId, phase: "pending", outcome: null, error: null, progress: null });
    expect(await tokens.resolveLease(oldLease)).toBeUndefined();
  });

  it("F5b: a COMPLETED due row permanently dedups its instant (spec §2.1 row 2 intact)", async () => {
    const { loop } = await fixtures();
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const dueId = ids.dueRunId(loop.id, due.id, due.followUpAt!);
    await store.updateRun(dueId, { phase: "done", outcome: "exec" });
    expect(await queue.tickDueTasks(new Date())).toMatchObject({ queued: 0, replayed: 1 });
    expect(await queue.tickDueTasks(new Date())).toMatchObject({ queued: 0, replayed: 1 });
    expect(await store.getRun(dueId)).toMatchObject({ phase: "done" });
  });

  it("F5c: re-arm defers while the loop has a PENDING sibling (loop-busy), then lands", async () => {
    const { loop, machineId } = await fixtures();
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const dueId = ids.dueRunId(loop.id, due.id, due.followUpAt!);
    await store.updateRun(dueId, { phase: "error", outcome: "error", error: "boom" });
    const sibling = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: new Date().toISOString(),
    });
    // Busy: the re-arm must not stack alongside the pending sibling.
    const busy = await queue.tickDueTasks(new Date());
    expect(await store.getRun(dueId)).toMatchObject({ phase: "error" });
    expect(busy.queued).toBe(0);
    // Sibling clears -> the instant re-arms.
    await store.updateRun(sibling.id, { phase: "done", outcome: "exec" });
    expect(await queue.tickDueTasks(new Date())).toMatchObject({ queued: 1 });
    expect(await store.getRun(dueId)).toMatchObject({ phase: "pending" });
  });
});

describe("cv-s2-verify: F6 - event append failure never wedges the lifecycle", () => {
  it("F6a: a run-finished ID collision still lets report() finalize and retire the lease", async () => {
    const { loop } = await fixtures(false);
    const watched = await task(loop.id);
    ok(await api.leaveDirective(watched.id, "Finish through the collision.", human, NOW));
    const gw = gateway();
    const claimed = ((await gw.poll(TOKEN)).body as { deliveries: Array<{ runId: string; runToken: string }> }).deliveries[0]!;
    // Plant a FOREIGN holder of the exact derived run-finished id.
    await kernelStore.appendEvent(undefined, {
      id: ids.derivedEventId({ runId: claimed.runId, kind: "run-finished", outcome: "success" }),
      teamId: TEAM,
      objectId: watched.id,
      kind: "run-finished",
      origin: "derived",
      entrance: "agent",
      actorId: "run-foreign-holder",
      payload: { outcome: "success" },
      ts: NOW.toISOString(),
    });
    expect((await gw.report(claimed.runToken, { ok: true, message: "done" })).status).toBe(200);
    expect(await store.getRun(claimed.runId)).toMatchObject({ phase: "done", message: "done" });
    expect(await tokens.resolveLease(claimed.runToken)).toBeUndefined();
  });

  it("F6b: a collision on the SWEEP reclaim path still terminalizes the run", async () => {
    const { loop, machineId } = await fixtures();
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    const run = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: old,
      reason: "due", scope: "task:collide", progress: { step: 1, label: "stale", at: old },
    });
    await kernelStore.appendEvent(undefined, {
      id: ids.derivedEventId({ runId: run.id, kind: "run-finished", outcome: "failure" }),
      teamId: TEAM,
      objectId: "task-foreign",
      kind: "run-finished",
      origin: "derived",
      entrance: "agent",
      actorId: "run-foreign-holder",
      payload: { outcome: "failure" },
      ts: NOW.toISOString(),
    });
    await gateway().sweep();
    expect(await store.getRun(run.id)).toMatchObject({ phase: "error", error: "machine timed out / disconnected" });
  });
});

describe("cv-s2-verify: R1-R3 soundness properties", () => {
  it("R1: the join covers only legal states - a pending row joins, a terminal row never blocks, a running row never absorbs", async () => {
    const { loop } = await fixtures();
    const a = await task(loop.id, { title: "a" });
    const b = await task(loop.id, { title: "b" });
    // Terminal rows do not block a fresh trigger.
    await database.db.insert(schema.runs).values({
      id: "run-done-old", loopId: loop.id, userId: USER, machineId: loop.machineId,
      phase: "done", role: "exec", ts: NOW.toISOString(),
    });
    const first = ok(await api.leaveDirective(a.id, "first", human, NOW));
    expect(first.run).toMatchObject({ alreadyQueued: false });
    // A PENDING row absorbs the next trigger (the join, alreadyQueued).
    const second = ok(await api.leaveDirective(b.id, "second", human, NOW));
    expect(second.run).toMatchObject({ alreadyQueued: true });
    expect((await database.db.select().from(schema.runs)).filter((r) => r.phase === "pending")).toHaveLength(1);
  });

  it("R2: double run-now is exactly-once while pending; a third fire after execution starts queues fresh (per the F3 semantics)", async () => {
    const { loop } = await fixtures(false);
    const one = ok(await api.runLoopNow(loop.id, human, NOW));
    expect(one).toMatchObject({ queued: true, alreadyQueued: false });
    const two = ok(await api.runLoopNow(loop.id, human, NOW));
    expect(two).toMatchObject({ queued: false, alreadyQueued: true });
    expect(await database.db.select().from(schema.runs)).toHaveLength(1);
    // Once executing, a new fire is distinct work (narrowed join).
    const row = (await database.db.select().from(schema.runs))[0]!;
    await store.updateRun(row.id, { phase: "running" });
    const three = ok(await api.runLoopNow(loop.id, human, NOW));
    expect(three).toMatchObject({ queued: true });
    expect(await database.db.select().from(schema.runs)).toHaveLength(2);
  });

  it("R3: due + directive on one loop never stack - the directive joins the pending due row", async () => {
    const { loop } = await fixtures();
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const other = await task(loop.id, { title: "other" });
    const joined = ok(await api.leaveDirective(other.id, "join the due row", human, NOW));
    expect(joined.run).toMatchObject({ alreadyQueued: true });
    expect((await database.db.select().from(schema.runs)).filter((r) => r.phase === "pending")).toHaveLength(1);
    // And the due instant is still the one represented row (frozen id).
    expect(await store.getRun(ids.dueRunId(loop.id, due.id, due.followUpAt!))).toBeTruthy();
  });
});
