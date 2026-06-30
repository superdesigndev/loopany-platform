/**
 * Adapter mapping for the recorded coding agent: the stored `loops.agent` must
 * surface (read-only) onto the UI shapes — `JobFull.exec.executor`, `JobFull.agent`,
 * and the `JobSummary.kind` chip — instead of the old hardcoded "claude".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let adapters: typeof import("./adapters.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-adapters-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  db.runMigrations();
  store = await import("../db/store.js");
  adapters = await import("./adapters.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.sqlite.exec("DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function seed(agent: "claude-code" | "codex") {
  store.createMachine({ id: "m-a", userId: "u1", name: "M", tokenHash: "h", online: true });
  return store.createLoop({
    userId: "u1",
    machineId: "m-a",
    name: "L",
    cron: "0 8 * * *",
    task: "x",
    workdir: "/tmp/p",
    agent,
    enabled: true,
    notify: "auto",
  });
}

test("an exec loop's recorded agent maps onto executor, JobFull.agent, and the kind chip", () => {
  const loop = seed("codex");
  const detail = adapters.toJobDetail(loop);
  expect(detail.job.exec!.executor).toBe("codex");
  expect(detail.job.agent).toBe("codex");
  expect(detail.summary.kind).toBe("exec:codex");
});

test("a claude-code loop maps to exec:claude-code (no longer the hardcoded \"claude\")", () => {
  const loop = seed("claude-code");
  const detail = adapters.toJobDetail(loop);
  expect(detail.job.exec!.executor).toBe("claude-code");
  expect(detail.job.agent).toBe("claude-code");
  expect(detail.summary.kind).toBe("exec:claude-code");
});

test("a workflow loop keeps the workflow kind regardless of recorded agent", () => {
  store.createMachine({ id: "m-a", userId: "u1", name: "M", tokenHash: "h", online: true });
  const loop = store.createLoop({
    userId: "u1",
    machineId: "m-a",
    name: "W",
    cron: "0 8 * * *",
    workflow: "return { message: 'hi' }",
    agent: "codex",
    enabled: true,
    notify: "auto",
  });
  expect(adapters.toJobSummary(loop).kind).toBe("workflow");
});
