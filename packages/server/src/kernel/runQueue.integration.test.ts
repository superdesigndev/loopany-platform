import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-runs-v2-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  process.env.LOOPANY_FAILURE_AUTOPAUSE_STREAK = "2";
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

async function loop(over: Record<string, unknown> = {}) {
  const result = await kernel.createObject({
    teamId: TEAM,
    kind: "loop",
    actor: HUMAN,
    now: T0,
    title: "Housekeeper",
    cron: "0 * * * *",
    nextFire: DUE,
    body: "Pull your worklist and handle it.",
    ...over,
  });
  if (!result.ok) throw new Error(result.message);
  const machineId = tokens.machineIdFromToken(PROD_TOKEN);
  if (!(await legacyStore.getMachine(machineId))) await machine(machineId, PROD_TOKEN);
  await legacyStore.createLoop({
    id: result.object.id,
    userId: "u-owner",
    teamId: TEAM,
    machineId,
    name: result.object.title ?? "Untitled loop",
    cron: result.object.cron ?? "",
    timezone: result.object.timezone,
    enabled: result.object.status === "active",
    notify: "auto",
    workdir: result.object.workdir,
    taskFile: result.object.workdir ? path.join(result.object.workdir, "loopany-task.md") : null,
    taskFileContent: `# ${result.object.title ?? "Loop"}\n\n## Spec\n\n${result.object.body ?? ""}`,
  });
  return result.object;
}

async function productionLoop(id: string) {
  const value = await legacyStore.getLoop(id);
  if (!value) throw new Error(`missing production twin ${id}`);
  return value;
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

async function queueAndClaim(loopRow: Awaited<ReturnType<typeof loop>>, machineRow: Awaited<ReturnType<typeof machine>>, now: Date) {
  const inserted = await queue.queueKernelRun(database.db as never, {
    loop: loopRow,
    now: now.toISOString(),
    reason: "manual",
  });
  expect(inserted.outcome).toBe("queued");
  const response = await queue.claimRun(machineRow, { agent: "test-daemon" }, now);
  expect(response.status).toBe(200);
  return ((response.body as any).run.id as string);
}

/**
 * R-DUE — a watched task reaching its `follow_up` wakes its watcher (captain
 * ruling 2026-08-04).
 *
 * This is the other half of the watcher rule. Once every task names the loop
 * that acts next, a follow-up date is a real alarm on a named actor, so the
 * scheduler treats it exactly like a cadence: level-triggered, derived-id
 * idempotent, active watchers only.
 */
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
    const l = await loop({ nextFire: null });
    const task = await dueTask(l.id);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 1, queued: 1, failed: 0 });
    const runs = await runsFor(l.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      loopId: l.id, queueState: null, phase: "pending", reason: "due", scope: `task:${task.id}`,
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
    const l = await loop({ nextFire: null });
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
    const l = await loop({ nextFire: null });
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
    const l = await loop({ nextFire: null });
    await dueTask(l.id, { followUpAt: "2026-08-04T07:00:00.000Z" });
    const done = await dueTask(l.id, { title: "already handled" });
    expect((await kernel.applyTransition({ objectId: done.id, transition: "close", actor: HUMAN, now: T0, note: "done" })).ok).toBe(true);

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 0, queued: 0 });
    expect(await runsFor(l.id)).toHaveLength(0);
  });

  /**
   * PAUSE GOVERNS THE CLOCK, and R-due rides the same clock — so a paused
   * watcher is not woken. Nothing is lost by that: the trigger is LEVEL, so the
   * still-due task fires on the first tick after `resume`. RETIRED is excluded
   * by the same predicate and is the case that really does strand work, which is
   * why retiring a loop that still watches open tasks warns.
   */
  it("does not wake a paused or retired watcher, and fires on the tick after a resume", async () => {
    const paused = await loop({ nextFire: null });
    const retired = await loop({ title: "Ended", nextFire: null });
    await dueTask(paused.id);
    await dueTask(retired.id, { title: "stranded" });
    for (const [id, transition] of [[paused.id, "pause"], [retired.id, "retire"]] as const) {
      expect((await kernel.applyTransition({ objectId: id, transition, actor: HUMAN, now: T0 })).ok).toBe(true);
      await legacyStore.updateLoop(id, { enabled: false });
    }

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 0, queued: 0 });
    expect(await runsFor(paused.id)).toHaveLength(0);
    expect(await runsFor(retired.id)).toHaveLength(0);

    expect((await kernel.applyTransition({ objectId: paused.id, transition: "resume", actor: HUMAN, now: NOW.toISOString() })).ok).toBe(true);
    await legacyStore.updateLoop(paused.id, { enabled: true });
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    expect(await runsFor(paused.id)).toHaveLength(1);
    // The retired one stays stranded — the accepted consequence of ruling 3.
    expect(await runsFor(retired.id)).toHaveLength(0);
  });

  it("obeys the one-queued-run discipline, and stays due until it lands", async () => {
    const l = await loop({ nextFire: null });
    await dueTask(l.id);
    // A cadence fire got there first; the loop is busy.
    await queue.queueKernelRun(database.db as never, { loop: await productionLoop(l.id), now: T0, reason: "manual" });

    expect(await queue.tickDueTasks(NOW)).toMatchObject({ scanned: 1, queued: 0, skipped: 1 });
    expect(await runsFor(l.id)).toHaveLength(1);

    // That run finishes; nothing was consumed, so the next tick lands it.
    await database.db.delete(legacySchema.runs);
    expect(await queue.tickDueTasks(NOW)).toMatchObject({ queued: 1 });
    expect((await runsFor(l.id))[0]).toMatchObject({ reason: "due" });
  });

  it("hands the claiming daemon the task that woke it, and says WHY", async () => {
    const l = await loop({ nextFire: null });
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
    const l = await loop({ nextFire: null });
    const good = await dueTask(l.id, { title: "fine" });
    // A run id already held by ANOTHER loop is the collision `queueKernelRun`
    // refuses rather than reporting a stranger's run as this fire.
    const other = await loop({ title: "Stranger", nextFire: null });
    const clash = await dueTask(other.id, { title: "collides" });
    await database.db.insert(legacySchema.runs).values({
      id: ids.dueRunId(other.id, clash.id, DUE), loopId: l.id, userId: "u-owner", machineId: "",
      phase: "pending", role: "exec", ts: T0, queueState: "success",
    } as never);

    const result = await queue.tickDueTasks(NOW);
    expect(result.failed).toBe(1);
    expect(result.queued).toBe(1);
    expect((await runsFor(l.id)).some((run) => run.scope === `task:${good.id}`)).toBe(true);
  });
});

describe("R-clock", () => {
  it("legacy machine polling excludes rewrite queue rows", async () => {
    const l = await loop();
    const base = { loopId: l.id, userId: "u-owner", machineId: "m-poll", role: "exec" as const, ts: T0 };
    await database.db.insert(legacySchema.runs).values([
      { ...base, id: "run-legacy", phase: "pending" },
      { ...base, id: "run-rewrite", phase: "pending", queueState: "queued", scope: "routine", reason: "manual", entrance: "human" },
    ]);
    expect((await legacyStore.pendingRunsForMachine("m-poll")).map((run) => run.id)).toEqual(["run-legacy"]);
  });

  it("B1: stays disabled by default and legacy sweep ownership excludes v2 rows", async () => {
    expect(queue.runsV2Enabled({})).toBe(false);
    expect(queue.runsV2Enabled({ LOOPANY_RUNS_V2: "1" })).toBe(true);
    const l = await loop();
    await queue.queueKernelRun(database.db as never, { loop: l, now: T0, reason: "manual" });
    await database.db.insert(legacySchema.runs).values({
      id: "run-legacy-open",
      loopId: l.id,
      userId: "u-owner",
      machineId: "m-legacy",
      phase: "pending",
      role: "exec",
      ts: T0,
    });
    expect((await legacyStore.openRuns()).map((r) => r.id)).toEqual(["run-legacy-open"]);
  });

  it("arms loop creation, resume, and migrated unarmed cutover after now", async () => {
    const created = await kernel.createObject({
      teamId: TEAM,
      kind: "loop",
      actor: HUMAN,
      now: T0,
      title: "Created armed",
      cron: "0 * * * *",
      body: "charter",
    });
    expect(created.ok && Date.parse(created.object.nextFire!)).toBeGreaterThan(Date.parse(T0));

    const l = await loop();
    await kernel.applyTransition({ objectId: l.id, transition: "pause", actor: HUMAN, now: DUE });
    const resumed = await kernel.applyTransition({ objectId: l.id, transition: "resume", actor: HUMAN, now: NOW.toISOString() });
    expect(resumed.ok && Date.parse(resumed.object.nextFire!)).toBeGreaterThan(NOW.getTime());

    const migrated = await loop({ id: "loop-migrated-unarmed", nextFire: null });
    expect(migrated.nextFire).toBeNull();
    expect(await queue.armUnarmedLoops(NOW)).toBe(1);
    expect(Date.parse((await store.getObject(undefined, migrated.id))!.nextFire!)).toBeGreaterThan(NOW.getTime());
  });

  it("does one level-triggered catch-up and advances after now (C5 shape)", async () => {
    const l = await loop();
    const result = await queue.tickRunClock(NOW);
    // `failed` counts fires the queue REFUSED (an identity collision, or any
    // transaction error): zero on every healthy tick.
    expect(result).toEqual({ scanned: 1, queued: 1, skipped: 0, replayed: 0, failed: 0 });
    const rows = await database.db.select().from(legacySchema.runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ loopId: l.id, queueState: "queued", scheduledFor: DUE, reason: "clock" });
    const advanced = await store.getObject(undefined, l.id);
    expect(Date.parse(advanced!.nextFire!)).toBeGreaterThan(NOW.getTime());
  });

  it("deduplicates the queue, records clock-skipped, and still advances", async () => {
    const l = await loop();
    await queue.queueKernelRun(database.db as never, { loop: l, now: T0, reason: "manual" });
    const result = await queue.tickRunClock(NOW);
    expect(result.skipped).toBe(1);
    expect(await database.db.select().from(legacySchema.runs)).toHaveLength(1);
    expect((await store.listObjectEvents(undefined, l.id)).map((e) => e.kind)).toContain("clock-skipped");
    expect(Date.parse((await store.getObject(undefined, l.id))!.nextFire!)).toBeGreaterThan(NOW.getTime());
  });
});

describe("claim leases", () => {
  it("B2: renews an ATTESTED lease on poll so the original expiry cannot reclaim it", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const originalExpiry = Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!);
    const heartbeatAt = new Date(originalExpiry - 1_000);
    const heartbeat = await queue.claimRun(m, { agent: "test-daemon", wait: false, inFlight: [runId] }, heartbeatAt);
    expect(heartbeat).toMatchObject({ status: 200, body: { run: null } });
    const renewedExpiry = Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!);
    expect(renewedExpiry).toBeGreaterThan(originalExpiry);
    expect(await queue.reclaimExpired(new Date(originalExpiry + 1))).toBe(0);
    expect((await store.getRunRow(undefined, runId))!.queueState).toBe("claimed");
  });

  it("reclaims an expired claim into the queue and increments attempts", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    expect((await store.getRunRow(undefined, runId))!.attempts).toBe(1);
    expect(await queue.reclaimExpired(new Date(NOW.getTime() + queue.RUN_LEASE_MS + 1))).toBe(1);
    expect(await store.getRunRow(undefined, runId)).toMatchObject({ queueState: "queued", attempts: 2, claimedBy: null });
  });

  it("refuses a zombie finish with typed 409 LEASE_LOST", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const late = new Date(NOW.getTime() + queue.RUN_LEASE_MS + 1);
    await queue.reclaimExpired(late);
    const result = await queue.finishRun(m, runId, runId, { outcome: "success", summary: "late" }, late);
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ code: "LEASE_LOST", message: expect.any(String), issues: [], hint: expect.any(String) });
  });
});

/**
 * Review F1: a lease answers "is this RUN still being executed?", not "is this
 * machine up". A daemon that dies mid-run comes back with an empty in-flight
 * set, so before attestation its own polls renewed the run it had LOST — the
 * orphan showed "running" forever.
 */
describe("F1: only an ATTESTED run keeps its lease", () => {
  it("reclaims a run the restarted daemon no longer attests to, and lets it be re-claimed", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const firstExpiry = Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!);

    // The daemon dies here. It restarts with an empty in-flight set and keeps
    // polling on its normal cadence — the exact shape that used to renew forever.
    for (let elapsed = 60_000; elapsed < queue.RUN_LEASE_MS; elapsed += 60_000) {
      const poll = await queue.claimRun(m, { agent: "test-daemon", wait: false, inFlight: [] }, new Date(NOW.getTime() + elapsed));
      expect(poll).toMatchObject({ status: 200, body: { run: null } });
    }
    // Not renewed by any of those polls: the expiry is exactly where the claim left it.
    expect(Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!)).toBe(firstExpiry);

    // Past the lease, the orphan is reclaimed rather than kept alive.
    const past = new Date(firstExpiry + 1);
    expect(await queue.reclaimExpired(past)).toBe(1);
    expect(await store.getRunRow(undefined, runId)).toMatchObject({ queueState: "queued", claimedBy: null, attempts: 2 });

    // And the work is not lost: the next poll claims the same run again.
    const reclaimed = await queue.claimRun(m, { agent: "test-daemon-restarted", wait: false, inFlight: [] }, past);
    expect(reclaimed.status).toBe(200);
    expect((reclaimed.body as any).run).toMatchObject({ id: runId, attempts: 3 });
  });

  it("never reclaims an attested run mid-execution, however long it takes", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);

    // A claude run can outlast several lease windows. Each poll attests, so each
    // poll pushes the expiry forward — and reclaim (which runs inside the same
    // claim transaction) never touches it.
    let previousExpiry = Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!);
    for (let elapsed = queue.RUN_LEASE_MS / 2; elapsed < queue.RUN_LEASE_MS * 3; elapsed += queue.RUN_LEASE_MS / 2) {
      const at = new Date(NOW.getTime() + elapsed);
      await queue.claimRun(m, { agent: "test-daemon", wait: false, inFlight: [runId] }, at);
      const row = (await store.getRunRow(undefined, runId))!;
      expect(row).toMatchObject({ queueState: "claimed", phase: "running", attempts: 1 });
      expect(Date.parse(row.leaseExpiresAt!)).toBeGreaterThan(previousExpiry);
      previousExpiry = Date.parse(row.leaseExpiresAt!);
    }
    // A standalone reclaim at the far end agrees: the run is alive.
    expect(await queue.reclaimExpired(new Date(NOW.getTime() + queue.RUN_LEASE_MS * 3))).toBe(0);
    expect((await store.getRunRow(undefined, runId))!.queueState).toBe("claimed");
  });

  it("attesting to another machine's run renews nothing", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const holder = await machine("m-a", "dk_machine_a");
    const stranger = await machine("m-b", "dk_machine_b");
    const runId = await queueAndClaim(l, holder, NOW);
    const expiry = Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!);
    await queue.claimRun(stranger, { agent: "other-daemon", wait: false, inFlight: [runId] }, new Date(expiry - 1_000));
    expect(Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!)).toBe(expiry);
  });

  it("ignores a malformed attestation instead of trusting it", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const expiry = Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!);
    for (const inFlight of [undefined, [], ["   "], [42 as never], "not-an-array" as never]) {
      await queue.claimRun(m, { agent: "test-daemon", wait: false, inFlight }, new Date(expiry - 1_000));
      expect(Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!)).toBe(expiry);
    }
    // The attestation reader is bounded and deduped, so a hostile body cannot
    // turn the renew into an unbounded IN list.
    expect(queue.attestedRunIds({ inFlight: Array.from({ length: 500 }, (_, i) => `run-${i}`) })).toHaveLength(64);
    expect(queue.attestedRunIds({ inFlight: [runId, runId, ` ${runId} `] })).toEqual([runId]);
  });

  it("the SCHEDULER reclaims a dead lease with no daemon polling at all", async () => {
    // Before this, `reclaimExpired` had no production caller: reclaim only ran
    // inside `claimOnce`, so a team whose only machine died never reclaimed
    // anything. The scheduler's own tick now owns it.
    const l = await loop({ nextFire: "2027-01-01T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    // Claimed far enough in the past that the lease is expired against the real
    // clock the scheduler ticks on.
    const runId = await queueAndClaim(l, m, new Date(Date.now() - queue.RUN_LEASE_MS * 4));
    expect((await store.getRunRow(undefined, runId))!.queueState).toBe("claimed");

    const scheduler = new queue.RunQueueScheduler();
    const ac = new AbortController();
    try {
      await scheduler.start(ac.signal);
    } finally {
      ac.abort();
    }
    expect(await store.getRunRow(undefined, runId)).toMatchObject({ queueState: "queued", claimedBy: null });
  });
});

describe("the claim delivers the loop's BOUND directory, and is the v2 enrollment surface", () => {
  it("hands the machine the workdir the loop binds, marked required", async () => {
    // Captain ruling 2026-08-04: the loop's own column decides WHERE the agent
    // runs — not the free-zone payload, which a charter could move past the
    // governance gate.
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z", workdir: "/Users/me/Workspace/repo", payload: { workdir: "/tmp/impostor", agent: "claude-code" } });
    const m = await machine("m-a", "dk_machine_a");
    await queue.queueKernelRun(database.db as never, { loop: l, now: NOW.toISOString(), reason: "manual" });
    const response = await queue.claimRun(m, { agent: "test-daemon" }, NOW);
    expect((response.body as any).execution).toMatchObject({ workdir: "/Users/me/Workspace/repo", requireWorkdir: true });
  });

  it("leaves an unbound loop unbound, so the daemon may use its own scratch dir", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    await queue.queueKernelRun(database.db as never, { loop: l, now: NOW.toISOString(), reason: "manual" });
    const response = await queue.claimRun(m, { agent: "test-daemon" }, NOW);
    expect((response.body as any).execution).toMatchObject({ workdir: null, requireWorkdir: false });
  });

  it("self-registers a brand-new machine, because a v2 daemon polls nothing else", async () => {
    // Before this the rewrite line had no enrollment surface at all: the daemon
    // never calls /api/machine/poll under LOOPANY_RUNS_V2, so first contact 401'd
    // forever and no machine could ever claim.
    const token = "dk_" + "f".repeat(48);
    expect(await queue.authenticateDevice(token)).toBeUndefined();
    const enrolled = await queue.enrollDeviceForClaim(token, { host: "laptop", version: "0.13.0" });
    expect(enrolled).toMatchObject({ id: tokens.machineIdFromToken(token), name: "laptop", online: true });
    // Idempotent: the second contact resolves the SAME machine, never a twin.
    expect((await queue.enrollDeviceForClaim(token, { host: "laptop" }))!.id).toBe(enrolled!.id);
    expect(await queue.authenticateDevice(token)).toBeTruthy();
  });

  it("refuses a malformed token rather than minting a machine for it", async () => {
    expect(await queue.enrollDeviceForClaim("not-a-device-token")).toBeUndefined();
    expect(await queue.enrollDeviceForClaim("")).toBeUndefined();
  });
});

/**
 * PAUSE GOVERNS THE CADENCE, NOT THE CLAIM (captain ruling 2026-08-04).
 *
 * A manual fire is now accepted on a paused loop, so the queued row it leaves
 * has to be genuinely executable — a claim filter keyed on `active` would turn
 * the accepted fire into a row that waits forever, which is worse than the old
 * honest refusal. The clock half of pause is unchanged and pinned here beside
 * it: `tickRunClock` still selects `active` only, so a paused loop never fires
 * on its own and the manual run does not restore its cadence.
 */
describe("a paused loop's manual run is claimable, and pause still stops the clock", () => {
  it("claims and finishes a run queued on a paused loop, leaving it paused", async () => {
    const l = await loop();
    await kernel.applyTransition({ objectId: l.id, transition: "pause", actor: HUMAN, now: T0 });
    const paused = (await store.getObject(undefined, l.id))!;
    expect(paused).toMatchObject({ status: "paused", nextFire: null });

    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(paused, m, NOW);
    const finished = await queue.finishRun(m, runId, runId, { outcome: "success", summary: "one manual pass" }, NOW);
    expect(finished.status).toBe(200);
    expect(await store.getRunRow(undefined, runId)).toMatchObject({ queueState: "success" });

    // One run, then quiet again: the cadence was never restored.
    expect(await store.getObject(undefined, l.id)).toMatchObject({ status: "paused", nextFire: null });
  });

  it("never hands out a RETIRED loop's run, and the clock never selects a paused loop", async () => {
    const retired = await loop();
    await kernel.applyTransition({ objectId: retired.id, transition: "retire", actor: HUMAN, now: T0 });
    await queue.queueKernelRun(database.db as never, { loop: retired, now: NOW.toISOString(), reason: "manual" });
    const m = await machine("m-a", "dk_machine_a");
    expect(((await queue.claimRun(m, { agent: "test-daemon" }, NOW)).body as any).run).toBeNull();

    // The clock half: a paused loop is due on paper and still never fires.
    const parked = await loop({ id: "loop-parked-clock" });
    await kernel.applyTransition({ objectId: parked.id, transition: "pause", actor: HUMAN, now: T0 });
    expect(await queue.tickRunClock(NOW)).toMatchObject({ scanned: 0, queued: 0 });
  });
});

describe("finish", () => {
  it("a non-string report format falls back to plain Markdown and cannot wedge finish", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const raw = "---\ntitle: Odd report\nformat: 42\n---\n\nResult";
    const result = await queue.finishRun(m, runId, runId, { outcome: "success", report: { body: raw } }, new Date(NOW.getTime() + 1_000));
    expect(result.status).toBe(200);
    const doc = await store.getObject(undefined, (await store.getRunRow(undefined, runId))!.reportDocId!);
    expect(doc).toMatchObject({ format: "markdown", body: raw });
  });

  it("B3: treats ordinary product front matter as raw Markdown and still terminates the run", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const ordinary = "---\ntype: report\ntitle: Daily result\ndate: 2026-08-03\n---\n\n## Result\nDone.";
    const result = await queue.finishRun(
      m,
      runId,
      runId,
      { outcome: "success", summary: "done", report: { title: "Daily result", body: ordinary } },
      new Date(NOW.getTime() + 1_000),
    );
    expect(result.status).toBe(200);
    const run = await store.getRunRow(undefined, runId);
    expect(run!.queueState).toBe("success");
    expect(await store.getObject(undefined, run!.reportDocId!)).toMatchObject({
      kind: "doc",
      format: "markdown",
      body: ordinary,
    });
  });

  it("ingests a structured artifact report as a created_by_run doc", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const result = await queue.finishRun(
      m,
      runId,
      runId,
      {
        outcome: "success",
        summary: "finished",
        report: { body: "---\ntitle: Structured report\npayload:\n  count: 2\n---\n\nHello" },
        cost: { usd: 0.42, inputTokens: 10 },
      },
      new Date(NOW.getTime() + 1_000),
    );
    expect(result.status).toBe(200);
    const run = await store.getRunRow(undefined, runId);
    const doc = await store.getObject(undefined, run!.reportDocId!);
    expect(doc).toMatchObject({ kind: "doc", title: "Structured report", createdByRun: runId, payload: { count: 2 } });
    expect(doc!.body).toContain("Hello");
    expect(run!.runCost).toEqual({ usd: 0.42, inputTokens: 10 });
  });

  it("falls back to plain Markdown when the output has no artifact head", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const result = await queue.finishRun(
      m,
      runId,
      runId,
      { outcome: "success", report: { title: "Plain", body: "## Result\nAll good." } },
      new Date(NOW.getTime() + 1_000),
    );
    expect(result.status).toBe(200);
    const doc = await store.getObject(undefined, (await store.getRunRow(undefined, runId))!.reportDocId!);
    expect(doc).toMatchObject({ title: "Plain", format: "markdown", body: "## Result\nAll good." });
  });

  it("auto-pauses after the configured failure streak and creates one inbox question task", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const first = await queueAndClaim(l, m, NOW);
    expect((await queue.finishRun(m, first, first, { outcome: "failure", summary: "one" }, new Date(NOW.getTime() + 1_000))).status).toBe(200);
    const secondAt = new Date(NOW.getTime() + 2_000);
    const second = await queueAndClaim((await store.getObject(undefined, l.id))!, m, secondAt);
    const result = await queue.finishRun(m, second, second, { outcome: "failure", summary: "two" }, new Date(NOW.getTime() + 3_000));
    expect(result.status).toBe(200);
    expect((result.body as any).autoPaused).toMatchObject({ loop: l.id, streak: 2 });
    expect(await store.getObject(undefined, l.id)).toMatchObject({ status: "paused", nextFire: null });
    const tasks = await database.db.select().from(schema.objects).where((await import("drizzle-orm")).eq(schema.objects.kind, "task"));
    expect(tasks).toHaveLength(1);
    // The question is watched by the loop it is ABOUT — the watcher rule's
    // default, and the right answer on the merits: the question is "fix the
    // cause and resume it?", so the answer should reach that loop.
    expect(tasks[0]).toMatchObject({ watcher: l.id, createdByLoop: l.id });
    expect(tasks[0]!.pendingQuestion).toContain("failed 2 consecutive runs");
  });
});
