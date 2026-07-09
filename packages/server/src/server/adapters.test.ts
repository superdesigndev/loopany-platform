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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adscaile-adapters-"));
  process.env.ADSCAILE_DATA_DIR = tmp;
  process.env.ADSCAILE_DB_PATH = path.join(tmp, "test.db");
  process.env.ADSCAILE_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  adapters = await import("./adapters.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as { exec(q: string): Promise<unknown> }).exec("DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

async function seed(agent: "claude-code" | "codex") {
  await store.createMachine({ id: "m-a", userId: "u1", name: "M", tokenHash: "h", online: true });
  return store.createLoop({
    userId: "u1",
    machineId: "m-a",
    name: "L",
    cron: "0 8 * * *",
    taskFile: "adscaile/x/README.md",
    workdir: "/tmp/p",
    agent,
    enabled: true,
    notify: "auto",
  });
}

test("an exec loop's recorded agent maps onto executor, JobFull.agent, and the kind chip", async () => {
  const loop = await seed("codex");
  const detail = await adapters.toJobDetail(loop);
  expect(detail.job.exec!.executor).toBe("codex");
  expect(detail.job.agent).toBe("codex");
  expect(detail.summary.kind).toBe("exec:codex");
});

test("a claude-code loop maps to exec:claude-code (no longer the hardcoded \"claude\")", async () => {
  const loop = await seed("claude-code");
  const detail = await adapters.toJobDetail(loop);
  expect(detail.job.exec!.executor).toBe("claude-code");
  expect(detail.job.agent).toBe("claude-code");
  expect(detail.summary.kind).toBe("exec:claude-code");
});

test("goal / completion stamps surface on JobSummary and JobFull (+ isCompleted split)", async () => {
  const { isCompleted, isClosed } = await import("../lib/format.js");
  await store.createMachine({ id: "m-a", userId: "u1", name: "M", tokenHash: "h", online: true });

  // Open loop (no goal): not closed, not completed.
  const open = await store.createLoop({ userId: "u1", machineId: "m-a", name: "Open", cron: "0 8 * * *", taskFile: "adscaile/x/README.md", enabled: true, notify: "auto" });
  const openSum = await adapters.toJobSummary(open);
  expect(openSum.goal).toBeNull();
  expect(openSum.completedAt).toBeNull();
  expect(isClosed(openSum)).toBe(false);
  expect(isCompleted(openSum)).toBe(false);

  // Closed active loop (goal, no completion): closed, not completed.
  const closed = await store.createLoop({ userId: "u1", machineId: "m-a", name: "Closed", cron: "0 8 * * *", taskFile: "adscaile/x/README.md", goal: "reach 100 signups", enabled: true, notify: "auto" });
  const closedSum = await adapters.toJobSummary(closed);
  expect(closedSum.goal).toBe("reach 100 signups");
  expect(isClosed(closedSum)).toBe(true);
  expect(isCompleted(closedSum)).toBe(false);
  expect((await adapters.toJobDetail(closed)).job.goal).toBe("reach 100 signups");

  // Completed loop: completedAt set → isCompleted true (regardless of last run status).
  const doneLoop = await store.createLoop({
    userId: "u1", machineId: "m-a", name: "Done", cron: "0 8 * * *", taskFile: "adscaile/x/README.md",
    goal: "ship v1", completedAt: "2026-07-01T00:00:00Z", completionReason: "v1 shipped", enabled: false, notify: "auto",
  });
  const doneSum = await adapters.toJobSummary(doneLoop);
  expect(doneSum.completedAt).toBe("2026-07-01T00:00:00Z");
  expect(doneSum.completionReason).toBe("v1 shipped");
  expect(isCompleted(doneSum)).toBe(true);
});

test("a workflow loop keeps the workflow kind regardless of recorded agent", async () => {
  await store.createMachine({ id: "m-a", userId: "u1", name: "M", tokenHash: "h", online: true });
  const loop = await store.createLoop({
    userId: "u1",
    machineId: "m-a",
    name: "W",
    cron: "0 8 * * *",
    workflow: "return { message: 'hi' }",
    agent: "codex",
    enabled: true,
    notify: "auto",
  });
  expect((await adapters.toJobSummary(loop)).kind).toBe("workflow");
});
