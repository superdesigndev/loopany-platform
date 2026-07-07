/**
 * Sleep/wake reclaim reconciliation (P0 correctness bug). Seeds the store the way
 * a laptop sleep would leave it — backdated `lastSeen` / `run.ts` / `progress.at` —
 * then drives the REAL `gateway.sweep()` and `gateway.report()`. Models the
 * investigation's repro (report §3):
 *   (a) a running run reclaimed as timed-out, then a late SUCCESS wake-report →
 *       the run ends `done` with its message preserved and the false failure gone;
 *   (b) a pending run reclaimed as "machine offline" (behavior unchanged — no live
 *       token, so nothing to reconcile);
 *   (c) a long (>20min) run with a FRESH heartbeat survives the sweep.
 * Plus: a late FAILURE report records the real error honestly, and only ONE late
 * report is honored (single-shot).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-sleep-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

/** A recording notifier: captures every push instead of hitting a channel. */
function recordingNotify() {
  const sent: Array<{ loopId: string; message: string }> = [];
  const fn = (loop: any, message: string): Promise<void> => {
    sent.push({ loopId: loop.id, message });
    return Promise.resolve();
  };
  return { sent, fn };
}

function gateway(notify?: (loop: any, message: string) => Promise<void>) {
  return new gatewayMod.MachineGateway(
    {
      maybeFlagEvolve(): void {},
      finishEvolution(): void {},
      finishEdit(): void {},
      addLoop(): void {},
      removeLoop(): void {},
      runNow(): void {},
    } as any,
    undefined,
    notify,
  );
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

/** Seed an online machine (with a backdated last poll) + a loop. */
async function seedMachineLoop(lastSeenAgoMs: number) {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "Laptop", tokenHash: tokens.sha256(token), online: true }));
  (await store.updateMachine(machineId, { lastSeen: isoAgo(lastSeenAgoMs) }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  return { machineId, loop };
}

test("(a) a running run reclaimed while asleep is reconciled to done by the late wake-report — message preserved", async () => {
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);
  // Laptop slept mid-run: no heartbeat for 21 min, run was claimed 21 min ago.
  const { machineId, loop } = (await seedMachineLoop(21 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  // Sweep reclaims the stuck run and pushes the (soft) offline alert.
  (await gw.sweep());
  const swept = (await store.getRun(run.id))!;
  expect(swept.phase).toBe("error");
  expect(swept.error).toBe("machine timed out / disconnected");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toMatch(/asleep|interrupted/i);
  // The lease was NOT retired (terminalized to grace for the wake-report) — it still
  // resolves, now in terminal-grace.
  expect(tokens.resolveLease(rt)?.state).toBe("terminal-grace");

  // Laptop wakes: claude finished successfully, daemon reports late.
  const res = (await gw.report(rt, { ok: true, durationMs: 1234, sessionId: "sess-1", finalText: "opened PR #42" }));
  expect(res.status).toBe(200);
  const final = (await store.getRun(run.id))!;
  expect(final.phase).toBe("done");
  expect(final.error).toBeNull();
  expect(final.message).toBe("opened PR #42");
  expect(final.durationMs).toBe(1234);
  // The false failure no longer counts against the streak (derived from rows).
  expect((await store.execFailureStreak(loop.id))).toBe(0);
  // A retraction push carried the real result.
  expect(sent).toHaveLength(2);
  expect(sent[1]!.message).toBe("opened PR #42");
  // Single-shot: the lease is now retired — a second late report is rejected.
  expect(tokens.resolveLease(rt)).toBeUndefined();
  expect((await gw.report(rt, { ok: true, finalText: "again" })).status).toBe(401);
});

test("(a') a late FAILURE report records the real error honestly, without a second push", async () => {
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);
  const { machineId, loop } = (await seedMachineLoop(21 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  (await gw.sweep());
  expect(sent).toHaveLength(1); // the reclaim alert
  const res = (await gw.report(rt, { ok: false, error: "claude reported an error" }));
  expect(res.status).toBe(200);
  const final = (await store.getRun(run.id))!;
  expect(final.phase).toBe("error");
  expect(final.error).toBe("claude reported an error"); // real reason replaces the generic reclaim reason
  // No double-alert: the reclaim already notified once for this run.
  expect(sent).toHaveLength(1);
});

test("(a'') a successful late reconcile advances loop.state and mirrors the scalar cursor onto run.state", async () => {
  const gw = gateway(() => Promise.resolve());
  const { machineId, loop } = (await seedMachineLoop(21 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("error");

  // A workflow-style run wakes and reports success with a cursor.
  const res = (await gw.report(rt, { ok: true, message: "sweep done", cursor: { processed: 7, sha: "abc123" } }));
  expect(res.status).toBe(200);
  // The workflow cursor advanced loop.state (next run's `prev` binding).
  expect((await store.getLoop(loop.id))!.state).toEqual({ processed: 7, sha: "abc123" });
  // The scalar cursor is mirrored onto run.state for {{latest.*}} / the trend chart.
  expect((await store.getRun(run.id))!.state).toEqual({ processed: 7, sha: "abc123" });
});

test("(a''') a FAILED late reconcile does NOT advance loop.state (no reprocess/skip hazard)", async () => {
  const gw = gateway(() => Promise.resolve());
  const { machineId, loop } = (await seedMachineLoop(21 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  (await gw.sweep());
  const res = (await gw.report(rt, { ok: false, error: "workflow blew up", cursor: { processed: 7 } }));
  expect(res.status).toBe(200);
  expect((await store.getRun(run.id))!.phase).toBe("error");
  // A failed run must never advance the cursor — same as the normal path.
  expect((await store.getLoop(loop.id))!.state ?? null).toBeNull();
  expect((await store.getRun(run.id))!.state ?? null).toBeNull();
});

test("(b) a pending run reclaimed as machine-offline is unchanged (no live token to reconcile)", async () => {
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);
  // Machine last polled 2 min ago (offline), pending run 2 min old.
  const { machineId, loop } = (await seedMachineLoop(2 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: isoAgo(2 * MIN) }));

  (await gw.sweep());
  const swept = (await store.getRun(run.id))!;
  expect(swept.phase).toBe("error");
  expect(swept.error).toBe("machine offline");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toMatch(/asleep|skipped/i);
  // The machine itself was flipped offline by the sweep.
  expect((await store.getMachine(machineId))!.online).toBe(false);
});

test("(c) a long-running run with a fresh heartbeat survives the sweep", async () => {
  const gw = gateway();
  const { machineId, loop } = (await seedMachineLoop(5_000)); // machine polled 5s ago (online)
  // Claimed 30 min ago, but progress stamped 10s ago — still actively working.
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(30 * MIN) }));
  (await store.updateRun(run.id, { progress: { step: 5, label: "editing", at: isoAgo(10_000) } }));

  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("running"); // inactivity timeout keyed off the fresh stamp
});

test("agent-api verbs are refused for a reclaimed run (only the final report reconciles)", async () => {
  const gw = gateway(() => Promise.resolve());
  const { machineId, loop } = (await seedMachineLoop(21 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  (await gw.sweep());
  const out = (await gw.agentApi(rt, ["reschedule", "1h"]));
  expect(out.status).toBe(409);
  expect(String((out.body as any).text)).toMatch(/reclaimed/i);
});
