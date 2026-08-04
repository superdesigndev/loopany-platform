import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/schema.js");
let kernelSchema: typeof import("../db/kernel-schema.js");
let store: typeof import("../db/store.js");
let kernel: typeof import("./applyTransition.js");
let queue: typeof import("./runQueue.js");
let api: typeof import("./objectApi.js");
let delivery: typeof import("../gateway/delivery.js");
let gatewayModule: typeof import("../gateway/index.js");
let auth: typeof import("./apiAuth.js");
let ids: typeof import("./ids.js");

const TEAM = "team-s2";
const USER = "u-s2";
const TOKEN = "dk_s2_device_token";
const NOW = new Date("2026-08-04T12:00:00.000Z");
const human = { teamId: TEAM, actor: { entrance: "human", actorId: USER }, mode: "human" } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-convergence-s2-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/schema.js");
  kernelSchema = await import("../db/kernel-schema.js");
  store = await import("../db/store.js");
  kernel = await import("./applyTransition.js");
  queue = await import("./runQueue.js");
  api = await import("./objectApi.js");
  delivery = await import("../gateway/delivery.js");
  gatewayModule = await import("../gateway/index.js");
  auth = await import("./apiAuth.js");
  ids = await import("./ids.js");
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

async function fixtures(enabled = true) {
  const { machineIdFromToken, sha256 } = await import("../gateway/tokens.js");
  const machineId = machineIdFromToken(TOKEN);
  await database.db.insert(schema.machines).values({
    id: machineId,
    userId: USER,
    name: "s2-host",
    tokenHash: sha256(TOKEN),
    teamId: TEAM,
    lastSeen: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  });
  const loop = await store.createLoop({
    userId: USER,
    teamId: TEAM,
    machineId,
    name: "Production watcher",
    cron: "0 7 * * *",
    enabled,
    notify: "never",
    taskFile: "/tmp/s2-loop/task.md",
  });
  return { loop, machineId };
}

async function task(watcher: string, extra: Record<string, unknown> = {}) {
  const made = await kernel.createObject({
    teamId: TEAM,
    kind: "task",
    actor: human.actor,
    now: NOW.toISOString(),
    title: "Verify the prod path",
    watcher,
    payload: { exact: "KEEP <this> byte-for-byte", nested: { n: 7 } },
    ...extra,
  } as never);
  if (!made.ok) throw new Error(made.message);
  return made.object;
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function gateway() {
  const scheduler = {
    removeLoop(): void {},
    async maybeFlagEvolve(): Promise<void> {},
    async finishEvolution(): Promise<void> {},
    async finishEdit(): Promise<void> {},
  } as never;
  return new gatewayModule.MachineGateway(scheduler);
}

describe("S2 prod-claimable trigger rows", () => {
  it("queues a due task on its prod watcher's machine with the frozen derived id", async () => {
    const { loop, machineId } = await fixtures();
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 1, queued: 1, failed: 0 });
    const rows = await database.db.select().from(schema.runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: ids.dueRunId(loop.id, due.id, due.followUpAt!),
      loopId: loop.id,
      userId: USER,
      machineId,
      phase: "pending",
      role: "exec",
      queueState: null,
      reason: "due",
      scope: `task:${due.id}`,
    });

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ replayed: 1, queued: 0 });
    expect(await database.db.select().from(schema.runs)).toHaveLength(1);
  });

  it("keeps a disabled watcher's due task level-triggered until re-enable", async () => {
    const { loop } = await fixtures(false);
    await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 0, queued: 0 });
    await store.updateLoop(loop.id, { enabled: true });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 1, queued: 1 });
  });

  it("queues a directive as a prod run and carries its words + payload in the first turn", async () => {
    const { loop, machineId } = await fixtures();
    const watched = await task(loop.id);
    const words = "Close the harmless test item, then report exactly what changed.";
    const result = ok(await api.leaveDirective(watched.id, words, human, NOW));
    expect(result.run).toMatchObject({ reason: "directive", alreadyQueued: false });
    const row = (await database.db.select().from(schema.runs))[0]!;
    expect(row).toMatchObject({ machineId, queueState: null, phase: "pending", triggerEventId: result.event });

    const built = await delivery.buildDelivery(loop, row.id, "rk_test", []);
    expect(built.task).toContain(`directive: ${words}`);
    expect(built.task).toContain("KEEP <this> byte-for-byte");
    expect(built.task).toContain(`Task: ${watched.id} — Verify the prod path`);
    expect(built.task).toMatch(/Task payload \(verbatim JSON\):/);
  });

  it("joins a second directive to the open prod run instead of stacking", async () => {
    const { loop } = await fixtures();
    const first = await task(loop.id, { title: "first" });
    const second = await task(loop.id, { title: "second" });
    ok(await api.leaveDirective(first.id, "First instruction", human, NOW));
    const joined = ok(await api.leaveDirective(second.id, "Second instruction", human, NOW));
    expect(joined.run).toMatchObject({ alreadyQueued: true });
    expect(await database.db.select().from(schema.runs)).toHaveLength(1);
  });
});

describe("S2 manual, claim, auth and finalize", () => {
  it("run-now fires one prod run while paused, clears the deferred marker, and reports alreadyQueued", async () => {
    const { loop } = await fixtures(false);
    await store.updateLoop(loop.id, { nextRunAt: "2026-08-05T00:00:00.000Z" });

    expect(ok(await api.runLoopNow(loop.id, human, NOW))).toMatchObject({ queued: true, alreadyQueued: false });
    expect(await store.getLoop(loop.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(ok(await api.runLoopNow(loop.id, human, NOW))).toMatchObject({ queued: false, alreadyQueued: true });
    expect(await database.db.select().from(schema.runs)).toHaveLength(1);
  });

  it("the prod poll defers a trigger while its loop already has a running run", async () => {
    const { loop, machineId } = await fixtures();
    await store.addRun({ loopId: loop.id, userId: USER, machineId, phase: "running", role: "exec", ts: NOW.toISOString() });
    // Model the allowed transient state directly (for example, a trigger racing
    // the running transition): the claim guard, not creation provenance, is the
    // contract under test here.
    await store.addRun({ loopId: loop.id, userId: USER, machineId, phase: "pending", role: "exec", ts: NOW.toISOString(), reason: "manual", scope: "routine" });
    const polled = await gateway().poll(TOKEN);
    expect((polled.body as { deliveries: unknown[] }).deliveries).toHaveLength(0);
    expect((await store.openRunsForLoop(loop.id)).map((run) => run.phase).sort()).toEqual(["pending", "running"]);
  });

  it("claims through prod, resolves object auth from the prod lease, and appends run-finished on report", async () => {
    const { loop } = await fixtures(false);
    const watched = await task(loop.id);
    ok(await api.leaveDirective(watched.id, "Carry this sentence into the run.", human, NOW));

    const gw = gateway();
    const polled = await gw.poll(TOKEN);
    const claimed = (polled.body as { deliveries: Array<{ runId: string; runToken: string; task: string }> }).deliveries[0]!;
    expect(claimed.task).toContain("directive: Carry this sentence into the run.");

    const signedOut = {
      currentUser: async () => null,
      requestScope: async () => ({ enforce: true, userId: null, teamId: TEAM }),
      authEnabled: true,
    };
    const request = new Request("https://example.test/api/tasks", {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Loopany-Run": claimed.runId },
    });
    const context = await auth.resolveApiContext(request, "dual", true, signedOut);
    expect(context.ok && context.context).toMatchObject({ teamId: TEAM, mode: "agent", loop: { id: loop.id } });

    expect((await gw.report(claimed.runToken, { ok: true, durationMs: 4, message: "done" })).status).toBe(200);
    const finished = await database.db.select().from(kernelSchema.events).where(eq(kernelSchema.events.kind, "run-finished"));
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ objectId: loop.id, actorId: claimed.runId, origin: "derived" });
    expect(finished[0]!.payload).toMatchObject({ outcome: "success", reason: "directive", scope: `task:${watched.id}` });
  });
});
