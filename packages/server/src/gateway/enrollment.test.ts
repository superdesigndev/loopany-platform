/**
 * Machine ENROLLMENT hardening (audit H-01 / M2). The poll route is the ONE
 * surface that self-registers a machine on first contact; before this fix it
 * minted a "shared" machine for ANY bearer string even under the GitHub login
 * gate, letting an unauthenticated caller create unbounded machine/loop rows.
 *
 * These tests reproduce the audit's two curl calls (poll → loop) and assert they
 * are now REJECTED in gated mode, prove the legitimate connect-key flow still
 * registers + polls + creates a loop end to end, cover the `dk_` shape filter, and
 * pin that OPEN mode keeps its permissive anonymous self-registration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let cliMod: typeof import("./cli.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-enroll-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  cliMod = await import("./cli.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

/** Restore the gate env after every case so it can't leak between tests. */
afterEach(() => {
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
});

/** Turn the GitHub login gate ON for the current test (read live by poll). */
function enableGate(): void {
  process.env.GITHUB_CLIENT_ID = "gh-client-id";
  process.env.GITHUB_CLIENT_SECRET = "gh-client-secret";
}

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

function gateways() {
  const core = gateway();
  return { core, cli: new cliMod.CliGateway(core) };
}

// ---- gated mode: forged tokens are rejected (the audit's H-01 reproduction) ----

test("gated mode: a forged bearer token cannot self-register via poll", async () => {
  enableGate();
  const gw = gateway();
  const forged = "dk_unauthenticated_gated_repro"; // the audit's exact repro token
  const res = await gw.poll(forged, { host: "attacker-gated" });
  expect(res.status).toBe(401);
  // No machine row was minted.
  expect(await store.getMachine(tokens.machineIdFromToken(forged))).toBeUndefined();
});

test("gated mode: a forged token cannot create a loop (no machine exists)", async () => {
  enableGate();
  const gw = gateway();
  const forged = "dk_unauthenticated_gated_repro";
  // The daemon's first poll was rejected, so the machine never registered — and
  // createLoop already fails closed on an unknown machine.
  await gw.poll(forged, { host: "attacker-gated" });
  const res = await gw.createLoop(forged, { name: "gated-unauth-loop", cron: "0 8 * * *", workflow: "return { message: 1 };" });
  expect(res.status).toBe(401);
  expect((await store.listMachines()).length).toBe(0);
});

// ---- gated mode: the legitimate connect-key flow still works end to end ----

test("gated mode: a live connect-key registers, polls, and creates a loop", async () => {
  enableGate();
  const { core: gw, cli } = gateways();
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  // The owner ran the web/AI-First connect flow, binding this token to their team.
  await tokens.rememberConnectKey(deviceToken, { userId: "u1", teamId: store.teamIdForUser("u1") });

  // First poll self-registers under the remembered owner (not "shared").
  const poll1 = await gw.poll(deviceToken, { host: "owner-laptop" });
  expect(poll1.status).toBe(200);
  const machine = await store.getMachine(machineId);
  expect(machine?.userId).toBe("u1");

  // The daemon can then create a loop and keep polling.
  const created = await gw.createLoop(deviceToken, { name: "L", cron: "0 8 * * *", workflow: "return { message: 1 };" });
  expect(created.status).toBe(200);
  expect((created.body as { ok: boolean }).ok).toBe(true);
  const loops = await store.loopsForMachine(machineId);
  expect(loops.map((l) => l.name)).toContain("L");

  const poll2 = await gw.poll(deviceToken);
  expect(poll2.status).toBe(200);
  // The unified CLI and the daemon poll resolve the exact same enrolled
  // credential; neither is allowed to stop at a derived machine-id match.
  expect((await cli.cli(deviceToken, ["loops"])).status).toBe(200);
});

test("gated mode: poll and cli agree when a device credential is foreign", async () => {
  enableGate();
  const { core, cli } = gateways();
  const enrolled = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(enrolled, { userId: "u1", teamId: store.teamIdForUser("u1") });
  expect((await core.poll(enrolled)).status).toBe(200);

  const foreign = tokens.mintDeviceToken();
  expect((await core.poll(foreign)).status).toBe(401);
  expect((await cli.cli(foreign, ["loops"])).status).toBe(401);
});

test("a machine row written by the pre-383ba84 createMachine path still verifies", async () => {
  enableGate();
  const { core, cli } = gateways();
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);

  // Exact persisted shape from 383ba84^:machineFns.createMachine — both the
  // plaintext reconnect credential and its SHA-256 were stored on the row.
  await store.createMachine({
    id: machineId,
    userId: "u1",
    teamId: "team-u1",
    name: "",
    tokenHash: tokens.sha256(token),
    token,
    online: false,
  });

  expect((await core.poll(token)).status).toBe(200);
  expect((await cli.cli(token, ["loops"])).status).toBe(200);
  expect((await store.getMachine(machineId))?.tokenHash).toBe(tokens.sha256(token));
});

test("an exact stored device token repairs a stale redundant hash without widening identity", async () => {
  enableGate();
  const { core, cli } = gateways();
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: "stale-hash", token, online: false });

  expect((await core.poll(token)).status).toBe(200);
  expect((await cli.cli(token, ["loops"])).status).toBe(200);
  expect((await store.getMachine(machineId))?.tokenHash).toBe(tokens.sha256(token));
});

test("a legacy row with the raw credential in the hash slot is normalized on first use", async () => {
  enableGate();
  const { core, cli } = gateways();
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: token, token: tokens.sha256(token), online: false });

  expect((await core.poll(token)).status).toBe(200);
  expect((await cli.cli(token, ["task", "list"])).status).toBe(200);
  expect(await store.getMachine(machineId)).toMatchObject({ tokenHash: tokens.sha256(token), token });
});

test("gated mode: an EXPIRED connect-key does not enroll", async () => {
  enableGate();
  const gw = gateway();
  const deviceToken = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(deviceToken, { userId: "u1", teamId: store.teamIdForUser("u1") });
  // Age the key past its TTL.
  await (db.client as any).exec(
    `UPDATE connect_keys SET minted_at = '${new Date(Date.now() - tokens.CONNECT_KEY_TTL_MS - 1000).toISOString()}'`,
  );
  const res = await gw.poll(deviceToken, { host: "late" });
  expect(res.status).toBe(401);
  expect(await store.getMachine(tokens.machineIdFromToken(deviceToken))).toBeUndefined();
  expect((await new cliMod.CliGateway(gw).cli(deviceToken, ["loops"])).status).toBe(401);
});

// ---- dk_ shape validation (both modes) ----

test("malformed device tokens are rejected early with 401", async () => {
  const gw = gateway();
  for (const bad of ["", "no-prefix", "dk_", "dk_x", "Bearer dk_abc", "dk_has space"]) {
    const res = await gw.poll(bad);
    expect(res.status, `token ${JSON.stringify(bad)}`).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/invalid device token/);
  }
});

// ---- open mode: anonymous self-registration is preserved ----

test("open mode: an unknown dk_ token still self-registers into the shared workspace", async () => {
  // Gate OFF (default in tests) ⇒ open/dev mode keeps anonymous BYOA enrollment.
  const gw = gateway();
  const token = tokens.mintDeviceToken();
  const res = await gw.poll(token, { host: "dev-box" });
  expect(res.status).toBe(200);
  const machine = await store.getMachine(tokens.machineIdFromToken(token));
  expect(machine?.userId).toBe("shared");
});

// ---- token-hash binding: a machine-id collision can't impersonate ----

test("a token whose id collides with a registered machine but whose hash differs is rejected", async () => {
  const { core: gw, cli } = gateways();
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // A pre-existing machine on that id, but registered under a DIFFERENT token hash.
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "some-other-hash", online: true });
  const res = await gw.poll(token, { host: "x" });
  expect(res.status).toBe(401);
  expect((res.body as { error: string }).error).toMatch(/mismatch/);
  expect((await gw.pollWait(token, { host: "x" }, [], { wait: true, waitMs: 1 })).status).toBe(401);
  expect((await cli.cli(token, ["loops"])).status).toBe(401);
  // `home` keeps its non-error UX but must not disclose the collided row.
  const home = await cli.cli(token, ["home"]);
  expect(home.status).toBe(200);
  expect((home.body as { text: string }).text).toContain("not connected");
  expect((home.body as { text: string }).text).not.toContain("name: M");
});
