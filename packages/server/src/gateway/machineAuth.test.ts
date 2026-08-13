import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let tokens: typeof import("./tokens.js");
let authn: typeof import("./machineAuth.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-machine-auth-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  db = await import("../db/index.js"); await db.runMigrations();
  store = await import("../db/store.js"); tokens = await import("./tokens.js"); authn = await import("./machineAuth.js");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(async () => { await (db.client as any).exec("DELETE FROM machines"); });

test("mk_ resolution requires stable id plus matching secret and distinguishes genuine revoked holder", async () => {
  const id = "m-stable"; const key = tokens.mintMachineKey();
  await store.createMachine({ id, userId: "u1", enrolledBy: "u1", name: "M", tokenHash: tokens.sha256(key), online: false });
  expect((await authn.authenticateMachineCredential(tokens.presentedMachineCredential(id, key))).kind).toBe("ok");
  expect((await authn.authenticateMachineCredential(tokens.presentedMachineCredential(id, tokens.mintMachineKey()))).kind).toBe("invalid");
  expect((await authn.authenticateMachineCredential(tokens.presentedMachineCredential("m-missing", key))).kind).toBe("invalid");
  await store.updateMachine(id, { revokedAt: new Date().toISOString() });
  expect((await authn.authenticateMachineCredential(tokens.presentedMachineCredential(id, key))).kind).toBe("revoked");
});
