/**
 * Phase-1 task-tree storage foundation: nullable cron (a "loop" is a task with
 * cron set), the loops.taskMeta index derived at the taskFileContent ingress
 * chokepoint (store.updateLoop/createLoop), the sync-path task-file mirror, and
 * the done/archived-pauses-the-schedule invariant (gateway-owned — it holds the
 * scheduler). Mirrors index.test.ts's bootstrap (pglite in a temp dir, async store).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let syncMod: typeof import("./sync.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-taskmeta-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  syncMod = await import("./sync.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec(
    "DELETE FROM run_leases; DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Recording scheduler stub: captures runNow/removeLoop so tests observe the
 *  gateway's scheduler side effects without a real croner engine. */
function recordingScheduler() {
  const calls = { runNow: [] as string[], removeLoop: [] as string[], addLoop: [] as string[] };
  const scheduler = {
    maybeFlagEvolve(): void {},
    finishEvolution(): void {},
    finishEdit(): void {},
    addLoop(loop: { id: string }): void {
      calls.addLoop.push(loop.id);
    },
    removeLoop(id: string): void {
      calls.removeLoop.push(id);
    },
    runNow(id: string): void {
      calls.runNow.push(id);
    },
  };
  return { calls, scheduler };
}

function gateway(scheduler: object = recordingScheduler().scheduler) {
  return new gatewayMod.MachineGateway(scheduler as never, undefined);
}

/** An ArtifactSync wired to the gateway's task-file ingest chokepoint (mirrors
 *  boot: sync mirrors task-file bytes from the manifest and hands them to
 *  gateway.ingestTaskFileContent, which derives taskMeta + applies the pause rule). */
function syncFor(gw: ReturnType<typeof gateway>) {
  return new syncMod.ArtifactSync(undefined, (id, c) => gw.ingestTaskFileContent(id, c));
}

/** Sync one inline text file at `relPath` through ArtifactSync (the sole task-file
 *  ingress now that the `taskFile` wire field is gone). */
function syncFile(art: InstanceType<typeof syncMod.ArtifactSync>, token: string, loopId: string, relPath: string, content: string) {
  const hash = sha256(content);
  return art.sync(token, {
    loopId,
    manifest: [{ path: relPath, hash, size: content.length }],
    blobs: [{ hash, encoding: "base64", data: Buffer.from(content).toString("base64") }],
  });
}

async function seededMachine() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  return { token, machineId };
}

const TASK_README = (status: string) =>
  [
    "---",
    "id: cheap-geo-ppp",
    "title: Cheap geo PPP pricing",
    "type: experiment",
    `status: ${status}`,
    "priority: P2",
    "parent: monetization",
    "---",
    "",
    "## Spec",
    "Try PPP pricing for cheap geos.",
    "",
    "## Timeline",
  ].join("\n");

// ---- store chokepoint ----

test("store.updateLoop derives taskMeta whenever taskFileContent lands (and clears on null)", async () => {
  const { machineId } = await seededMachine();
  const loop = await store.createLoop({ userId: "u1", machineId, cron: "0 8 * * *", enabled: true, notify: "auto" });
  expect(loop.taskMeta).toBeFalsy();

  const updated = await store.updateLoop(loop.id, { taskFileContent: TASK_README("todo") });
  expect(updated!.taskMeta).toMatchObject({ id: "cheap-geo-ppp", status: "todo", priority: "P2", parent: "monetization" });

  const cleared = await store.updateLoop(loop.id, { taskFileContent: null });
  expect(cleared!.taskMeta).toBeNull();
});

test("store.createLoop derives taskMeta from inline taskFileContent", async () => {
  const { machineId } = await seededMachine();
  const loop = await store.createLoop({
    userId: "u1",
    machineId,
    cron: null,
    enabled: true,
    notify: "auto",
    taskFileContent: TASK_README("idea"),
  });
  expect(loop.cron).toBeNull();
  expect(loop.taskMeta).toMatchObject({ id: "cheap-geo-ppp", status: "idea", type: "experiment" });
});

// ---- gateway createLoop: cron optional ----

test("createLoop without cron creates an inert task (taskFile required, no immediate run)", async () => {
  const { token } = await seededMachine();
  const { calls, scheduler } = recordingScheduler();
  const gw = gateway(scheduler);

  // No cron AND no taskFile → teaching 400.
  const rejected = await gw.createLoop(token, { name: "T" });
  expect(rejected.status).toBe(400);
  expect((rejected.body as { error: string }).error).toMatch(/taskFile/);

  const ok = await gw.createLoop(token, {
    name: "Cheap geo PPP",
    taskFile: "/home/u/loopany/cheap-geo-ppp/README.md",
    taskFileContent: TASK_README("idea"),
  });
  expect(ok.status).toBe(200);
  const id = (ok.body as { id: string }).id;
  const loop = (await store.getLoop(id))!;
  expect(loop.cron).toBeNull();
  expect(loop.taskMeta).toMatchObject({ id: "cheap-geo-ppp", status: "idea" });
  // Creating an inert task must NOT spawn an exec run.
  expect(calls.runNow).toEqual([]);
});

test("createLoop with a cron still validates it and runs immediately", async () => {
  const { token } = await seededMachine();
  const { calls, scheduler } = recordingScheduler();
  const gw = gateway(scheduler);

  const bad = await gw.createLoop(token, { cron: "not a cron", taskFile: "x/README.md" });
  expect(bad.status).toBe(400);

  const ok = await gw.createLoop(token, { cron: "0 8 * * *", taskFile: "x/README.md" });
  expect(ok.status).toBe(200);
  expect(calls.runNow).toHaveLength(1);
});

test("createLoop dry-run without cron previews with empty nextRuns", async () => {
  const { token } = await seededMachine();
  const res = await gateway().createLoop(token, { taskFile: "x/README.md", dryRun: true });
  expect(res.status).toBe(200);
  const body = res.body as { dryRun: boolean; nextRuns: string[]; config: { cron: string | null } };
  expect(body.dryRun).toBe(true);
  expect(body.nextRuns).toEqual([]);
  expect(body.config.cron).toBeNull();
});

// ---- gateway editLoop: cron null = disarm ----

test("editLoop accepts cron:null as an explicit disarm; empty string still rejects", async () => {
  const { token, machineId } = await seededMachine();
  const loop = await store.createLoop({ userId: "u1", machineId, cron: "0 8 * * *", enabled: true, notify: "auto" });
  const gw = gateway();

  const empty = await gw.editLoop(token, loop.id, { cron: "" });
  expect(empty.status).toBe(400);
  expect((empty.body as { error: string }).error).toMatch(/cron: null/);

  const disarm = await gw.editLoop(token, loop.id, { cron: null });
  expect(disarm.status).toBe(200);
  expect((await store.getLoop(loop.id))!.cron).toBeNull();
});

// ---- sync-path task-file ingestion ----

test("sync ingests a matching task file and ignores a non-task-file path", async () => {
  const { token, machineId } = await seededMachine();
  const loop = await store.createLoop({
    userId: "u1",
    machineId,
    cron: null,
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/cheap-geo-ppp/README.md",
  });
  const gw = gateway();
  const art = syncFor(gw);

  // A synced file that is NOT the loop's task file (basename mismatch) → not mirrored.
  const ignored = await syncFile(art, token, loop.id, "notes.md", TASK_README("todo"));
  expect(ignored.status).toBe(200);
  expect((await store.getLoop(loop.id))!.taskFileContent).toBeNull();

  // The task file (basename match) → mirrored + indexed.
  const ok = await syncFile(art, token, loop.id, "README.md", TASK_README("in-progress"));
  expect(ok.status).toBe(200);
  const after = (await store.getLoop(loop.id))!;
  expect(after.taskFileContent).toContain("cheap-geo-ppp");
  expect(after.taskMeta).toMatchObject({ status: "in-progress" });
  expect(after.taskFileSyncedAt).toBeTruthy();
});

// ---- done/archived pauses the schedule ----

test("a task file marked done pauses a recurring loop (enabled=false + unscheduled)", async () => {
  const { token, machineId } = await seededMachine();
  const { calls, scheduler } = recordingScheduler();
  const loop = await store.createLoop({
    userId: "u1",
    machineId,
    cron: "0 8 * * *",
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/cheap-geo-ppp/README.md",
  });
  const gw = gateway(scheduler);
  const art = syncFor(gw);

  await syncFile(art, token, loop.id, "README.md", TASK_README("done"));
  const after = (await store.getLoop(loop.id))!;
  expect(after.enabled).toBe(false);
  expect(calls.removeLoop).toContain(loop.id);
});

test("a non-terminal status change does NOT pause the loop", async () => {
  const { token, machineId } = await seededMachine();
  const { calls, scheduler } = recordingScheduler();
  const loop = await store.createLoop({
    userId: "u1",
    machineId,
    cron: "0 8 * * *",
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/cheap-geo-ppp/README.md",
  });
  const gw = gateway(scheduler);
  const art = syncFor(gw);

  await syncFile(art, token, loop.id, "README.md", TASK_README("review"));
  expect((await store.getLoop(loop.id))!.enabled).toBe(true);
  expect(calls.removeLoop).toEqual([]);
});

test("report's taskFileContent path also derives taskMeta and applies the pause rule", async () => {
  const { machineId } = await seededMachine();
  const loop = await store.createLoop({
    userId: "u1",
    machineId,
    cron: "0 8 * * *",
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/cheap-geo-ppp/README.md",
  });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  const { calls, scheduler } = recordingScheduler();
  const gw = gateway(scheduler);

  const res = await gw.report(rt, { ok: true, taskFileContent: TASK_README("archived") });
  expect(res.status).toBe(200);
  const after = (await store.getLoop(loop.id))!;
  expect(after.taskMeta).toMatchObject({ status: "archived" });
  expect(after.enabled).toBe(false);
  expect(calls.removeLoop).toContain(loop.id);
});
