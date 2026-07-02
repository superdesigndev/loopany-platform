/**
 * Scheduler engine e2e — drives the real cron/timer + real SQLite store end to
 * end against a temp database. Verifies the P0 run lifecycle:
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
  db.runMigrations();
  store = await import("../db/store.js");
  sched = await import("./index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh tables per test.
  db.sqlite.exec("DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function dueLoop(machineId: string): Loop {
  const m = store.createMachine({
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
function metricLoop(suffix: string): Loop {
  const m = store.createMachine({ id: `m-${suffix}`, userId: "u1", name: "M", tokenHash: "h", online: true });
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
function addRunAt(loop: Loop, role: "exec" | "evolve", offsetMs = 0): void {
  store.addRun({
    loopId: loop.id,
    userId: loop.userId,
    machineId: loop.machineId,
    phase: "done",
    role,
    ...(role === "exec" ? { outcome: "exec" as const } : {}),
    ts: new Date(Date.now() + offsetMs).toISOString(),
  });
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("tick creates a run and the dispatcher receives it (simulated machine → done)", async () => {
  const loop = dueLoop("online");
  const seen: Run[] = [];
  const dispatcher = {
    dispatch(_l: Loop, r: Run): void {
      seen.push(r);
      // Simulate the machine running it and reporting back.
      store.updateRun(r.id, { phase: "done", outcome: "exec", status: "nothing-new", durationMs: 5, ts: new Date().toISOString() });
    },
  };
  const ac = new AbortController();
  new sched.Scheduler(dispatcher).start(ac.signal);

  await waitFor(() => store.listRuns(loop.id).length > 0);
  ac.abort();

  const runs = store.listRuns(loop.id);
  expect(runs.length).toBe(1);
  expect(seen.length).toBe(1);
  expect(runs[0]!.phase).toBe("done");
  expect(runs[0]!.outcome).toBe("exec");
  // nextRunAt one-shot was consumed.
  expect(store.getLoop(loop.id)!.nextRunAt).toBeNull();
});

test("transport-agnostic: a no-op dispatcher leaves the run pending (for poll to claim)", async () => {
  const loop = dueLoop("pending");
  const dispatcher = { dispatch(): void {} };
  const ac = new AbortController();
  new sched.Scheduler(dispatcher).start(ac.signal);

  await waitFor(() => store.listRuns(loop.id).length > 0);
  ac.abort();

  const runs = store.listRuns(loop.id);
  expect(runs.length).toBe(1);
  expect(runs[0]!.phase).toBe("pending"); // engine never decides offline; reclaim does
});

test("overlap guard: a second due tick is skipped while a run is open", async () => {
  const loop = dueLoop("overlap");
  // No-op dispatcher leaves the run open (pending) — simulates an in-flight run.
  const dispatcher = { dispatch(): void {} };
  const ac = new AbortController();
  const s = new sched.Scheduler(dispatcher);
  s.start(ac.signal);

  await waitFor(() => store.listRuns(loop.id).length === 1);
  // Force a second immediate tick; it must be skipped (open run exists).
  s.runNow(loop.id);
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();

  expect(store.listRuns(loop.id).length).toBe(1);
  expect(store.openRuns().length).toBe(1);
});

test("maybeFlagEvolve bootstraps on the first run (no run-count wait)", () => {
  const loop = metricLoop("evolve-boot");
  addRunAt(loop, "exec"); // a single run, no prior evolve → bootstrap fires immediately

  const s = new sched.Scheduler({ dispatch(): void {} });
  s.maybeFlagEvolve(loop.id);

  const updated = store.getLoop(loop.id)!;
  expect(updated.evolveDue).toBe(true);
  expect(updated.nextRunAt).toBeTruthy();
});

test("maybeFlagEvolve waits EVOLVE_EVERY runs between evolves (steady state)", () => {
  const loop = metricLoop("evolve-every");
  // A prior evolve >24h ago clears the interval gate → we're in steady state.
  addRunAt(loop, "evolve", -25 * 3_600_000);
  store.updateLoop(loop.id, { evolvedRunCount: store.countRuns(loop.id) }); // watermark at the evolve

  // Two new runs — short of EVOLVE_EVERY(3) since the watermark → no flag yet.
  addRunAt(loop, "exec", 1);
  addRunAt(loop, "exec", 2);
  const s = new sched.Scheduler({ dispatch(): void {} });
  s.maybeFlagEvolve(loop.id);
  expect(store.getLoop(loop.id)!.evolveDue).toBeFalsy();

  // A third new run crosses the threshold → flag.
  addRunAt(loop, "exec", 3);
  s.maybeFlagEvolve(loop.id);
  expect(store.getLoop(loop.id)!.evolveDue).toBe(true);
});

test("maybeFlagEvolve caps auto-evolve at once per day (a recent evolve defers it)", () => {
  const loop = metricLoop("evolve-cap");
  // Enough exec runs to clear the run-count gate.
  for (let i = 0; i < 3; i++) addRunAt(loop, "exec", i);
  // An evolve run an hour ago → inside the 24h window → must NOT re-flag.
  addRunAt(loop, "evolve", -3_600_000);

  const s = new sched.Scheduler({ dispatch(): void {} });
  s.maybeFlagEvolve(loop.id);
  expect(store.getLoop(loop.id)!.evolveDue).toBeFalsy();

  // Push that evolve to >24h ago → the cap clears and it flags.
  db.sqlite.exec(`UPDATE runs SET ts = '${new Date(Date.now() - 25 * 3_600_000).toISOString()}' WHERE role = 'evolve' AND loop_id = '${loop.id}'`);
  s.maybeFlagEvolve(loop.id);
  expect(store.getLoop(loop.id)!.evolveDue).toBe(true);
});

test("finishEdit / finishEvolution preserve a FUTURE nextRunAt (the run's own reschedule) but clear a spent one", () => {
  const loop = metricLoop("finish-keep");
  const s = new sched.Scheduler({ dispatch(): void {} });
  const future = new Date(Date.now() + 3_600_000).toISOString();

  // An edit run applied `reschedule` (future nextRunAt) before finishing — the
  // marker cleanup must NOT wipe the run's own work.
  store.updateLoop(loop.id, { editRequest: "run at a better time", nextRunAt: future });
  s.finishEdit(loop.id);
  expect(store.getLoop(loop.id)!.editRequest).toBeNull();
  expect(store.getLoop(loop.id)!.nextRunAt).toBe(future);

  // Same for an evolve pass.
  store.updateLoop(loop.id, { evolveDue: true, nextRunAt: future });
  s.finishEvolution(loop.id);
  expect(store.getLoop(loop.id)!.evolveDue).toBeFalsy();
  expect(store.getLoop(loop.id)!.nextRunAt).toBe(future);

  // A spent (past) one-shot — the very trigger that fired this run — still clears.
  store.updateLoop(loop.id, { editRequest: "again", nextRunAt: new Date(Date.now() - 1_000).toISOString() });
  s.finishEdit(loop.id);
  expect(store.getLoop(loop.id)!.nextRunAt).toBeNull();

  s.removeLoop(loop.id); // stop the cron/timers finishEdit's addLoop armed
});

test("evolveDue tick creates a dedicated evolve run", async () => {
  const machine = store.createMachine({ id: "m-evolve-tick", userId: "u1", name: "M", tokenHash: "h", online: true });
  const loop = store.createLoop({
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
  new sched.Scheduler({
    dispatch(_l: Loop, r: Run): void {
      seen.push(r);
    },
  }).start(ac.signal);

  await waitFor(() => store.listRuns(loop.id).length === 1);
  ac.abort();

  const runs = store.listRuns(loop.id);
  expect(seen[0]!.role).toBe("evolve");
  expect(runs[0]!.role).toBe("evolve");
  expect(runs[0]!.phase).toBe("pending");
});
