import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * R-DUE — the kernel's ONE remaining clock, against a real pglite database.
 *
 * A watched task reaching its `follow_up` wakes its watcher (captain ruling
 * 2026-08-04). Once every task names the loop that acts next, a follow-up date
 * is a real alarm on a named actor, so the scan treats it exactly like a
 * cadence: level-triggered, derived-id idempotent, ENABLED production watchers
 * only — and the row it writes is an ordinary production pending run that the
 * shipping poll claims and the shipping report finalizes.
 *
 * What this file used to also cover, and no longer does, because convergence S5
 * DELETED the code: the kernel cadence tick (`tickRunClock`/`armUnarmedLoops`),
 * the device claim long-poll (`claimRun`/`claimOnce` + its enrollment surface),
 * attestation-renewed leases and scheduler-owned reclaim, the `finish` endpoint
 * with its report-doc ingestion and circuit breaker, and the `queue_state IS
 * NULL` sweep/poll fences. The production poll/lease/sweep/report pipeline is
 * the one run world; its own suites own it.
 */
let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/kernel-schema.js");
let legacySchema: typeof import("../db/schema.js");
let kernel: typeof import("./applyTransition.js");
let queue: typeof import("./runQueue.js");
let store: typeof import("../db/kernelStore.js");
let legacyStore: typeof import("../db/store.js");
let tokens: typeof import("../gateway/tokens.js");
let ids: typeof import("./ids.js");
let gateway: typeof import("../gateway/index.js");

const TEAM = "team-runs";
const T0 = "2026-08-03T00:00:00.000Z";
const DUE = "2026-08-03T07:00:00.000Z";
const NOW = new Date("2026-08-03T10:00:00.000Z");
const HUMAN = { entrance: "human", actorId: "u-owner" } as const;
const PROD_TOKEN = "dk_" + "d".repeat(48);

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-run-triggers-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/kernel-schema.js");
  legacySchema = await import("../db/schema.js");
  kernel = await import("./applyTransition.js");
  queue = await import("./runQueue.js");
  store = await import("../db/kernelStore.js");
  legacyStore = await import("../db/store.js");
  tokens = await import("../gateway/tokens.js");
  ids = await import("./ids.js");
  gateway = await import("../gateway/index.js");
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

beforeEach(async () => {
  await database.db.delete(schema.events);
  await database.db.delete(schema.objects);
  await database.db.delete(legacySchema.runs);
  await database.db.delete(legacySchema.loops);
  await database.db.delete(legacySchema.machines);
});

/** A PRODUCTION loop, bound to this stack's one machine. There is no other kind
 *  of loop: `objects` holds task/doc/mirror only after convergence S5. */
let loopSeq = 0;
async function loop(over: { name?: string; enabled?: boolean } = {}) {
  const machineId = tokens.machineIdFromToken(PROD_TOKEN);
  if (!(await legacyStore.getMachine(machineId))) await machine(machineId, PROD_TOKEN);
  const name = over.name ?? "Housekeeper";
  return legacyStore.createLoop({
    id: `loop-due${loopSeq++}`,
    userId: "u-owner",
    teamId: TEAM,
    machineId,
    name,
    cron: "0 * * * *",
    timezone: null,
    enabled: over.enabled ?? true,
    notify: "auto",
    taskFileContent: `# ${name}\n\n## Spec\n\nPull your worklist and handle it.`,
  });
}

function productionGateway() {
  return new gateway.MachineGateway({
    scheduleLoop() {}, removeLoop() {}, rearmLoop() {}, async tick() {}, async start() {},
  } as never);
}

async function machine(id: string, token: string) {
  return legacyStore.createMachine({
    id,
    userId: "u-owner",
    teamId: TEAM,
    name: id,
    tokenHash: tokens.sha256(token),
    token,
    online: true,
  });
}

describe("R-due", () => {
  const dueTask = async (watcher: string, over: Record<string, unknown> = {}) => {
    const result = await kernel.createObject({
      teamId: TEAM, kind: "task", actor: HUMAN, now: T0,
      title: "Verify the nightly backup", watcher, followUpAt: DUE, ...over,
    });
    if (!result.ok) throw new Error(result.message);
    return result.object;
  };
  const runsFor = async (loopId: string) =>
    (await database.db.select().from(legacySchema.runs)).filter((run) => run.loopId === loopId);

  it("queues ONE run for the watcher, scoped to the task that came due", async () => {
    const l = await loop();
    const task = await dueTask(l.id);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 1, queued: 1, failed: 0 });
    const runs = await runsFor(l.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      loopId: l.id, phase: "pending", role: "exec", reason: "due", scope: `task:${task.id}`,
      // A date arriving is the CLOCK's entrance, not a person's: nobody entered
      // anything at the moment it fired.
      entrance: "clock", scheduledFor: DUE,
    });
    // The fact lands on the LOOP's timeline, which is where run facts live.
    const events = await store.listObjectEvents(undefined, l.id);
    expect(events.filter((e) => e.kind === "run-queued")).toHaveLength(1);
    expect(events.at(-1)!.payload).toMatchObject({ reason: "due", scope: `task:${task.id}`, followUpAt: DUE });
  });

  /**
   * THE IDEMPOTENCY THE LEVEL TRIGGER RESTS ON. Nothing is consumed by a tick,
   * so the task is still due on the next one — and the derived id
   * (`dueRunId(loop, task, followUpAt)`) is what stops that from minting a run
   * per tick forever.
   */
  it("is idempotent across repeated ticks — one due instant, exactly one run", async () => {
    const l = await loop();
    const task = await dueTask(l.id);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const runId = (await runsFor(l.id))[0]!.id;
    expect(runId).toBe(ids.dueRunId(l.id, task.id, DUE));

    for (const later of [1, 2, 3]) {
      const again = await queue.tickDueTasks(new Date(NOW.getTime() + later * 60_000));
      expect(again.queued).toBe(0);
      expect(again.failed).toBe(0);
    }
    expect(await runsFor(l.id)).toHaveLength(1);
    expect((await store.listObjectEvents(undefined, l.id)).filter((e) => e.kind === "run-queued")).toHaveLength(1);
  });

  it("queues a FRESH run when the follow-up is re-armed — that is how a loop asks again", async () => {
    const l = await loop();
    const task = await dueTask(l.id);
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });

    // The first run finishes, and the loop pushes the task out and back in.
    await database.db.delete(legacySchema.runs);
    const rearmed = "2026-08-03T09:00:00.000Z";
    const moved = await kernel.applyUpdate({ objectId: task.id, actor: HUMAN, now: NOW.toISOString(), fields: { followUpAt: rearmed } });
    expect(moved.ok).toBe(true);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    const runs = await runsFor(l.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(ids.dueRunId(l.id, task.id, rearmed));
    expect(runs[0]!.id).not.toBe(ids.dueRunId(l.id, task.id, DUE));
  });

  it("leaves a future follow-up, and a CLOSED task, alone", async () => {
    const l = await loop();
    await dueTask(l.id, { followUpAt: "2026-08-04T07:00:00.000Z" });
    const done = await dueTask(l.id, { title: "already handled" });
    expect((await kernel.applyTransition({ objectId: done.id, transition: "close", actor: HUMAN, now: T0, note: "done" })).ok).toBe(true);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 0, queued: 0 });
    expect(await runsFor(l.id)).toHaveLength(0);
  });

  /**
   * PAUSE GOVERNS THE CADENCE, and R-due rides the same gate — so a DISABLED
   * watcher is not woken. Nothing is lost by that: the trigger is LEVEL, so the
   * still-due task fires on the first scan after the loop is re-enabled.
   */
  it("does not wake a disabled watcher, and fires on the scan after it is re-enabled", async () => {
    const paused = await loop({ enabled: false });
    await dueTask(paused.id);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 0, queued: 0 });
    expect(await runsFor(paused.id)).toHaveLength(0);

    await legacyStore.updateLoop(paused.id, { enabled: true });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    expect(await runsFor(paused.id)).toHaveLength(1);
  });

  /**
   * A DELETED watcher is the case that really does strand work — which is why
   * pause/finish/delete WARN with the open-watched count (`watchedTasks.ts`).
   * The scan's job here is narrower and is what this pins: skip it, log one
   * line, and mutate NOTHING. The reference dangles by design (no FK, never
   * cascade); the repair is a transfer.
   */
  it("skips a deleted watcher without touching the task it stranded", async () => {
    const gone = await loop({ name: "Deleted" });
    const task = await dueTask(gone.id, { title: "stranded" });
    await legacyStore.deleteLoop(gone.id);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 0, queued: 0, failed: 0 });
    expect(await database.db.select().from(legacySchema.runs)).toHaveLength(0);
    const after = (await store.getObject(undefined, task.id))!;
    expect(after).toMatchObject({ status: "open", watcher: gone.id, followUpAt: DUE });
  });

  it("obeys the one-queued-run discipline, and stays due until it lands", async () => {
    const l = await loop();
    await dueTask(l.id);
    // A cadence fire got there first; the loop is busy.
    await queue.queueKernelRun(database.db as never, { loop: l, now: T0, reason: "manual" });

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 1, queued: 0, skipped: 1 });
    expect(await runsFor(l.id)).toHaveLength(1);

    // That run finishes; nothing was consumed, so the next tick lands it.
    await database.db.delete(legacySchema.runs);
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    expect((await runsFor(l.id))[0]).toMatchObject({ reason: "due" });
  });

  it("hands the claiming daemon the task that woke it, and says WHY", async () => {
    const l = await loop();
    const task = await dueTask(l.id);
    await queue.tickDueTasks(NOW);

    const response = await productionGateway().poll(PROD_TOKEN, { host: "test-daemon" });
    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]).toMatchObject({ loop: { id: l.id }, runId: expect.any(String) });
    // The production prompt preserves the trigger kind and exact task identity.
    expect(body.deliveries[0].task).toContain("Reason: due");
    expect(body.deliveries[0].task).toContain(task.id);
  });

  it("isolates one task's failure — the others still fire, and it stays due", async () => {
    const l = await loop();
    const good = await dueTask(l.id, { title: "fine" });
    // A run id already held by ANOTHER loop is the collision `queueKernelRun`
    // refuses rather than reporting a stranger's run as this fire.
    const other = await loop({ name: "Stranger" });
    const clash = await dueTask(other.id, { title: "collides" });
    await database.db.insert(legacySchema.runs).values({
      id: ids.dueRunId(other.id, clash.id, DUE), loopId: l.id, userId: "u-owner", machineId: "",
      phase: "done", outcome: "exec", role: "exec", ts: T0,
    } as never);

    const result = await queue.tickDueTasks(NOW);
    expect(result.failed).toBe(1);
    expect(result.queued).toBe(1);
    expect((await runsFor(l.id)).some((run) => run.scope === `task:${good.id}`)).toBe(true);
  });
});

