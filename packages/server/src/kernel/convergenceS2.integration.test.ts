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
let kernelStore: typeof import("../db/kernelStore.js");
let api: typeof import("./objectApi.js");
let delivery: typeof import("../gateway/delivery.js");
let gatewayModule: typeof import("../gateway/index.js");
let auth: typeof import("./apiAuth.js");
let ids: typeof import("./ids.js");
let schedulerModule: typeof import("../scheduler/index.js");
let tokens: typeof import("../gateway/tokens.js");
let refs: typeof import("./objectRefs.js");

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
  kernelStore = await import("../db/kernelStore.js");
  api = await import("./objectApi.js");
  delivery = await import("../gateway/delivery.js");
  gatewayModule = await import("../gateway/index.js");
  auth = await import("./apiAuth.js");
  ids = await import("./ids.js");
  schedulerModule = await import("../scheduler/index.js");
  tokens = await import("../gateway/tokens.js");
  refs = await import("./objectRefs.js");
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

  it("F1: a real cron tick preserves a deferred due trigger and its instant remains represented", async () => {
    const { loop } = await fixtures();
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const dueId = ids.dueRunId(loop.id, due.id, due.followUpAt!);

    const scheduler = new schedulerModule.Scheduler({ dispatch(): void {} });
    await (scheduler as unknown as { runLoop(id: string): Promise<void> }).runLoop(loop.id);

    const rows = await database.db.select().from(schema.runs);
    expect(rows.find((row) => row.id === dueId)).toMatchObject({ phase: "pending", reason: "due", scope: `task:${due.id}` });
    expect(rows.some((row) => row.id !== dueId && row.reason == null && row.scope == null)).toBe(true);
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ replayed: 1, queued: 0 });
  });

  it("queues a directive as a prod run and carries its words + payload in the first turn", async () => {
    const { loop, machineId } = await fixtures();
    const watched = await task(loop.id);
    const words = "Close the harmless test item, then report exactly what changed.";
    const result = ok(await api.leaveDirective(watched.id, words, human, NOW));
    expect(result.run).toMatchObject({ reason: "directive", alreadyQueued: false });
    const row = (await database.db.select().from(schema.runs))[0]!;
    expect(row).toMatchObject({ machineId, phase: "pending", triggerEventId: result.event });

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

  it("F3: a directive arriving during execution queues its own scoped pending row", async () => {
    const { loop, machineId } = await fixtures();
    const watched = await task(loop.id);
    const executing = await store.addRun({
      loopId: loop.id,
      userId: USER,
      machineId,
      phase: "running",
      role: "exec",
      ts: NOW.toISOString(),
    });

    const result = ok(await api.leaveDirective(watched.id, "Deliver this after the active run.", human, NOW));
    expect(result.run).toMatchObject({ alreadyQueued: false, reason: "directive" });
    const rows = await database.db.select().from(schema.runs);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id !== executing.id)).toMatchObject({
      phase: "pending",
      scope: `task:${watched.id}`,
      triggerEventId: result.event,
    });
    expect((await gateway().poll(TOKEN)).body).toMatchObject({ deliveries: [] });
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

  it("F2: sweep does not fail a 21-minute pending trigger held behind a healthy running sibling", async () => {
    const { loop, machineId } = await fixtures();
    await store.updateMachine(machineId, { online: true, lastSeen: new Date().toISOString() });
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    const executing = await store.addRun({
      loopId: loop.id,
      userId: USER,
      machineId,
      phase: "running",
      role: "exec",
      ts: old,
      progress: { step: 2, label: "still working", at: new Date().toISOString() },
    });
    const held = await store.addRun({
      loopId: loop.id,
      userId: USER,
      machineId,
      phase: "pending",
      role: "exec",
      ts: old,
      reason: "directive",
      scope: "task:held",
    });

    await gateway().sweep();
    expect(await store.getRun(executing.id)).toMatchObject({ phase: "running" });
    expect(await store.getRun(held.id)).toMatchObject({ phase: "pending", error: null });
  });

  it("F4: sweep reclaim appends run-finished for a provenance-carrying terminal run", async () => {
    const { loop, machineId } = await fixtures();
    await store.updateMachine(machineId, { online: true, lastSeen: new Date().toISOString() });
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    const run = await store.addRun({
      loopId: loop.id,
      userId: USER,
      machineId,
      phase: "running",
      role: "exec",
      ts: old,
      reason: "due",
      scope: "task:sweep-repro",
      progress: { step: 1, label: "stale", at: old },
    });

    await gateway().sweep();
    expect(await store.getRun(run.id)).toMatchObject({ phase: "error", error: "machine timed out / disconnected" });
    const finished = await database.db.select().from(kernelSchema.events).where(eq(kernelSchema.events.kind, "run-finished"));
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ objectId: loop.id, actorId: run.id });
    expect(finished[0]!.payload).toMatchObject({ outcome: "failure", reason: "due", scope: "task:sweep-repro" });

    await store.updateMachine(machineId, { online: false, lastSeen: "2000-01-01T00:00:00.000Z" });
    const expired = await store.addRun({
      loopId: loop.id,
      userId: USER,
      machineId,
      phase: "pending",
      role: "exec",
      ts: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      reason: "directive",
      scope: "task:backstop-repro",
    });
    await gateway().sweep();
    expect(await store.getRun(expired.id)).toMatchObject({ phase: "canceled", outcome: "skipped" });
    const afterBackstop = await database.db.select().from(kernelSchema.events).where(eq(kernelSchema.events.kind, "run-finished"));
    expect(afterBackstop.find((event) => event.actorId === expired.id)?.payload).toMatchObject({
      outcome: "skipped",
      reason: "directive",
      scope: "task:backstop-repro",
    });
  });

  it("F5: a failed due instant re-arms the same frozen id, while a completed one permanently replays", async () => {
    const { loop, machineId } = await fixtures();
    await store.updateMachine(machineId, { online: true, lastSeen: new Date().toISOString() });
    const due = await task(loop.id, { followUpAt: "2026-08-04T11:00:00.000Z" });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const dueId = ids.dueRunId(loop.id, due.id, due.followUpAt!);
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    await store.updateRun(dueId, { phase: "running", ts: old, progress: { step: 1, label: "stale", at: old } });
    const oldLease = await tokens.registerRunLease({
      runId: dueId,
      loopId: loop.id,
      machineId,
      role: "exec",
      allowControl: true,
    });
    await gateway().sweep();
    expect(await store.getRun(dueId)).toMatchObject({ phase: "error" });
    expect((await tokens.resolveLease(oldLease))?.state).toBe("terminal-grace");

    expect(await queue.tickDueTasks(new Date())).toMatchObject({ queued: 1, replayed: 0 });
    expect(await store.getRun(dueId)).toMatchObject({ id: dueId, phase: "pending", outcome: null, error: null, reason: "due" });
    expect(await tokens.resolveLease(oldLease)).toBeUndefined();

    await store.updateRun(dueId, { phase: "done", outcome: "exec" });
    expect(await queue.tickDueTasks(new Date())).toMatchObject({ queued: 0, replayed: 1 });
    expect(await store.getRun(dueId)).toMatchObject({ phase: "done", outcome: "exec" });
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

  /**
   * PRODUCTS ARE KERNEL OBJECTS, so a run must be able to file one with the
   * credentials its OWN delivery handed it — and read it back next pass by the
   * only handle that survives: the key it chose. The daemon exports `runToken`
   * (this delivery's lease) and `runId`; it does NOT export the machine's device
   * token, which is why the whole verb set came back UNAUTHORIZED once a stack's
   * `LOOPANY_HOME` moved. The claim is driven through the real prod poll, and
   * every call below carries exactly what the delivery carried, nothing else.
   */
  it("a run files a doc and reads it back BY KEY with the credential its delivery carried", async () => {
    const { loop } = await fixtures();
    const watched = await task(loop.id);
    ok(await api.leaveDirective(watched.id, "File the cleanup card as a product.", human, NOW));
    const gw = gateway();
    const polled = await gw.poll(TOKEN);
    const claimed = (polled.body as { deliveries: Array<{ runId: string; runToken: string }> }).deliveries[0]!;

    const signedOut = {
      currentUser: async () => null,
      requestScope: async () => ({ enforce: true, userId: null, teamId: TEAM }),
      authEnabled: true,
    };
    // The exact pair the in-run CLI sends: the delivery's lease token, and the
    // run id as the invisible context header.
    const asRun = (mutation: boolean) => auth.resolveApiContext(
      new Request("https://example.test/api/docs", { headers: { Authorization: `Bearer ${claimed.runToken}`, "X-Loopany-Run": claimed.runId } }),
      "dual", mutation, signedOut,
    );

    const write = await asRun(true);
    expect(write.ok, JSON.stringify(!write.ok && write.error)).toBe(true);
    if (!write.ok) return;

    const filed = ok(await api.createFromArtifact("doc", "---\ntitle: Cleanup card\nkey: housekeeper-cleanup-card\n---\n\nOne deleted export.\n", write.context, NOW));
    const docId = (filed.doc as { id: string }).id;
    expect(filed.created).toBe(true);
    // Provenance is the RUN's, which is what makes it the loop's product.
    expect(filed.doc).toMatchObject({ createdByRun: claimed.runId, createdByLoop: loop.id });

    // The read-back, exactly as a later pass does it: by the key, never by an id
    // the run would have had to memorize across runs.
    const read = await asRun(false);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const resolved = await refs.resolveObjectRef("housekeeper-cleanup-card", read.context.teamId);
    expect(resolved).toBe(docId);
    expect(ok(await api.showObject("doc", resolved, read.context)).doc).toMatchObject({ id: docId, title: "Cleanup card" });

    // And the worklist read the exec core points every run at.
    const listed = ok(await api.listTasks(read.context, new URLSearchParams({ watcher: loop.id })));
    expect((listed.tasks as Array<{ id: string }>).map((t) => t.id)).toContain(watched.id);
    expect(listed.viewerLoop).toBe(loop.id);
  });

  it("F6: a run-finished collision is logged best-effort and cannot wedge lease retirement", async () => {
    const { loop } = await fixtures(false);
    const watched = await task(loop.id);
    ok(await api.leaveDirective(watched.id, "Finish despite the event collision.", human, NOW));
    const gw = gateway();
    const polled = await gw.poll(TOKEN);
    const claimed = (polled.body as { deliveries: Array<{ runId: string; runToken: string }> }).deliveries[0]!;
    const collisionId = ids.derivedEventId({ runId: claimed.runId, kind: "run-finished", outcome: "success" });
    await kernelStore.appendEvent(undefined, {
      id: collisionId,
      teamId: TEAM,
      objectId: watched.id,
      kind: "run-finished",
      origin: "derived",
      entrance: "agent",
      actorId: "run-collision-holder",
      payload: { outcome: "success" },
      ts: NOW.toISOString(),
    });

    expect((await gw.report(claimed.runToken, { ok: true, message: "done" })).status).toBe(200);
    expect(await tokens.resolveLease(claimed.runToken)).toBeUndefined();
    expect(await store.getRun(claimed.runId)).toMatchObject({ phase: "done", message: "done" });
  });
});
