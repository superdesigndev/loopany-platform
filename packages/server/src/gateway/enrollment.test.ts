/** Clean-cutover machine enrollment: poll never creates machine authority. */
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-enroll-"));
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
  await (db.client as any).exec("DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
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

// ---- gated mode: forged tokens are rejected (the audit's H-01 reproduction) ----

test("a forged bearer token cannot self-register via poll", async () => {
  const gw = gateway();
  const forged = "dk_unauthenticated_gated_repro"; // the audit's exact repro token
  const res = await gw.poll(forged, { host: "attacker-gated" });
  expect(res.status).toBe(401);
  // No machine row was minted.
  expect(await store.getMachine(tokens.machineIdFromToken(forged))).toBeUndefined();
});

test("a forged token cannot create a loop (no machine exists)", async () => {
  const gw = gateway();
  const forged = "dk_unauthenticated_gated_repro";
  // The daemon's first poll was rejected, so the machine never registered — and
  // createLoop already fails closed on an unknown machine.
  await gw.poll(forged, { host: "attacker-gated" });
  const res = await gw.createLoop(forged, { name: "gated-unauth-loop", cron: "0 8 * * *", workflow: "return { message: 1 };" });
  expect(res.status).toBe(401);
  expect((await store.listMachines()).length).toBe(0);
});

test("an explicitly enrolled machine polls but cannot use human loop-authoring authority", async () => {
  const gw = gateway();
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  await store.createMachine({
    id: machineId,
    enrolledBy: "u1",
    teamId: store.teamIdForUser("u1"),
    name: "owner-laptop",
    tokenHash: tokens.sha256(deviceToken),
    online: false,
  });
  const poll1 = await gw.poll(deviceToken, { host: "owner-laptop" });
  expect(poll1.status).toBe(200);
  const machine = await store.getMachine(machineId);
  expect(machine?.enrolledBy).toBe("u1");

  // Machine authority is execution-only. Loop authoring belongs to a human session.
  const created = await gw.createLoop(deviceToken, { name: "L", cron: "0 8 * * *", workflow: "return { message: 1 };" });
  expect(created.status).toBe(403);
  const loops = await store.loopsForMachine(machineId);
  expect(loops).toHaveLength(0);

  const poll2 = await gw.poll(deviceToken);
  expect(poll2.status).toBe(200);
});

test("an unknown well-shaped machine key does not enroll", async () => {
  const gw = gateway();
  const deviceToken = tokens.mintDeviceToken();
  const res = await gw.poll(deviceToken, { host: "late" });
  expect(res.status).toBe(401);
  expect(await store.getMachine(tokens.machineIdFromToken(deviceToken))).toBeUndefined();
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

test("open mode also refuses anonymous self-registration", async () => {
  const gw = gateway();
  const token = tokens.mintDeviceToken();
  const res = await gw.poll(token, { host: "dev-box" });
  expect(res.status).toBe(401);
  expect(await store.getMachine(tokens.machineIdFromToken(token))).toBeUndefined();
});

// ---- token-hash binding: a machine-id collision can't impersonate ----

test("a token whose id collides with a registered machine but whose hash differs is rejected", async () => {
  const gw = gateway();
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // A pre-existing machine on that id, but registered under a DIFFERENT token hash.
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "some-other-hash", online: true });
  const res = await gw.poll(token, { host: "x" });
  expect(res.status).toBe(401);
  expect((res.body as { error: string }).error).toBe("invalid_credential");
});
