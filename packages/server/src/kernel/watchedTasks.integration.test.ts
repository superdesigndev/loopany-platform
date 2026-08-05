/**
 * Convergence S3 — the u16 watched-task warning on the PRODUCTION lifecycle.
 *
 * Design report §1.4 (retire-freeze row) + §5: the kernel loop's terminal
 * `retired` state retired with the loop kind, and what survives is the WARNING
 * it carried. Pause, closed-loop
 * finish and hard delete each stand a watcher down; each warns with the open
 * watched-task count, and none of them may block or cascade.
 *
 * The load-bearing negative is the last describe block: `store.deleteLoop` must
 * never grow an `objects` cascade. A dangling watcher is legal by design.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/schema.js");
let kernelSchema: typeof import("../db/kernel-schema.js");
let store: typeof import("../db/store.js");
let kernel: typeof import("./applyTransition.js");
let gatewayModule: typeof import("../gateway/index.js");
let cliModule: typeof import("../gateway/cli.js");
let tokens: typeof import("../gateway/tokens.js");
let watched: typeof import("./watchedTasks.js");
let adapters: typeof import("../server/adapters.js");

const TEAM = "team-w";
const USER = "u-w";
const TOKEN = "dk_watched_task_device_token";
const NOW = "2026-08-05T09:00:00.000Z";
const ACTOR = { entrance: "human", actorId: USER } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-watched-tasks-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/schema.js");
  kernelSchema = await import("../db/kernel-schema.js");
  store = await import("../db/store.js");
  kernel = await import("./applyTransition.js");
  gatewayModule = await import("../gateway/index.js");
  cliModule = await import("../gateway/cli.js");
  tokens = await import("../gateway/tokens.js");
  watched = await import("./watchedTasks.js");
  adapters = await import("../server/adapters.js");
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

beforeEach(async () => {
  await database.db.delete(schema.runLeases);
  await database.db.delete(kernelSchema.events);
  await database.db.delete(kernelSchema.objects);
  await database.db.delete(schema.runs);
  await database.db.delete(schema.loops);
  await database.db.delete(schema.machines);
});

function gateway() {
  const scheduler = {
    addLoop(): void {},
    removeLoop(): void {},
    async maybeFlagEvolve(): Promise<void> {},
    async finishEvolution(): Promise<void> {},
    async finishEdit(): Promise<void> {},
  } as never;
  return new gatewayModule.MachineGateway(scheduler);
}

/** The run-credential verb surface (`finish`) lives on CliGateway, over the same
 *  core — so this exercises the real dispatch, not the method in isolation. */
function cli() {
  return new cliModule.CliGateway(gateway());
}

async function seed(opts: { enabled?: boolean; goal?: string | null } = {}) {
  const machineId = tokens.machineIdFromToken(TOKEN);
  await store.createMachine({
    id: machineId,
    userId: USER,
    teamId: TEAM,
    name: "watched-host",
    tokenHash: tokens.sha256(TOKEN),
    online: true,
  });
  const loop = await store.createLoop({
    userId: USER,
    teamId: TEAM,
    machineId,
    name: "Watcher",
    cron: "0 7 * * *",
    enabled: opts.enabled ?? true,
    notify: "never",
    taskFile: "/tmp/watched-loop/task.md",
    ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
  });
  return { loop, machineId };
}

async function watchedTask(watcher: string, title = "Still open") {
  const made = await kernel.createObject({
    teamId: TEAM,
    kind: "task",
    actor: ACTOR,
    now: NOW,
    title,
    watcher,
  } as never);
  if (!made.ok) throw new Error(made.message);
  return made.object;
}

describe("the count", () => {
  it("counts only OPEN tasks of this team that name this loop", async () => {
    const { loop } = await seed();
    const other = await store.createLoop({ userId: USER, teamId: TEAM, machineId: loop.machineId, name: "Other", cron: "0 8 * * *" });
    await watchedTask(loop.id, "mine one");
    await watchedTask(loop.id, "mine two");
    await watchedTask(other.id, "not mine");
    const closed = await watchedTask(loop.id, "already done");
    const shut = await kernel.applyTransition({ objectId: closed.id, transition: "close", actor: ACTOR, now: NOW, note: "done" });
    expect(shut.ok).toBe(true);

    expect(await watched.countOpenWatchedTasks(TEAM, loop.id)).toBe(2);
    expect(await watched.countOpenWatchedTasks(TEAM, other.id)).toBe(1);
    // A different team never sees these rows, and a teamless loop counts zero
    // rather than dropping the team predicate.
    expect(await watched.countOpenWatchedTasks("team-elsewhere", loop.id)).toBe(0);
    expect(await watched.countOpenWatchedTasks(null, loop.id)).toBe(0);
  });

  it("phrases each verb's own consequence and always names the repair", async () => {
    const verbs = ["pause", "finish", "delete"] as const;
    const messages = verbs.map((v) => watched.watchedTasksWarning("loop-x", 2, v).message);
    expect(new Set(messages).size).toBe(verbs.length); // no verb reuses another's sentence
    for (const v of verbs) {
      const w = watched.watchedTasksWarning("loop-x", 2, v);
      expect(w.code).toBe("TASKS_STILL_WATCHED");
      expect(w.openTasks).toBe(2);
      expect(w.message).toContain("2 open tasks");
      expect(w.hint).toContain("--watcher");
      expect(w.hint).toContain("loop-x");
    }
    expect(watched.watchedTasksWarning("loop-x", 1, "pause").message).toContain("1 open task;");
  });
});

describe("pause warns and never blocks", () => {
  it("editLoop enabled:false reports the count, and the loop IS paused", async () => {
    const { loop } = await seed();
    await watchedTask(loop.id);
    await watchedTask(loop.id, "second");

    const res = await gateway().editLoop(TOKEN, loop.id, { enabled: false });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; warning?: { code: string; openTasks: number }; text: string };
    expect(body.ok).toBe(true);
    expect(body.warning).toMatchObject({ code: "TASKS_STILL_WATCHED", openTasks: 2 });
    expect(body.text).toContain("warning:");
    // Never blocks: the pause landed, and the tasks are untouched.
    expect((await store.getLoop(loop.id))!.enabled).toBe(false);
    expect(await watched.countOpenWatchedTasks(TEAM, loop.id)).toBe(2);
  });

  it("stays silent with no open watched tasks, on a resume, and on a re-asserted pause", async () => {
    const { loop } = await seed();
    const clean = await gateway().editLoop(TOKEN, loop.id, { enabled: false });
    expect((clean.body as { warning?: unknown }).warning).toBeUndefined();

    // Now give it a watched task. Re-asserting the pause is NOT a transition.
    await watchedTask(loop.id);
    const again = await gateway().editLoop(TOKEN, loop.id, { enabled: false });
    expect((again.body as { warning?: unknown }).warning).toBeUndefined();

    // Resuming is the opposite move and never warns.
    const resumed = await gateway().editLoop(TOKEN, loop.id, { enabled: true });
    expect((resumed.body as { warning?: unknown }).warning).toBeUndefined();
    expect((await store.getLoop(loop.id))!.enabled).toBe(true);
  });

  it("previews the consequence in --dry-run and persists nothing", async () => {
    const { loop } = await seed();
    await watchedTask(loop.id);
    const res = await gateway().editLoop(TOKEN, loop.id, { enabled: false }, true);
    const body = res.body as { dryRun: boolean; warning?: { openTasks: number }; text: string };
    expect(body.dryRun).toBe(true);
    expect(body.warning).toMatchObject({ openTasks: 1 });
    expect(body.text).toContain("warning:");
    expect((await store.getLoop(loop.id))!.enabled).toBe(true); // validate-only
  });
});

describe("closed-loop finish warns and never blocks", () => {
  it("finish reports the count in its Applied result and in the run's text", async () => {
    const { loop, machineId } = await seed({ goal: "reach the goal" });
    await watchedTask(loop.id);
    const run = await store.addRun({ loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: NOW });
    const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true, canFinish: true });

    const res = await cli().agentApi(rt, ["finish", "--message", "goal met", "--reason", "target met"]);
    expect(res.status).toBe(200);
    expect((res.body as { text: string }).text).toContain("warning:");
    expect((res.body as { text: string }).text).toContain("1 open task");

    // Never blocks: the goal was met and the completion stamps landed.
    const done = (await store.getLoop(loop.id))!;
    expect(done.completedAt).toBeTruthy();
    expect(done.enabled).toBe(false);
    expect(await watched.countOpenWatchedTasks(TEAM, loop.id)).toBe(1);
  });

  it("stays silent when the finished loop watches nothing open", async () => {
    const { loop, machineId } = await seed({ goal: "reach the goal" });
    const run = await store.addRun({ loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: NOW });
    const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true, canFinish: true });
    const res = await cli().agentApi(rt, ["finish", "--message", "goal met", "--reason", "target met"]);
    expect(res.status).toBe(200);
    expect((res.body as { text: string }).text).not.toContain("warning:");
  });
});

describe("delete warns BEFORE, and never cascades", () => {
  it("the loop detail payload carries the count the confirm dialog names", async () => {
    const { loop } = await seed();
    expect((await adapters.toJobDetail(loop)).watchedTasks).toBe(0);
    await watchedTask(loop.id);
    await watchedTask(loop.id, "second");
    expect((await adapters.toJobDetail(loop)).watchedTasks).toBe(2);
  });

  it("store.deleteLoop leaves every kernel object alone — the watcher DANGLES by design", async () => {
    const { loop } = await seed();
    const open = await watchedTask(loop.id);
    const doc = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: ACTOR, now: NOW, title: "Notes", body: "keep me" } as never);
    expect(doc.ok).toBe(true);

    // Warn with the count that is true BEFORE the delete...
    const warning = await watched.watchedTasksWarningFor(loop.teamId, loop.id, "delete");
    expect(warning).toMatchObject({ code: "TASKS_STILL_WATCHED", openTasks: 1 });

    expect(await store.deleteLoop(loop.id)).toBe(true);
    expect(await store.getLoop(loop.id)).toBeUndefined();

    // ...and then change NOTHING about the objects. This is the never-cascade
    // pin the design asks for: growing an `objects` cascade in store.deleteLoop
    // would delete work nobody asked to delete.
    const rows = await database.db.select().from(kernelSchema.objects);
    expect(rows).toHaveLength(2);
    const task = rows.find((r) => r.id === open.id)!;
    expect(task.status).toBe("open");
    expect(task.watcher).toBe(loop.id); // dangling, legal, resolved as a tombstone
  });
});
