/**
 * Scheduler engine e2e — drives the real cron/timer + real store end to end
 * against a temp database. Verifies the P0 run lifecycle:
 *   - online machine → tick creates a run and hands it to the dispatcher
 *   - offline machine → tick records an error run ("machine offline")
 *   - overlapping ticks are skipped while a run is open
 *
 * Env (db path) must be set before importing the db singleton, so the modules
 * are loaded dynamically inside beforeAll.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import type { Loop, Run } from "../db/schema.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let sched: typeof import("./index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-e2e-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  sched = await import("./index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  // Fresh tables per test.
  await (db.client as { exec(q: string): Promise<unknown> }).exec("DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

async function dueLoop(machineId: string): Promise<Loop> {
  const m = await store.createMachine({
    id: `m-${machineId}`,
    userId: "u1",
    name: "Test Machine",
    tokenHash: "hash",
    online: true,
  });
  return store.createLoop({
    userId: "u1",
    machineId: m.id,
    name: "test loop",
    cron: "0 0 1 1 *", // far future; the run is driven by nextRunAt below
    enabled: true,
    notify: "auto",
    allowControl: false,
    nextRunAt: new Date().toISOString(), // due now → armNextRunAt fires immediately
  });
}

/** A loop with a metric schema (so `canEvolve` is true) for the evolve tests. */
async function metricLoop(suffix: string): Promise<Loop> {
  const m = await store.createMachine({ id: `m-${suffix}`, userId: "u1", name: "M", tokenHash: "h", online: true });
  return store.createLoop({
    userId: "u1",
    machineId: m.id,
    name: "metric loop",
    cron: "0 0 1 1 *",
    enabled: true,
    notify: "auto",
    stateSchema: [{ key: "mrr" }],
  });
}

/** Add a finalized run to a loop, `offsetMs` from now (negative ⇒ in the past). */
async function addRunAt(loop: Loop, role: "exec" | "evolve", offsetMs = 0): Promise<void> {
  await store.addRun({
    loopId: loop.id,
    userId: loop.userId,
    machineId: loop.machineId,
    phase: "done",
    role,
    ...(role === "exec" ? { outcome: "exec" as const } : {}),
    ts: new Date(Date.now() + offsetMs).toISOString(),
  });
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("tick creates a run and the dispatcher receives it (simulated machine → done)", async () => {
  const loop = await dueLoop("online");
  const seen: Run[] = [];
  const dispatcher = {
    async dispatch(_l: Loop, r: Run): Promise<void> {
      seen.push(r);
      // Simulate the machine running it and reporting back.
      await store.updateRun(r.id, { phase: "done", outcome: "exec", status: "nothing-new", durationMs: 5, ts: new Date().toISOString() });
    },
  };
  const ac = new AbortController();
  await new sched.Scheduler(dispatcher).start(ac.signal);

  await waitFor(async () => (await store.listRuns(loop.id)).length > 0);
  ac.abort();

  const runs = await store.listRuns(loop.id);
  expect(runs.length).toBe(1);
  expect(seen.length).toBe(1);
  expect(runs[0]!.phase).toBe("done");
  expect(runs[0]!.outcome).toBe("exec");
  // nextRunAt one-shot was consumed.
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeNull();
});

test("transport-agnostic: a no-op dispatcher leaves the run pending (for poll to claim)", async () => {
  const loop = await dueLoop("pending");
  const dispatcher = { dispatch(): void {} };
  const ac = new AbortController();
  await new sched.Scheduler(dispatcher).start(ac.signal);

  await waitFor(async () => (await store.listRuns(loop.id)).length > 0);
  ac.abort();

  const runs = await store.listRuns(loop.id);
  expect(runs.length).toBe(1);
  expect(runs[0]!.phase).toBe("pending"); // engine never decides offline; reclaim does
});

test("overlap guard: a RUNNING run blocks the tick; a deferred PENDING one is superseded (skipped)", async () => {
  const loop = await dueLoop("overlap");
  // No-op dispatcher leaves the run open (pending) — simulates a machine that
  // hasn't claimed it (asleep/offline at fire time).
  const dispatcher = { dispatch(): void {} };
  const ac = new AbortController();
  const s = new sched.Scheduler(dispatcher);
  await s.start(ac.signal);

  await waitFor(async () => (await store.listRuns(loop.id)).length === 1);
  const first = (await store.listRuns(loop.id))[0]!;

  // A second exec fire SUPERSEDES the still-pending first: the old slot retires
  // as `skipped` (neither success nor failure) and exactly ONE fresh pending run
  // takes its place — the coalesced catch-up queue stays depth-1.
  await s.runNow(loop.id);
  await waitFor(async () => (await store.listRuns(loop.id)).length === 2);
  const superseded = (await store.getRun(first.id))!;
  expect(superseded.phase).toBe("canceled");
  expect(superseded.outcome).toBe("skipped");
  const open1 = await store.openRunsForLoop(loop.id);
  expect(open1).toHaveLength(1);
  expect(open1[0]!.phase).toBe("pending");

  // A RUNNING run still blocks the tick outright (never two agents on one loop).
  await store.updateRun(open1[0]!.id, { phase: "running" });
  await s.runNow(loop.id);
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();

  expect((await store.listRuns(loop.id)).length).toBe(2);
  expect((await store.openRunsForLoop(loop.id))[0]!.phase).toBe("running");

  // The supersede is phase-guarded: a run that got claimed (running) in the same
  // instant is left alone — the guard is what makes the race safe.
  expect(await store.supersedePendingRun(open1[0]!.id, "x")).toBe(false);
});

test("maybeFlagEvolve bootstraps on the first run (no run-count wait)", async () => {
  const loop = await metricLoop("evolve-boot");
  await addRunAt(loop, "exec"); // a single run, no prior evolve → bootstrap fires immediately

  const s = new sched.Scheduler({ dispatch(): void {} });
  await s.maybeFlagEvolve(loop.id);

  const updated = (await store.getLoop(loop.id))!;
  expect(updated.evolveDue).toBe(true);
  expect(updated.nextRunAt).toBeTruthy();
});

test("maybeFlagEvolve waits EVOLVE_EVERY runs between evolves (steady state)", async () => {
  const loop = await metricLoop("evolve-every");
  // A prior evolve >24h ago clears the interval gate → we're in steady state.
  await addRunAt(loop, "evolve", -25 * 3_600_000);
  await store.updateLoop(loop.id, { evolvedRunCount: await store.countRuns(loop.id) }); // watermark at the evolve

  // Two new runs — short of EVOLVE_EVERY(3) since the watermark → no flag yet.
  await addRunAt(loop, "exec", 1);
  await addRunAt(loop, "exec", 2);
  const s = new sched.Scheduler({ dispatch(): void {} });
  await s.maybeFlagEvolve(loop.id);
  expect((await store.getLoop(loop.id))!.evolveDue).toBeFalsy();

  // A third new run crosses the threshold → flag.
  await addRunAt(loop, "exec", 3);
  await s.maybeFlagEvolve(loop.id);
  expect((await store.getLoop(loop.id))!.evolveDue).toBe(true);
});

test("maybeFlagEvolve caps auto-evolve at once per day (a recent evolve defers it)", async () => {
  const loop = await metricLoop("evolve-cap");
  // Enough exec runs to clear the run-count gate.
  for (let i = 0; i < 3; i++) await addRunAt(loop, "exec", i);
  // An evolve run an hour ago → inside the 24h window → must NOT re-flag.
  await addRunAt(loop, "evolve", -3_600_000);

  const s = new sched.Scheduler({ dispatch(): void {} });
  await s.maybeFlagEvolve(loop.id);
  expect((await store.getLoop(loop.id))!.evolveDue).toBeFalsy();

  // Push that evolve to >24h ago → the cap clears and it flags.
  await (db.client as { exec(q: string): Promise<unknown> }).exec(`UPDATE runs SET ts = '${new Date(Date.now() - 25 * 3_600_000).toISOString()}' WHERE role = 'evolve' AND loop_id = '${loop.id}'`);
  await s.maybeFlagEvolve(loop.id);
  expect((await store.getLoop(loop.id))!.evolveDue).toBe(true);
});

test("finishEdit / finishEvolution preserve a FUTURE nextRunAt (the run's own reschedule) but clear a spent one", async () => {
  const loop = await metricLoop("finish-keep");
  const s = new sched.Scheduler({ dispatch(): void {} });
  const future = new Date(Date.now() + 3_600_000).toISOString();

  // An edit run applied `reschedule` (future nextRunAt) before finishing — the
  // marker cleanup must NOT wipe the run's own work.
  await store.updateLoop(loop.id, { editRequest: "run at a better time", nextRunAt: future });
  await s.finishEdit(loop.id);
  expect((await store.getLoop(loop.id))!.editRequest).toBeNull();
  expect((await store.getLoop(loop.id))!.nextRunAt).toBe(future);

  // Same for an evolve pass.
  await store.updateLoop(loop.id, { evolveDue: true, nextRunAt: future });
  await s.finishEvolution(loop.id);
  expect((await store.getLoop(loop.id))!.evolveDue).toBeFalsy();
  expect((await store.getLoop(loop.id))!.nextRunAt).toBe(future);

  // A spent (past) one-shot — the very trigger that fired this run — still clears.
  await store.updateLoop(loop.id, { editRequest: "again", nextRunAt: new Date(Date.now() - 1_000).toISOString() });
  await s.finishEdit(loop.id);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeNull();

  s.removeLoop(loop.id); // stop the cron/timers finishEdit's addLoop armed
});

test("in-flight guard: two concurrent triggers for one loop create exactly ONE pending run", async () => {
  const loop = await dueLoop("inflight");
  // Hold the first tick in dispatch so the second trigger overlaps it in-flight.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let dispatches = 0;
  const s = new sched.Scheduler({
    async dispatch(): Promise<void> {
      dispatches++;
      await gate;
    },
  });

  // Drive runLoop directly (private): two calls in the SAME synchronous tick — the
  // first adds the loop to the in-flight set before its first await, the second
  // short-circuits on it (the guard the async hasOpenRun→addRun window needs).
  const r = s as unknown as { runLoop(id: string): Promise<void> };
  const first = r.runLoop(loop.id);
  const second = r.runLoop(loop.id);
  await second; // the guarded (skipped) call resolves immediately
  release();
  await first;

  expect(dispatches).toBe(1);
  expect((await store.listRuns(loop.id)).length).toBe(1);
  expect((await store.openRuns()).length).toBe(1);
});

test("evolveDue tick creates a dedicated evolve run", async () => {
  const machine = await store.createMachine({ id: "m-evolve-tick", userId: "u1", name: "M", tokenHash: "h", online: true });
  const loop = await store.createLoop({
    userId: "u1",
    machineId: machine.id,
    name: "metric loop",
    cron: "0 0 1 1 *",
    enabled: true,
    notify: "auto",
    stateSchema: [{ key: "mrr" }],
    evolveDue: true,
    nextRunAt: new Date().toISOString(),
  });
  const seen: Run[] = [];
  const ac = new AbortController();
  await new sched.Scheduler({
    dispatch(_l: Loop, r: Run): void {
      seen.push(r);
    },
  }).start(ac.signal);

  await waitFor(async () => (await store.listRuns(loop.id)).length === 1);
  ac.abort();

  const runs = await store.listRuns(loop.id);
  expect(seen[0]!.role).toBe("evolve");
  expect(runs[0]!.role).toBe("evolve");
  expect(runs[0]!.phase).toBe("pending");
});
