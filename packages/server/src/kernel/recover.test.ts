/**
 * KERNEL RUN RECOVERY: every claimed kernel run settles. Detector 1 (orphan
 * reconcile off the poll's kernelInFlight report), detector 2 (offline-machine
 * reclaim in the sweep), the run-finish lease consummation (a finished run's
 * rk_ dies), and the terminal-grace 409 guard on the credential bridge.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Provenance } from "@loopany/kernel";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let kstore: typeof import("./store.js");
let kgateway: typeof import("./gateway.js");
let recover: typeof import("./recover.js");
let sweep: typeof import("./sweep.js");
let tokens: typeof import("../gateway/tokens.js");
let gatewayMod: typeof import("../gateway/index.js");

const OWNER: Provenance = { entrance: "human", actorId: "u1" };
const T0 = "2026-09-07T06:00:00.000Z";
const T1 = "2026-09-07T07:00:01.000Z";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-krecover-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  kstore = await import("./store.js");
  kgateway = await import("./gateway.js");
  recover = await import("./recover.js");
  sweep = await import("./sweep.js");
  tokens = await import("../gateway/tokens.js");
  gatewayMod = await import("../gateway/index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec(
    "DELETE FROM kernel_runs; DELETE FROM kernel_triggers; DELETE FROM kernel_events; DELETE FROM kernel_objects; " +
      "DELETE FROM machine_team_aliases; DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

function gateway() {
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
  );
}

/** Stage A-C pipeline: enroll mbp, seed the weekly loop, sweep, poll — the
 *  delivered (claimed) kernel run + its machinery. */
async function deliveredRun(
  taskId = "seo-bet-manager",
  reuse?: { gw: ReturnType<typeof gateway>; deviceToken: string },
) {
  const gw = reuse?.gw ?? gateway();
  const deviceToken = reuse?.deviceToken ?? tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  const teamId = store.teamIdForUser("u1");
  await store.ensureTeam(teamId, "u1's team", "u1");
  await tokens.rememberConnectKey(deviceToken, { userId: "u1", teamId });
  await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp" });

  const { decide } = await import("@loopany/kernel");
  const d = decide(
    { op: "create", title: "seo bet manager", id: taskId, cron: "0 7 * * 1", timezone: "UTC", status: "in-progress", assignee: "mbp/claude" },
    await kstore.readSnapshot(teamId),
    OWNER,
    T0,
  );
  if (!d.ok) throw new Error(d.refusal.message);
  await kstore.applyChangesetForTeam(teamId, d.changeset);
  await sweep.kernelSweep(T1, () => {});
  const res = await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp" });
  const kr = (res.body as { kernelRuns: Array<{ runId: string; runToken: string }> }).kernelRuns[0]!;
  return { gw, deviceToken, machineId, teamId, runId: kr.runId, rk: kr.runToken };
}

async function runState(teamId: string, runId: string) {
  const snap = await kstore.readSnapshot(teamId);
  return snap.runs.find((r) => r.id === runId)?.state;
}

test("orphan reconcile: a poll reporting kernelInFlight WITHOUT the claimed run reclaims it as failed", async () => {
  const { gw, deviceToken, teamId, runId, rk } = await deliveredRun();
  expect(await runState(teamId, runId)).toBe("running");

  // Within the claim grace nothing happens (claim-in-transit protection).
  await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp", kernelInFlight: [] } as any);
  expect(await runState(teamId, runId)).toBe("running");

  // Past the grace, an empty report means the daemon lost the run: reclaimed.
  const past = Date.now() + recover.CLAIM_REPORT_GRACE_MS + 1000;
  await recover.reconcileKernelInFlight((await tokens.kernelLeases())[0]!.machineId, [], past);
  expect(await runState(teamId, runId)).toBe("failed");
  // The lease is gone: the stale rk_ gets a flat 401.
  const late = await kgateway.kernelCli(rk, { command: { op: "run-finish", runId, outcome: "done" } });
  expect(late.status).toBe(401);
});

test("orphan reconcile leaves a REPORTED run alone even past the grace", async () => {
  const { teamId, machineId, runId } = await deliveredRun();
  const past = Date.now() + recover.CLAIM_REPORT_GRACE_MS + 1000;
  await recover.reconcileKernelInFlight(machineId, [runId], past);
  expect(await runState(teamId, runId)).toBe("running");
});

test("offline reclaim: a machine silent past the window has its claimed kernel runs reclaimed", async () => {
  const { gw, deviceToken, teamId, machineId, runId } = await deliveredRun();

  // Backdate BOTH the machine's lastSeen and the lease's claim time.
  const old = new Date(Date.now() - 7 * 3600_000).toISOString();
  await (db.client as any).exec(`UPDATE machines SET last_seen = '${old}' WHERE id = '${machineId}'`);
  await (db.client as any).exec(`UPDATE run_leases SET created_at = '${old}'`);

  const n = await recover.sweepOfflineKernelRuns();
  expect(n).toBe(1);
  expect(await runState(teamId, runId)).toBe("failed");
  expect(await tokens.kernelLeases()).toHaveLength(0);

  // An ONLINE machine (fresh lastSeen, re-stamped by the poll) is never swept.
  const again = await deliveredRun("seo-bet-manager-2", { gw, deviceToken });
  await (db.client as any).exec(`UPDATE run_leases SET created_at = '${old}'`);
  expect(await recover.sweepOfflineKernelRuns()).toBe(0);
  expect(await runState(again.teamId, again.runId)).toBe("running");
});

test("a successful run-finish RETIRES the lease: the rk_ is single-shot", async () => {
  const { teamId, runId, rk } = await deliveredRun();
  // Real-flow shape: the agent leaves evidence before the daemon reports done
  // (a zero-evidence done would be rewritten failed by the postcondition).
  await kgateway.kernelCli(rk, { command: { op: "note", id: "seo-bet-manager", note: "W1 pass" } });
  const finish = await kgateway.kernelCli(rk, {
    command: { op: "run-finish", runId, outcome: "done", note: "agent run completed" },
  });
  expect(finish.status).toBe(200);
  expect(await runState(teamId, runId)).toBe("done");
  // The credential is consumed: any further use is a flat 401.
  const after = await kgateway.kernelCli(rk, { command: { op: "note", id: "seo-bet-manager", note: "late" } });
  expect(after.status).toBe(401);
  expect(await tokens.kernelLeases()).toHaveLength(0);
});

test("a terminal-grace kernel lease refuses EVERYTHING with 409 (defense-in-depth)", async () => {
  const { runId, rk } = await deliveredRun();
  // Force the production terminalize path onto the kernel lease (targets by runId).
  await tokens.terminalizeLease(runId);
  for (const body of [
    { command: { op: "note", id: "seo-bet-manager", note: "x" } },
    { read: true },
    { command: { op: "run-finish", runId, outcome: "done" } },
  ]) {
    const res = await kgateway.kernelCli(rk, body as any);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("reclaimed");
  }
});
