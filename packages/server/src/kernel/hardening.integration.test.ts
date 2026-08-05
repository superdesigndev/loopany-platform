/**
 * The post-convergence hardening batch — one describe per carried-forward review
 * finding, each constructing the failure first and then pinning the fix.
 *
 *  - cv-s2 F7: the poll's claim guard and the claim itself were two statements.
 *  - cv-s2 F8: the due scan's bounded window could be squatted by inert tasks.
 *  - cv-s3 F2: `claimable_at` is a write-once floor, so a stamp taken while the
 *    row was claimable went STALE behind a sibling that started running later.
 *  - cv-s4 F2: the parent cycle guard is a read-then-write walk.
 *
 * Everything here drives the REAL production paths (`MachineGateway.poll`/
 * `sweep`, `store.claimPendingRun`, `tickDueTasks`, `parentIssue`) against a
 * real pglite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/schema.js");
let kernelSchema: typeof import("../db/kernel-schema.js");
let store: typeof import("../db/store.js");
let kernelStore: typeof import("../db/kernelStore.js");
let kernel: typeof import("./applyTransition.js");
let queue: typeof import("./runQueue.js");
let gatewayModule: typeof import("../gateway/index.js");

const TEAM = "team-hard";
const USER = "u-hard";
const TOKEN = "dk_hardening_device_token";
const NOW = new Date("2026-08-05T12:00:00.000Z");
const human = { entrance: "human", actorId: USER } as const;
/** The sweep's never-claimed horizon (`LOOPANY_RUN_TIMEOUT_MS`, default 20 min). */
const RUN_TIMEOUT_MS = 20 * 60_000;
const ADVISORY_COUNT = sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-hardening-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/schema.js");
  kernelSchema = await import("../db/kernel-schema.js");
  store = await import("../db/store.js");
  kernelStore = await import("../db/kernelStore.js");
  kernel = await import("./applyTransition.js");
  queue = await import("./runQueue.js");
  gatewayModule = await import("../gateway/index.js");
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

async function fixtures(enabled = true, name = "Hardening watcher") {
  const { machineIdFromToken, sha256 } = await import("../gateway/tokens.js");
  const machineId = machineIdFromToken(TOKEN);
  const existing = await store.getMachine(machineId);
  if (!existing) {
    await database.db.insert(schema.machines).values({
      id: machineId,
      userId: USER,
      name: "hardening-host",
      tokenHash: sha256(TOKEN),
      teamId: TEAM,
      online: true,
      lastSeen: new Date().toISOString(),
      createdAt: NOW.toISOString(),
    });
  }
  const loop = await store.createLoop({
    userId: USER,
    teamId: TEAM,
    machineId,
    name,
    cron: "0 7 * * *",
    enabled,
    notify: "never",
    taskFile: "/tmp/hardening/task.md",
  });
  return { loop, machineId };
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

describe("cv-s2 F7 — the claim guard is atomic with the claim", () => {
  it("the interleave that used to put two agents on one loop now claims exactly once", async () => {
    const { loop, machineId } = await fixtures();
    const stamp = new Date().toISOString();
    // Two legal pending rows for ONE loop — the state trigger runs made ordinary
    // (a routine cadence row plus a deferred directive).
    const first = await store.addRun({ loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: stamp });
    const second = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: stamp,
      reason: "directive", scope: "task:t1",
    });

    // THE RACE, deterministically: two concurrent polls each take the guard's
    // read BEFORE either commits its claim, so both see "nothing running".
    expect(await store.hasRunningRun(loop.id)).toBe(false);
    expect(await store.hasRunningRun(loop.id)).toBe(false);

    // Poll A claims. Poll B, holding a guard read that is now stale, claims a
    // DIFFERENT row — the phase-conditional UPDATE cannot see the conflict
    // because the ids differ. The loop-row lock inside the claim is what does.
    const claimedA = await store.claimPendingRun(first.id, loop.id);
    const claimedB = await store.claimPendingRun(second.id, loop.id);
    expect(claimedA).toMatchObject({ id: first.id, phase: "running" });
    expect(claimedB).toBeUndefined();

    const running = (await store.openRunsForLoop(loop.id)).filter((run) => run.phase === "running");
    expect(running).toHaveLength(1);
    expect(await store.getRun(second.id)).toMatchObject({ phase: "pending" });
  });

  it("the loser is DEFERRED, not lost: it claims on the next poll once the sibling reports", async () => {
    const { loop, machineId } = await fixtures();
    const held = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: new Date().toISOString(),
      reason: "directive", scope: "task:t1",
    });
    const running = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: new Date().toISOString(),
    });
    expect(await store.claimPendingRun(held.id, loop.id)).toBeUndefined();

    await store.updateRun(running.id, { phase: "done", outcome: "exec" });
    expect(await store.claimPendingRun(held.id, loop.id)).toMatchObject({ id: held.id, phase: "running" });
  });

  it("two loops are never serialized against each other — the lock is per loop", async () => {
    const { loop: a, machineId } = await fixtures(true, "Loop A");
    const { loop: b } = await fixtures(true, "Loop B");
    const runA = await store.addRun({ loopId: a.id, userId: USER, machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
    const runB = await store.addRun({ loopId: b.id, userId: USER, machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
    expect(await store.claimPendingRun(runA.id, a.id)).toMatchObject({ phase: "running" });
    expect(await store.claimPendingRun(runB.id, b.id)).toMatchObject({ phase: "running" });
  });
});

describe("cv-s3 F2 — a stale claimable_at can no longer be read as 'never claimed'", () => {
  it("a row stamped BEFORE its sibling started is not falsely reclaimed in the window after the sibling reports", async () => {
    const { loop, machineId } = await fixtures();
    // The interleave: the routine row was queued while the loop was idle, so it
    // was stamped claimable at creation. A trigger row then claimed the loop and
    // executed for longer than the never-claimed horizon, and the routine row
    // aged behind it the whole time.
    const old = new Date(Date.now() - (RUN_TIMEOUT_MS + 60_000)).toISOString();
    const executing = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: old,
      reason: "directive", scope: "task:long",
      progress: { step: 3, label: "long agent run", at: new Date().toISOString() },
    });
    const routine = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: old,
      claimableAt: old,
    });

    // A poll while the sibling runs: the guard holds the row AND un-stamps it,
    // because held time is not eligible time.
    await gateway().poll(TOKEN);
    expect(await store.getRun(routine.id)).toMatchObject({ phase: "pending", claimableAt: null });

    // The sibling reports, then the sweep runs before the next poll — the exact
    // window the finding names. It must open a FRESH window, not reclaim.
    await store.updateRun(executing.id, { phase: "done", outcome: "exec" });
    const floor = Date.now();
    await gateway().sweep();
    const released = await store.getRun(routine.id);
    expect(released).toMatchObject({ phase: "pending", error: null, outcome: null });
    expect(Date.parse(released!.claimableAt!)).toBeGreaterThanOrEqual(floor);
    // No false failure fact anywhere.
    expect(await database.db.select().from(kernelSchema.events)).toHaveLength(0);
  });

  it("the sweep clears a stale stamp too, for a machine whose poll is between passes", async () => {
    const { loop, machineId } = await fixtures();
    const old = new Date(Date.now() - (RUN_TIMEOUT_MS + 60_000)).toISOString();
    await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: old,
      progress: { step: 1, label: "still working", at: new Date().toISOString() },
    });
    const held = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: old, claimableAt: old,
      reason: "directive", scope: "task:held",
    });
    await gateway().sweep();
    expect(await store.getRun(held.id)).toMatchObject({ phase: "pending", claimableAt: null, error: null });
  });

  it("SOUNDNESS: clearing the stamp does not make a row immortal — an eligible row still times out", async () => {
    const { loop, machineId } = await fixtures();
    const wedged = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: new Date().toISOString(),
      claimableAt: new Date(Date.now() - (RUN_TIMEOUT_MS + 60_000)).toISOString(),
      reason: "directive", scope: "task:wedged",
    });
    await gateway().sweep();
    expect(await store.getRun(wedged.id)).toMatchObject({ phase: "error", error: "run never claimed" });
  });
});

describe("cv-s2 F8 — inert due tasks cannot squat the bounded scan window", () => {
  it("a full window of due tasks on a PAUSED watcher still lets an enabled watcher's task fire", async () => {
    const { loop: paused } = await fixtures(false, "Paused watcher");
    const { loop: live } = await fixtures(true, "Live watcher");

    // Exactly one scan window's worth of perpetually-due tasks whose watcher can
    // never act, all OLDER than the actionable one so they sort ahead of it.
    for (let i = 0; i < queue.DUE_SCAN_LIMIT; i++) {
      const made = await kernel.createObject({
        teamId: TEAM, kind: "task", actor: human, now: NOW.toISOString(),
        title: `inert ${i}`, watcher: paused.id,
        followUpAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString(),
      } as never);
      if (!made.ok) throw new Error(made.message);
    }
    const actionable = await kernel.createObject({
      teamId: TEAM, kind: "task", actor: human, now: NOW.toISOString(),
      title: "actionable", watcher: live.id, followUpAt: "2026-08-01T00:00:00.000Z",
    } as never);
    if (!actionable.ok) throw new Error(actionable.message);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1, failed: 0 });
    const rows = await database.db.select().from(schema.runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ loopId: live.id, reason: "due", scope: `task:${actionable.object.id}` });
  });

  it("a DELETED watcher's due task cannot squat a slot either", async () => {
    const { loop: live } = await fixtures(true, "Live watcher");
    const made = await kernel.createObject({
      teamId: TEAM, kind: "task", actor: human, now: NOW.toISOString(),
      title: "tombstone", watcher: "loop-gone-forever", followUpAt: "2026-01-01T00:00:00.000Z",
    } as never);
    if (!made.ok) throw new Error(made.message);
    const actionable = await kernel.createObject({
      teamId: TEAM, kind: "task", actor: human, now: NOW.toISOString(),
      title: "actionable", watcher: live.id, followUpAt: "2026-08-01T00:00:00.000Z",
    } as never);
    if (!actionable.ok) throw new Error(actionable.message);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 1, queued: 1 });
  });

  it("the enablement gate itself is unchanged: re-enabling still fires the still-due task", async () => {
    const { loop } = await fixtures(false);
    const made = await kernel.createObject({
      teamId: TEAM, kind: "task", actor: human, now: NOW.toISOString(),
      title: "waits for resume", watcher: loop.id, followUpAt: "2026-08-01T00:00:00.000Z",
    } as never);
    if (!made.ok) throw new Error(made.message);
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 0, queued: 0 });
    await store.updateLoop(loop.id, { enabled: true });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 1, queued: 1 });
  });
});

describe("cv-s4 F2 — the cycle guard serializes hierarchy writes for its team", () => {
  async function makeTask(title: string): Promise<string> {
    const { loop } = await fixtures(true, `watcher for ${title}`);
    const made = await kernel.createObject({
      teamId: TEAM, kind: "task", actor: human, now: NOW.toISOString(), title, watcher: loop.id,
    } as never);
    if (!made.ok) throw new Error(made.message);
    return made.object.id;
  }

  it("takes the team hierarchy lock BEFORE walking the ancestor chain", async () => {
    const child = await makeTask("child");
    const parent = await makeTask("parent");

    await database.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as import("../db/kernelStore.js").KernelExec;
      const advisoryLocks = async (): Promise<number> =>
        Number(((await tx.execute(ADVISORY_COUNT)) as unknown as { rows: { n: number }[] }).rows[0]!.n);
      expect(await advisoryLocks()).toBe(0);
      expect(await kernel.parentIssue(tx, TEAM, child, parent)).toBeUndefined();
      // The walk ran under a lock, and it is still held for the rest of the
      // transaction — which is what makes the read-then-write pair sound.
      expect(await advisoryLocks()).toBe(1);
      // Re-entrant: a create that walks twice never blocks on itself.
      await kernelStore.lockTeamHierarchy(tx, TEAM);
      expect(await advisoryLocks()).toBe(1);
    });

    // Transaction-scoped: nothing survives the commit.
    const after = (await database.db.execute(ADVISORY_COUNT)) as unknown as { rows: { n: number }[] };
    expect(after.rows[0]!.n).toBe(0);
  });

  it("still refuses the cycle it always refused, and still accepts a legal parent", async () => {
    const a = await makeTask("a");
    const b = await makeTask("b");
    const moved = await kernel.applyUpdate({
      teamId: TEAM, objectId: b, fields: { parentId: a }, actor: human, now: NOW.toISOString(), mode: "human",
    } as never);
    expect(moved.ok).toBe(true);

    const cycle = await kernel.applyUpdate({
      teamId: TEAM, objectId: a, fields: { parentId: b }, actor: human, now: NOW.toISOString(), mode: "human",
    } as never);
    expect(cycle).toMatchObject({ ok: false, code: "PARENT_CYCLE" });
  });
});
