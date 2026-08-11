/**
 * KERNEL RUN DELIVERY (P0 stage C): a pending kernel run addressed to the
 * polling machine rides the poll body as `kernelRuns` - claimed atomically
 * (pending -> running, sessionId captured), CORE prompt server-built, rk_ lease
 * minted with the kernel team/task markers. A second poll never re-delivers; a
 * machine the assignee does NOT address gets nothing.
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
let sweep: typeof import("./sweep.js");
let tokens: typeof import("../gateway/tokens.js");
let gatewayMod: typeof import("../gateway/index.js");

const OWNER: Provenance = { entrance: "human", actorId: "u1" };
const T0 = "2026-09-07T06:00:00.000Z";
const T1 = "2026-09-07T07:00:01.000Z";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-kdispatch-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  kstore = await import("./store.js");
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
      "DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
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

async function seedLoop(teamId: string, assignee = "mbp/claude") {
  const { decide } = await import("@loopany/kernel");
  const d = decide(
    {
      op: "create",
      title: "seo bet manager",
      id: "seo-bet-manager",
      cron: "0 7 * * 1",
      timezone: "UTC",
      status: "in-progress",
      assignee,
      workdir: "/Users/u1/work/superdesign",
      owner: "u1@x.co",
    },
    await kstore.readSnapshot(teamId),
    OWNER,
    T0,
  );
  if (!d.ok) throw new Error(d.refusal.message);
  const applied = await kstore.applyChangesetForTeam(teamId, d.changeset);
  if (!applied.ok) throw new Error("seed apply conflict");
}

async function enroll(alias: string) {
  const gw = gateway();
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  const teamId = store.teamIdForUser("u1");
  await store.ensureTeam(teamId, "u1's team", "u1");
  await tokens.rememberConnectKey(deviceToken, { userId: "u1", teamId });
  const res = await gw.poll(deviceToken, { host: `${alias}.local`, alias });
  expect(res.status).toBe(200);
  return { gw, deviceToken, machineId, teamId };
}

test("a pending kernel run rides the poll as a claimed kernelRuns delivery, exactly once", async () => {
  const { gw, deviceToken, teamId } = await enroll("mbp");
  await seedLoop(teamId);
  await sweep.kernelSweep(T1, () => {});

  const res = await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp" });
  expect(res.status).toBe(200);
  const body = res.body as { kernelRuns?: Array<Record<string, unknown>> };
  expect(body.kernelRuns).toHaveLength(1);
  const kr = body.kernelRuns![0]!;
  expect(kr.taskId).toBe("seo-bet-manager");
  expect(kr.agent).toBe("claude");
  expect(kr.workdir).toBe("/Users/u1/work/superdesign");
  expect(String(kr.runToken)).toMatch(/^rk_/);
  // The server-built CORE prompt is the agent's whole first user turn.
  expect(String(kr.prompt)).toContain("[loop run · seo bet manager]");
  expect(String(kr.prompt)).toContain("SCENARIO — recurring loop (cron fire):");

  // The kernel run was CLAIMED: running, sessionId captured.
  const snap = await kstore.readSnapshot(teamId);
  expect(snap.runs[0]).toMatchObject({ state: "running", sessionId: `spawn-${kr.runId}` });

  // The lease carries the kernel markers (the stage-D bridge resolves scope from them).
  const lease = await tokens.resolveLease(String(kr.runToken));
  expect(lease).toMatchObject({ kernelTeamId: teamId, kernelTaskId: "seo-bet-manager" });

  // Second poll: nothing pending anymore - no duplicate delivery.
  const res2 = await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp" });
  expect((res2.body as { kernelRuns?: unknown[] }).kernelRuns).toBeUndefined();
});

test("a machine the assignee does not address never receives the run", async () => {
  const { gw, deviceToken, teamId } = await enroll("other-box");
  await seedLoop(teamId, "mbp/claude"); // addressed to mbp, not other-box
  await sweep.kernelSweep(T1, () => {});

  const res = await gw.poll(deviceToken, { host: "other-box.local", alias: "other-box" });
  expect((res.body as { kernelRuns?: unknown[] }).kernelRuns).toBeUndefined();
  // The run stays pending for the right machine (durable inbox).
  const snap = await kstore.readSnapshot(teamId);
  expect(snap.runs[0]?.state).toBe("pending");
});
