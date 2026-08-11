/**
 * Machine ALIAS (P0 stage A + review rounds 2-3): enroll mints the machine
 * BASE handle (unique within its home team, DB-backed); the PER-TEAM alias
 * REGISTER (machine_team_aliases, review round 3) then gives every execution
 * team its own unique(team, alias) mapping, minted deterministically by
 * machine age and immutable afterwards - so a shared team where two members
 * both own a "mbp" resolves BOTH machines (mbp / mbp-2), never an ambiguous
 * permanently-pending run. resolveMachineByAlias is THE ONE resolver.
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

test("a SHARED team where two members' machines share a base handle resolves BOTH deterministically", async () => {
  const gw = gateway();
  // u1's machine (home team u1) takes base "mbp"; created FIRST.
  const a = await enroll(gw, "mbp");

  // u2's machine in u2's OWN home team also takes base "mbp" (no collision
  // there - home scopes are independent).
  const deviceToken2 = tokens.mintDeviceToken();
  const machine2 = tokens.machineIdFromToken(deviceToken2);
  const team2 = store.teamIdForUser("u2");
  await store.ensureTeam(team2, "u2's team", "u2");
  await tokens.rememberConnectKey(deviceToken2, { userId: "u2", teamId: team2 });
  expect((await gw.poll(deviceToken2, { host: "mbp.local", alias: "mbp" })).status).toBe(200);
  expect((await store.getMachine(machine2))?.alias).toBe("mbp");

  // The SHARED team's register mints per-team aliases deterministically by
  // machine age: the older machine keeps the base, the newer gets -2. BOTH are
  // addressable - no ambiguity, no permanently pending run.
  await store.ensureTeam("team-shared", "Shared", "u1");
  await store.addTeamMember("team-shared", "u2", "member");
  const first = await store.resolveMachineByAlias("team-shared", "mbp");
  expect(first.ambiguous).toBeUndefined();
  expect(first.machine?.id).toBe(a.machineId);
  const second = await store.resolveMachineByAlias("team-shared", "mbp-2");
  expect(second.machine?.id).toBe(machine2);

  // The register is IMMUTABLE + idempotent: re-resolution never re-suffixes.
  expect((await store.resolveMachineByAlias("team-shared", "mbp")).machine?.id).toBe(a.machineId);
  const register = await store.listTeamAliases("team-shared");
  expect(register.map((r) => r.alias).sort()).toEqual(["mbp", "mbp-2"]);

  // Each home team still resolves its own machine under the plain base.
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
