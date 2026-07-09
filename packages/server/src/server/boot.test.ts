/**
 * Boot smoke test — `ensureServer()` migrates + starts the scheduler once,
 * idempotently, against a temp DB. Proves the in-process backend comes up
 * without throwing (the headless analogue of `pnpm dev` booting the engine).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

let tmp: string;
let boot: typeof import("./boot.js");
let store: typeof import("../db/store.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adscaile-boot-"));
  process.env.ADSCAILE_DATA_DIR = tmp;
  process.env.ADSCAILE_DB_PATH = path.join(tmp, "boot.db");
  process.env.ADSCAILE_LOG_LEVEL = "silent";
  boot = await import("./boot.js");
  store = await import("../db/store.js");
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("ensureServer migrates + boots the scheduler, idempotently", async () => {
  const a = await boot.ensureServer();
  const b = await boot.ensureServer();
  expect(a).toBe(b); // single instance
  expect(a.scheduler).toBeDefined();
  // Migrations ran: the tables exist and are queryable.
  expect(await store.listLoops()).toEqual([]);
  expect(await store.listMachines()).toEqual([]);
});
