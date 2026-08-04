/**
 * Convergence S3.1 regression pins — the INVERSION of the cv-s3-review scratch
 * suite that proved the cutover-boundary wedge (F1), plus the converge
 * pre-check's twin verification (F3).
 *
 * The review's two scratch cases showed that a kernel-lifecycle run row left
 * open at the S3 cutover (`queue_state` 'claimed'/'queued') is reclaimed by
 * NOTHING — the prod sweep and poll both fence on `queue_state IS NULL`, and
 * the kernel attestation reclaim lost its runtime caller — while
 * `hasRunningRun`/`openRunsForLoop` carry no such fence, so a stranded
 * `claimed` row wedges its converged loop forever, silently.
 *
 * These tests plant the SAME rows against the SAME real paths
 * (`MachineGateway.poll/sweep/report`, `store`, a real pglite) and assert the
 * boot pass closes them and that the loop then runs normally — the exact
 * negation of the scratch assertions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let temp: string;
let workRoot: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/schema.js");
let kernelSchema: typeof import("../db/kernel-schema.js");
let store: typeof import("../db/store.js");
let gatewayModule: typeof import("../gateway/index.js");
let tokens: typeof import("../gateway/tokens.js");
let cutover: typeof import("./cutover.js");
let kernel: typeof import("./applyTransition.js");
let convergence: typeof import("./convergeLoops.js");

const TEAM = "team-s31";
const USER = "u-s31";
const TOKEN = "dk_" + "c".repeat(48);
const T0 = "2026-08-05T08:00:00.000Z";

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-s31-"));
  workRoot = path.join(temp, "workdirs");
  process.env.LOOPANY_DATA_DIR = path.join(temp, "data");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/schema.js");
  kernelSchema = await import("../db/kernel-schema.js");
  store = await import("../db/store.js");
  gatewayModule = await import("../gateway/index.js");
  tokens = await import("../gateway/tokens.js");
  cutover = await import("./cutover.js");
  kernel = await import("./applyTransition.js");
  convergence = await import("./convergeLoops.js");
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

beforeEach(async () => {
  await database.db.delete(schema.runLeases);
  await database.db.delete(kernelSchema.events);
  await database.db.delete(kernelSchema.objects);
  await database.db.delete(schema.runs);
  await database.db.delete(schema.loops);
  await database.db.delete(schema.machines);
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
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

/** The converged world: one stack machine and one production twin keeping the
 * kernel loop id verbatim. */
async function seed(loopId = "loop-s31a") {
  const machineId = tokens.machineIdFromToken(TOKEN);
  await store.createMachine({
    id: machineId,
    userId: USER,
    teamId: TEAM,
    name: "s31-host",
    tokenHash: tokens.sha256(TOKEN),
    online: true,
  });
  const loop = await store.createLoop({
    id: loopId,
    userId: USER,
    teamId: TEAM,
    machineId,
    name: "Converged",
    cron: "0 7 * * *",
    enabled: true,
    notify: "never",
    taskFile: path.join(workRoot, "loopany-task.md"),
  } as never);
  return { loop, machineId };
}

/** A kernel-lifecycle row exactly as the retired queue left it. */
async function plantStranded(values: Record<string, unknown>) {
  await database.db.insert(schema.runs).values({
    userId: TEAM, // the kernel team-as-user shim pre-S3 rows carry
    role: "exec",
    attempts: 1,
    ...values,
  } as never);
}

describe("S3.1 F1: kernel rows stranded at the cutover are terminalized at boot", () => {
  it("terminalizes a stranded CLAIMED row, and the converged loop then claims and executes normally", async () => {
    const { loop, machineId } = await seed();
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    await plantStranded({
      id: "run-stranded1",
      loopId: loop.id,
      machineId,
      phase: "running",
      ts: twoHoursAgo,
      queueState: "claimed",
      leaseState: "active",
      leaseExpiresAt: twoHoursAgo,
      claimedAt: twoHoursAgo,
      reason: "clock",
    });

    const report = await cutover.terminalizeStrandedQueueRows();
    expect(report.terminalized).toEqual([
      { runId: "run-stranded1", loopId: loop.id, queueState: "claimed", phase: "running" },
    ]);
    const closed = await store.getRun("run-stranded1");
    expect(closed).toMatchObject({
      phase: "error",
      queueState: "failure",
      outcome: "error",
      leaseState: null,
      leaseExpiresAt: null,
      error: cutover.STRANDED_RUN_ERROR,
    });
    expect(closed?.finishedAt).toBeTruthy();
    // The row keeps its historical timestamp — this is a disposal, not a fresh event.
    expect(closed?.ts).toBe(twoHoursAgo);

    // The wedge is gone: the loop is no longer "running", so a fresh production
    // run is delivered by the poll and reported to completion as usual.
    expect(await store.hasRunningRun(loop.id)).toBe(false);
    const pending = await store.addRun({
      loopId: loop.id,
      userId: USER,
      machineId,
      phase: "pending",
      role: "exec",
      ts: new Date().toISOString(),
      claimableAt: new Date().toISOString(),
    });
    const polled = await gateway().poll(TOKEN, { host: "s31" });
    expect(polled.status).toBe(200);
    const deliveries = (polled.body as { deliveries: Array<{ runId: string; runToken: string }> }).deliveries;
    expect(deliveries.map((d) => d.runId)).toEqual([pending.id]);
    expect((await gateway().report(deliveries[0]!.runToken, { ok: true, message: "done" })).status).toBe(200);
    expect(await store.getRun(pending.id)).toMatchObject({ phase: "done", message: "done" });
  });

  it("terminalizes a stranded QUEUED row, leaves every queue_state IS NULL production row alone, and reruns as a no-op", async () => {
    const { loop, machineId } = await seed();
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    await plantStranded({
      id: "run-strandedq",
      loopId: loop.id,
      machineId: "",
      phase: "pending",
      ts: anHourAgo,
      queueState: "queued",
      reason: "due",
      scope: "task:task-x",
      attempts: 0,
    });
    // Live production rows: one pending, one running. Both must survive verbatim.
    const livePending = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: new Date().toISOString(),
    });
    const liveRunning = await store.addRun({
      loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: new Date().toISOString(),
    });
    const pendingBefore = await store.getRun(livePending.id);
    const runningBefore = await store.getRun(liveRunning.id);

    const report = await cutover.terminalizeStrandedQueueRows();
    expect(report.terminalized.map((r) => r.runId)).toEqual(["run-strandedq"]);
    expect(await store.getRun("run-strandedq")).toMatchObject({ phase: "error", queueState: "failure", leaseState: null });
    expect(await store.getRun(livePending.id)).toEqual(pendingBefore);
    expect(await store.getRun(liveRunning.id)).toEqual(runningBefore);

    // Idempotent: a terminalized row no longer carries an open queue state.
    const rerun = await cutover.terminalizeStrandedQueueRows();
    expect(rerun.terminalized).toEqual([]);
    expect(await store.getRun(livePending.id)).toEqual(pendingBefore);
    expect(await store.getRun(liveRunning.id)).toEqual(runningBefore);
  });

  it("closes a provenance-carrying row's kernel timeline and stays event-silent for a provenance-free one", async () => {
    const { loop, machineId } = await seed();
    await plantStranded({
      id: "run-provenance",
      loopId: loop.id,
      machineId,
      phase: "running",
      ts: T0,
      queueState: "claimed",
      reason: "due",
      scope: "task:task-s31",
    });
    await plantStranded({
      id: "run-silent",
      loopId: loop.id,
      machineId,
      phase: "running",
      ts: T0,
      queueState: "claimed",
    });

    await cutover.terminalizeStrandedQueueRows();
    const finished = (await database.db.select().from(kernelSchema.events)).filter((e) => e.kind === "run-finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      objectId: loop.id,
      actorId: "run-provenance",
      origin: "derived",
      entrance: "agent",
      teamId: TEAM,
    });
    expect(finished[0]!.payload).toMatchObject({ outcome: "failure", reason: "due", scope: "task:task-s31" });
    // Both rows are closed regardless; only the timeline treatment differs.
    for (const id of ["run-provenance", "run-silent"]) {
      expect(await store.getRun(id)).toMatchObject({ phase: "error", queueState: "failure" });
    }
  });

  it("boot runs the pass before the scheduler can early-out on a stranded row", async () => {
    // Path in a VARIABLE: vite rewrites a LITERAL `new URL(..., import.meta.url)`
    // into an asset URL, which `fileURLToPath` then rejects.
    const rel = "../server/boot.ts";
    const source = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const pass = source.indexOf("terminalizeStrandedQueueRows()");
    const schedulerStart = source.indexOf("scheduler.start(");
    expect(pass).toBeGreaterThan(-1);
    expect(pass).toBeLessThan(schedulerStart);
  });
});

describe("S3.1 F3: converge verifies the twin before counting an id converged", () => {
  async function kernelLoop(id: string) {
    const dir = path.join(workRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const made = await kernel.createObject({
      teamId: TEAM,
      kind: "loop",
      actor: { entrance: "human", actorId: USER },
      now: T0,
      id,
      title: "Converge me",
      body: "Do the work.",
      cron: "0 7 * * *",
      workdir: dir,
    } as never);
    if (!made.ok) throw new Error(made.message);
    return made.object;
  }

  it("refuses loudly when a same-id production row is NOT the twin the plan would create", async () => {
    const { machineId } = await seed("loop-unrelated");
    const target = await kernelLoop("loop-foreign");
    // A same-id row bound elsewhere: same team, a DIFFERENT machine.
    await store.createLoop({
      id: target.id,
      userId: USER,
      teamId: TEAM,
      machineId: "m-somewhere-else",
      name: "Not the twin",
      cron: "0 9 * * *",
      enabled: true,
      notify: "never",
      taskFile: "/tmp/foreign/task.md",
    } as never);

    const report = await convergence.convergeKernelLoops();
    expect(report.existing).toBe(0);
    expect(report.refused).toEqual([
      { loopId: target.id, message: expect.stringContaining("refusing to count a foreign row as converged") },
    ]);
    expect(report.refused[0]!.message).toContain("m-somewhere-else");
    expect(report.refused[0]!.message).toContain(machineId);
    // Nothing was touched: the foreign row stands and no provenance was written.
    expect(await store.getLoop(target.id)).toMatchObject({ machineId: "m-somewhere-else", name: "Not the twin" });
    expect((await database.db.select().from(kernelSchema.events)).filter((e) => e.kind === "loop-converged")).toHaveLength(0);
    expect(fs.existsSync(path.join(target.workdir!, convergence.CONVERGED_TASK_FILE))).toBe(false);
  });

  it("still counts the REAL twin as existing on a rerun", async () => {
    await seed("loop-unrelated");
    const target = await kernelLoop("loop-twin");
    expect(await convergence.convergeKernelLoops()).toMatchObject({ created: 1, existing: 0, refused: [] });
    const twin = await store.getLoop(target.id);
    const rerun = await convergence.convergeKernelLoops();
    expect(rerun).toMatchObject({ created: 0, existing: 1, refused: [] });
    expect(await store.getLoop(target.id)).toEqual(twin);
    expect(await database.db.select().from(schema.loops).where(eq(schema.loops.id, target.id))).toHaveLength(1);
  });
});
