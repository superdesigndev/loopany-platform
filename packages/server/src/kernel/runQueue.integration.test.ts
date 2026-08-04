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

const TEAM = "team-runs";
const T0 = "2026-08-03T00:00:00.000Z";
const DUE = "2026-08-03T07:00:00.000Z";
const NOW = new Date("2026-08-03T10:00:00.000Z");
const HUMAN = { entrance: "human", actorId: "u-owner" } as const;

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
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

beforeEach(async () => {
  await database.db.delete(schema.events);
  await database.db.delete(schema.objects);
  await database.db.delete(legacySchema.runs);
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
  return result.object;
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
  it("B2: renews a live machine's lease on poll so the original expiry cannot reclaim it", async () => {
    const l = await loop({ nextFire: "2026-08-04T00:00:00.000Z" });
    const m = await machine("m-a", "dk_machine_a");
    const runId = await queueAndClaim(l, m, NOW);
    const originalExpiry = Date.parse((await store.getRunRow(undefined, runId))!.leaseExpiresAt!);
    const heartbeatAt = new Date(originalExpiry - 1_000);
    const heartbeat = await queue.claimRun(m, { agent: "test-daemon", wait: false }, heartbeatAt);
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
    expect(tasks[0]).toMatchObject({ watcher: null, createdByLoop: l.id });
    expect(tasks[0]!.pendingQuestion).toContain("failed 2 consecutive runs");
  });
});
