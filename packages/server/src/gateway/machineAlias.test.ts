/**
 * Machine ALIAS (kernel remote dispatch, P0 stage A): the enroll path mints a
 * team-unique alias from the daemon-reported handle (suffixing collisions, never
 * re-suffixing a live alias on later polls), and `findMachineByAlias` resolves a
 * kernel assignee's machine segment (`mbp` in `mbp/claude`) to the machines row
 * within a team - falling back to the friendly `name` for pre-alias rows.
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

test("findMachineByAlias resolves within the team, falls back to name, misses cleanly", async () => {
  const gw = gateway();
  const a = await enroll(gw, "mbp");
  expect((await store.findMachineByAlias(a.teamId, "mbp"))?.id).toBe(a.machineId);

  // Pre-alias row (older daemon): null alias but a friendly name still resolves.
  await store.updateMachine(a.machineId, { alias: null as unknown as string, name: "legacy-box" });
  expect((await store.findMachineByAlias(a.teamId, "legacy-box"))?.id).toBe(a.machineId);

  // Unknown handle = undefined (the caller defers the run, never throws).
  expect(await store.findMachineByAlias(a.teamId, "ghost")).toBeUndefined();
});
