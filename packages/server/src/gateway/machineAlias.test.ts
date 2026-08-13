/**
 * Machine ALIAS (P0 stage A + review rounds 2-3): enroll mints the machine
 * BASE handle (unique within its home team, DB-backed); explicit Team Machine
 * Bindings give each authorized Team its own unique(team, alias) execution
 * address. Two members who both own a "mbp" therefore resolve as mbp / mbp-2.
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
    "DELETE FROM kernel_runs; DELETE FROM kernel_triggers; DELETE FROM kernel_events; DELETE FROM kernel_objects; " +
      "DELETE FROM team_machine_bindings; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
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
  let enrolledAlias = alias;
  for (let n = 2; await store.aliasTakenInTeam(teamId, enrolledAlias, machineId); n++) enrolledAlias = `${alias}-${n}`;
  await store.createMachine({ id: machineId, userId: "u1", teamId, name: host, alias: enrolledAlias, tokenHash: tokens.sha256(deviceToken), online: false });
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
  await store.createMachine({ id: machine2, userId: "u2", teamId: team2, name: "mbp.local", alias: "mbp", tokenHash: tokens.sha256(deviceToken2), online: false });
  expect((await gw.poll(deviceToken2, { host: "mbp.local", alias: "mbp" })).status).toBe(200);
  expect((await store.getMachine(machine2))?.alias).toBe("mbp");

  // The SHARED team's register mints per-team aliases deterministically by
  // machine age: the older machine keeps the base, the newer gets -2. BOTH are
  // addressable - no ambiguity, no permanently pending run.
  await store.ensureTeam("team-shared", "Shared", "u1");
  await store.addTeamMember("team-shared", "u2", "member");
  await store.bindMachineToTeam("team-shared", a.machineId, "u1");
  await store.bindMachineToTeam("team-shared", machine2, "u2");
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

test("MEMBER REVOCATION: a departed member's machine stops resolving, drops from discovery, and gets NO deliveries", async () => {
  const gw = gateway();
  // u2 joins u1's shared team with machine "wall".
  const deviceToken2 = tokens.mintDeviceToken();
  const machine2 = tokens.machineIdFromToken(deviceToken2);
  const team2 = store.teamIdForUser("u2");
  await store.ensureTeam(team2, "u2's team", "u2");
  await store.createMachine({ id: machine2, userId: "u2", teamId: team2, name: "wall.local", alias: "wall", tokenHash: tokens.sha256(deviceToken2), online: false });
  expect((await gw.poll(deviceToken2, { host: "wall.local", alias: "wall" })).status).toBe(200);

  await store.ensureTeam("team-wall", "Wall", "u1");
  await store.addTeamMember("team-wall", "u2", "member");
  await store.bindMachineToTeam("team-wall", machine2, "u2");
  // While a member: resolves + advertised in the register.
  expect((await store.resolveMachineByAlias("team-wall", "wall")).machine?.id).toBe(machine2);
  expect((await store.listTeamAliases("team-wall")).map((r) => r.alias)).toContain("wall");

  // A kernel loop in the shared team addresses u2's machine; the sweep mints a
  // pending run for it.
  const { decide } = await import("@loopany/kernel");
  const kstore = await import("../kernel/store.js");
  const ksweep = await import("../kernel/sweep.js");
  const d = decide(
    { op: "create", title: "wall probe", id: "wall-probe", cron: "0 7 * * 1", timezone: "UTC", status: "in-progress", assignee: "wall/claude" },
    await kstore.readSnapshot("team-wall"),
    { entrance: "human", actorId: "u1" },
    "2026-09-07T06:00:00.000Z",
  );
  if (!d.ok) throw new Error(d.refusal.message);
  await kstore.applyChangesetForTeam("team-wall", d.changeset);
  await ksweep.kernelSweep("2026-09-07T07:00:01.000Z", () => {});
  expect((await kstore.readSnapshot("team-wall")).runs[0]?.state).toBe("pending");

  // u2 leaves. Resolution refuses, discovery drops the alias, and the pending
  // run is NOT delivered to the departed member's machine - it stays pending.
  expect(await store.removeTeamMemberGuarded("team-wall", "u2")).toBe("ok");
  expect((await store.resolveMachineByAlias("team-wall", "wall")).machine).toBeUndefined();
  expect((await store.listTeamAliases("team-wall")).map((r) => r.alias)).not.toContain("wall");
  const dispatch = await import("../kernel/dispatch.js");
  expect(await dispatch.kernelDeliveriesForMachine(machine2)).toEqual([]);
  expect((await kstore.readSnapshot("team-wall")).runs[0]?.state).toBe("pending");

  // The HOME team is unaffected, and the register row is RETAINED identity: a
  // re-join resolves the SAME alias again (a new machine can never steal it).
  expect((await store.resolveMachineByAlias(team2, "wall")).machine?.id).toBe(machine2);
  await store.addTeamMember("team-wall", "u2", "member");
  expect((await store.resolveMachineByAlias("team-wall", "wall")).machine?.id).toBe(machine2);
});

test("BINDING REVOCATION: membership alone cannot route work after the explicit binding is disabled", async () => {
  const gw = gateway();
  const enrolled = await enroll(gw, "private-mbp");
  await store.ensureTeam("team-client", "Client", "u-owner");
  await store.addTeamMember("team-client", "u1", "member");
  await store.bindMachineToTeam("team-client", enrolled.machineId, "u1");
  expect((await store.resolveMachineByAlias("team-client", "private-mbp")).machine?.id).toBe(enrolled.machineId);

  await store.setTeamMachineBindingEnabled("team-client", enrolled.machineId, false, "u1");
  expect(await store.isMachineBoundToTeam("team-client", enrolled.machineId)).toBe(false);
  expect((await store.listMachinesForTeam("team-client")).map((machine) => machine.id)).not.toContain(enrolled.machineId);
  expect((await store.resolveMachineByAlias("team-client", "private-mbp")).machine).toBeUndefined();
  expect((await store.listTeamAliases("team-client")).map((row) => row.machineId)).not.toContain(enrolled.machineId);

  // Membership remains intact: compute authorization, not team access, was revoked.
  expect(await store.isTeamMember("team-client", "u1")).toBe(true);
  // A Machine must remain available to its owner's personal Team.
  expect(await store.setTeamMachineBindingEnabled(enrolled.teamId, enrolled.machineId, false, "u1")).toBe(false);
  expect(await store.isMachineBoundToTeam(enrolled.teamId, enrolled.machineId)).toBe(true);
});

test("the (teamId, alias) unique index rejects a duplicate alias write in one home team", async () => {
  const gw = gateway();
  await enroll(gw, "mbp");
  const b = await enroll(gw, "solo", "solo.local");
  // Bypass the suffix probe and write the colliding alias directly: the DB refuses.
  await expect(store.updateMachine(b.machineId, { alias: "mbp" })).rejects.toThrow();
});
