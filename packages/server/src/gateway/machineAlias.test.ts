/**
 * Machine ALIAS (kernel remote dispatch, P0 stage A + the 2026-08-11 hardening):
 * the enroll path mints a team-unique alias from the daemon-reported handle
 * (suffixing collisions, never re-suffixing a live alias on later polls; a
 * (teamId, alias) UNIQUE INDEX backs the probe at the DB level), and
 * `resolveMachineByAlias` - THE ONE resolver both the sweep wake and the poll
 * delivery use - resolves a kernel assignee's machine segment by ALIAS ONLY.
 * A shared-team ambiguity (same alias via two home teams) is a distinct
 * `ambiguous` result the callers refuse; the old friendly-name fallback is gone.
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-alias-"));
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
  await (db.client as any).exec(
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

/** Enroll one machine for owner u1 (personal team) reporting `alias`. */
async function enroll(gw: ReturnType<typeof gateway>, alias: string, host = "some-host") {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  const teamId = store.teamIdForUser("u1");
  await store.ensureTeam(teamId, "u1's team", "u1");
  await tokens.rememberConnectKey(deviceToken, { userId: "u1", teamId });
  const res = await gw.poll(deviceToken, { host, alias });
  expect(res.status).toBe(200);
  return { machineId, teamId, deviceToken };
}

test("enroll mints the reported alias; a collision suffixes -2; later polls never re-suffix", async () => {
  const gw = gateway();
  const a = await enroll(gw, "mbp", "mbp.local");
  expect((await store.getMachine(a.machineId))?.alias).toBe("mbp");

  // Second machine in the same team wanting the same handle gets mbp-2.
  const b = await enroll(gw, "mbp", "mbp-2.local");
  expect((await store.getMachine(b.machineId))?.alias).toBe("mbp-2");

  // A's next poll keeps its alias stable (no churn - kernel assignees point at it).
  await gw.poll(a.deviceToken, { host: "mbp.local", alias: "mbp" });
  expect((await store.getMachine(a.machineId))?.alias).toBe("mbp");
});

test("resolveMachineByAlias resolves by alias only, misses cleanly, and NEVER matches a name", async () => {
  const gw = gateway();
  const a = await enroll(gw, "mbp");
  expect((await store.resolveMachineByAlias(a.teamId, "mbp")).machine?.id).toBe(a.machineId);

  // The old friendly-name fallback is GONE: a null-alias row is unaddressable
  // until its next poll backfills an alias (enroll always does).
  await store.updateMachine(a.machineId, { alias: null as unknown as string, name: "legacy-box" });
  expect((await store.resolveMachineByAlias(a.teamId, "legacy-box")).machine).toBeUndefined();

  // Unknown handle = no machine, not ambiguous (the caller defers the run).
  const miss = await store.resolveMachineByAlias(a.teamId, "ghost");
  expect(miss.machine).toBeUndefined();
  expect(miss.ambiguous).toBeUndefined();
});

test("a SHARED team where two members' machines expose the same alias resolves as AMBIGUOUS", async () => {
  const gw = gateway();
  // u1's machine (home team u1) takes alias "mbp".
  const a = await enroll(gw, "mbp");

  // u2's machine in u2's OWN home team also takes "mbp" (no collision there -
  // per-home-team suffixing cannot see across teams).
  const deviceToken2 = tokens.mintDeviceToken();
  const machine2 = tokens.machineIdFromToken(deviceToken2);
  const team2 = store.teamIdForUser("u2");
  await store.ensureTeam(team2, "u2's team", "u2");
  await tokens.rememberConnectKey(deviceToken2, { userId: "u2", teamId: team2 });
  expect((await gw.poll(deviceToken2, { host: "mbp.local", alias: "mbp" })).status).toBe(200);
  expect((await store.getMachine(machine2))?.alias).toBe("mbp");

  // A shared team containing BOTH users now sees two "mbp" machines: the
  // resolver refuses with `ambiguous` instead of picking one arbitrarily.
  await store.ensureTeam("team-shared", "Shared", "u1");
  await store.addTeamMember("team-shared", "u2", "member");
  const r = await store.resolveMachineByAlias("team-shared", "mbp");
  expect(r.ambiguous).toBe(true);
  expect(r.machine).toBeUndefined();

  // Each home team still resolves its own machine unambiguously.
  expect((await store.resolveMachineByAlias(a.teamId, "mbp")).machine?.id).toBe(a.machineId);
  expect((await store.resolveMachineByAlias(team2, "mbp")).machine?.id).toBe(machine2);
});

test("the (teamId, alias) unique index rejects a duplicate alias write in one home team", async () => {
  const gw = gateway();
  await enroll(gw, "mbp");
  const b = await enroll(gw, "solo", "solo.local");
  // Bypass the suffix probe and write the colliding alias directly: the DB refuses.
  await expect(store.updateMachine(b.machineId, { alias: "mbp" })).rejects.toThrow();
});
