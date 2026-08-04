import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let temp: string;
let workRoot: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/schema.js");
let kernelSchema: typeof import("../db/kernel-schema.js");
let store: typeof import("../db/store.js");
let kernel: typeof import("./applyTransition.js");
let convergence: typeof import("./convergeLoops.js");

const TEAM = "team-converge";
const USER = "u-converge";
const T0 = "2026-08-04T08:00:00.000Z";
const ACTOR = { entrance: "human", actorId: USER } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-converge-s3-"));
  workRoot = path.join(temp, "workdirs");
  process.env.LOOPANY_DATA_DIR = path.join(temp, "data");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/schema.js");
  kernelSchema = await import("../db/kernel-schema.js");
  store = await import("../db/store.js");
  kernel = await import("./applyTransition.js");
  convergence = await import("./convergeLoops.js");
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

beforeEach(async () => {
  await database.db.delete(kernelSchema.events);
  await database.db.delete(kernelSchema.objects);
  await database.db.delete(schema.runs);
  await database.db.delete(schema.loops);
  await database.db.delete(schema.machines);
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  await store.createMachine({
    id: "m-converge",
    userId: USER,
    teamId: TEAM,
    name: "isolated stack",
    tokenHash: "hash",
    token: "dk_isolated",
    online: true,
  });
});

async function make(input: Record<string, unknown>) {
  const made = await kernel.createObject({ teamId: TEAM, actor: ACTOR, now: T0, ...input } as never);
  if (!made.ok) throw new Error(made.message);
  return made.object;
}

function workdir(name: string): string {
  const dir = path.join(workRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("kernel:converge-loops", () => {
  it("creates active and paused production twins with verbatim ids and materialized Specs", async () => {
    const active = await make({
      id: "loop-active", kind: "loop", title: "Active watcher", body: "Do active work.\nKeep this byte-for-byte.\n",
      cron: "15 7 * * *", timezone: "Asia/Singapore", workdir: workdir("active"),
    });
    const paused = await make({
      id: "loop-paused", kind: "loop", title: "Paused watcher", body: "Wait until enabled.",
      status: "paused", cron: null, timezone: null, workdir: workdir("paused"),
    });

    // Non-loop entities and their existing provenance are id-verbatim cargo,
    // not migration inputs. Keep one of every surviving kind in the fixture.
    await make({ id: "task-keep", kind: "task", title: "Keep task", watcher: active.id });
    await make({ id: "doc-keep", kind: "doc", title: "Keep doc", body: "unchanged", format: "markdown" });
    await make({
      id: "mirror-keep", kind: "mirror", mirrorKind: "github-pr", mirrorCoords: "o/r#1", attachedTo: ["task-keep"],
    });
    const nonLoopsBefore = await database.db.select().from(kernelSchema.objects).where(ne(kernelSchema.objects.kind, "loop"));
    const eventsBefore = await database.db.select().from(kernelSchema.events);

    const report = await convergence.convergeKernelLoops();
    expect(report).toMatchObject({ scanned: 2, created: 2, existing: 0, filesCreated: 2, filesReused: 0, refused: [] });

    const activeTwin = await store.getLoop(active.id);
    expect(activeTwin).toMatchObject({
      id: active.id, name: "Active watcher", cron: "15 7 * * *", timezone: "Asia/Singapore",
      enabled: true, machineId: "m-converge", userId: USER, teamId: TEAM, workdir: active.workdir,
    });
    const activeTask = path.join(active.workdir!, convergence.CONVERGED_TASK_FILE);
    expect(activeTwin?.taskFile).toBe(activeTask);
    expect(fs.readFileSync(activeTask, "utf8")).toBe("# Active watcher\n\n## Spec\n\nDo active work.\nKeep this byte-for-byte.\n");
    expect(activeTwin?.taskFileContent).toBe(fs.readFileSync(activeTask, "utf8"));

    const pausedTwin = await store.getLoop(paused.id);
    expect(pausedTwin).toMatchObject({ id: paused.id, name: "Paused watcher", cron: "", enabled: false });
    expect(fs.readFileSync(pausedTwin!.taskFile!, "utf8")).toBe("# Paused watcher\n\n## Spec\n\nWait until enabled.\n");

    expect(await database.db.select().from(kernelSchema.objects).where(ne(kernelSchema.objects.kind, "loop"))).toEqual(nonLoopsBefore);
    const eventsAfter = await database.db.select().from(kernelSchema.events);
    for (const event of eventsBefore) expect(eventsAfter).toContainEqual(event);
    const convergenceEvents = eventsAfter.filter((event) => event.kind === "loop-converged");
    expect(convergenceEvents).toHaveLength(2);
    expect(convergenceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: active.id, origin: "organic", entrance: "human", actorId: convergence.CONVERGE_ACTOR_ID }),
      expect.objectContaining({ objectId: paused.id, origin: "organic", entrance: "human", actorId: convergence.CONVERGE_ACTOR_ID }),
    ]));

    // Kernel loop objects remain through S5 as the history anchor.
    expect(await database.db.select().from(kernelSchema.objects).where(eq(kernelSchema.objects.kind, "loop"))).toHaveLength(2);
  });

  it("is insert-only and idempotent, refusing different task-file bytes", async () => {
    const stable = await make({
      id: "loop-stable", kind: "loop", title: "Stable", body: "Original.", cron: "0 8 * * *", workdir: workdir("stable"),
    });
    expect(await convergence.convergeKernelLoops()).toMatchObject({ created: 1, filesCreated: 1, refused: [] });
    const taskFile = path.join(stable.workdir!, convergence.CONVERGED_TASK_FILE);
    const stableBytes = fs.readFileSync(taskFile, "utf8");

    const rerun = await convergence.convergeKernelLoops();
    expect(rerun).toMatchObject({ created: 0, existing: 1, filesCreated: 0, filesReused: 0, refused: [] });
    expect(fs.readFileSync(taskFile, "utf8")).toBe(stableBytes);
    expect((await database.db.select().from(kernelSchema.events)).filter((event) => event.kind === "loop-converged")).toHaveLength(1);

    const conflict = await make({
      id: "loop-conflict", kind: "loop", title: "Conflict", body: "Migration bytes.", cron: "0 9 * * *", workdir: workdir("conflict"),
    });
    const conflictFile = path.join(conflict.workdir!, convergence.CONVERGED_TASK_FILE);
    fs.writeFileSync(conflictFile, "owner-authored bytes\n", "utf8");
    const refused = await convergence.convergeKernelLoops();
    expect(refused.refused).toEqual([{ loopId: conflict.id, message: expect.stringContaining("refusing to overwrite") }]);
    expect(await store.getLoop(conflict.id)).toBeUndefined();
    expect(fs.readFileSync(conflictFile, "utf8")).toBe("owner-authored bytes\n");
  });

  it("dry-runs the exact mapping without writing files, rows, or events", async () => {
    const candidate = await make({
      id: "loop-dry", kind: "loop", title: "Dry", body: "Preview only.", cron: "0 10 * * *", workdir: workdir("dry"),
    });
    const eventCount = (await database.db.select().from(kernelSchema.events)).length;
    const report = await convergence.convergeKernelLoops({ dryRun: true });
    expect(report).toMatchObject({ dryRun: true, scanned: 1, created: 0, existing: 0, refused: [] });
    expect(report.planned[0]).toMatchObject({ id: candidate.id, machineId: "m-converge", enabled: true });
    expect(await store.getLoop(candidate.id)).toBeUndefined();
    expect(fs.existsSync(path.join(candidate.workdir!, convergence.CONVERGED_TASK_FILE))).toBe(false);
    expect(await database.db.select().from(kernelSchema.events)).toHaveLength(eventCount);
  });
});
