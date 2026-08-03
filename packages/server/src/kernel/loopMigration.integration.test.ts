/**
 * The production-loop migration end to end, over a REAL pglite store seeded
 * through the shipping `store.createLoop` — so the rows it reads are exactly the
 * shape production has, not a hand-written approximation.
 *
 * The three properties the brief names, each asserted directly:
 *   - MECHANICAL: one `objects` row per `loops` row, mapping per spec §5.5
 *   - IDEMPOTENT: re-running changes nothing, at the row AND the event level
 *   - NEVER DESTRUCTIVE: `loops` is byte-identical afterwards
 * plus the dry run, which must write literally nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let kernelStore: typeof import("../db/kernelStore.js");
let migration: typeof import("./loopMigration.js");
let schema: typeof import("../db/kernel-schema.js");
let loopsTable: typeof import("../db/schema.js").loops;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-loopmig-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_LOG_LEVEL = "silent";

  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  kernelStore = await import("../db/kernelStore.js");
  migration = await import("./loopMigration.js");
  schema = await import("../db/kernel-schema.js");
  loopsTable = (await import("../db/schema.js")).loops;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await db.db.delete(schema.events);
  await db.db.delete(schema.objects);
  await db.db.delete(loopsTable);
});

async function seedLoop(over: Record<string, unknown> = {}) {
  return store.createLoop({
    userId: "u_alice",
    teamId: "team-alpha",
    machineId: "m_1",
    name: "Housekeeper",
    cron: "0 7 * * *",
    timezone: "Asia/Shanghai",
    taskFile: "/repo/loops/hk/README.md",
    ...over,
  } as never);
}

describe("mechanical mapping (spec §5.5)", () => {
  it("turns each loop into exactly ONE objects row with kind=loop", async () => {
    await seedLoop();
    await seedLoop({ name: "React Doctor", cron: "0 6 * * *" });

    const report = await migration.migrateLoopsToObjects();
    expect(report.scanned).toBe(2);
    expect(report.created).toBe(2);
    expect(report.refused).toEqual([]);

    const rows = await db.db.select().from(schema.objects);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "loop")).toBe(true);
  });

  it("keeps the loop id verbatim and carries name/cron/timezone/team", async () => {
    const loop = await seedLoop();
    await migration.migrateLoopsToObjects();

    const obj = (await kernelStore.getObject(undefined, loop.id))!;
    expect(obj.id).toBe(loop.id);
    expect(obj.teamId).toBe("team-alpha");
    expect(obj.title).toBe("Housekeeper");
    expect(obj.cron).toBe("0 7 * * *");
    expect(obj.timezone).toBe("Asia/Shanghai");
    expect(obj.status).toBe("active");
  });

  it("puts the task file's Spec section in the body — a loop's body IS its charter", async () => {
    const loop = await seedLoop();
    await store.updateLoop(loop.id, { taskFileContent: "# HK\n\n## Spec\n\nSweep the repo.\n\n## Log\n\nx" });
    await migration.migrateLoopsToObjects();
    expect((await kernelStore.getObject(undefined, loop.id))!.body).toBe("Sweep the repo.");
  });

  it("maps a paused loop and does not arm it", async () => {
    const loop = await seedLoop({ enabled: false, nextRunAt: "2026-08-04T07:00:00.000Z" });
    await migration.migrateLoopsToObjects();
    const obj = (await kernelStore.getObject(undefined, loop.id))!;
    expect(obj.status).toBe("paused");
    expect(obj.nextFire).toBeNull();
  });

  it("retires a completed (closed) loop and keeps its goal in payload", async () => {
    const loop = await seedLoop({ goal: "ship the redesign" });
    await store.updateLoop(loop.id, { completedAt: "2026-05-01T00:00:00.000Z", completionReason: "done" });
    await migration.migrateLoopsToObjects();
    const obj = (await kernelStore.getObject(undefined, loop.id))!;
    expect(obj.status).toBe("retired");
    expect(obj.payload).toMatchObject({ goal: "ship the redesign", completionReason: "done" });
  });

  it("writes one object-created event per migrated loop, attributed to the migration", async () => {
    const loop = await seedLoop();
    await migration.migrateLoopsToObjects();
    const events = await kernelStore.listObjectEvents(undefined, loop.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("object-created");
    expect(events[0]!.actorId).toBe(migration.MIGRATION_ACTOR.actorId);
    expect(events[0]!.entrance).toBe("human");
  });

  it("falls back to the personal team for a pre-team loop row", async () => {
    const loop = await seedLoop({ teamId: null });
    await migration.migrateLoopsToObjects();
    expect((await kernelStore.getObject(undefined, loop.id))!.teamId).toBe("team-u_alice");
  });
});

describe("idempotency", () => {
  it("re-running creates nothing new and reports the existing rows", async () => {
    await seedLoop();
    await seedLoop({ name: "second" });

    const first = await migration.migrateLoopsToObjects();
    const second = await migration.migrateLoopsToObjects();
    const third = await migration.migrateLoopsToObjects();

    expect(first.created).toBe(2);
    expect(second).toMatchObject({ created: 0, existing: 2, refused: [] });
    expect(third).toMatchObject({ created: 0, existing: 2, refused: [] });
    expect(await db.db.select().from(schema.objects)).toHaveLength(2);
  });

  it("writes no DUPLICATE events on a re-run — the derived creation id swallows it", async () => {
    await seedLoop();
    await migration.migrateLoopsToObjects();
    const after1 = await db.db.select().from(schema.events);
    await migration.migrateLoopsToObjects();
    const after2 = await db.db.select().from(schema.events);
    expect(after2.map((e) => e.id)).toEqual(after1.map((e) => e.id));
  });

  it("does NOT overwrite an already-migrated row (an update is the destructive case in disguise)", async () => {
    const loop = await seedLoop();
    await migration.migrateLoopsToObjects();
    // The kernel side moves on: the charter is evolved after the import.
    const kernel = await import("./applyTransition.js");
    await kernel.applyUpdate({
      objectId: loop.id,
      actor: { entrance: "agent", actorId: "run-1" },
      now: "2026-08-03T00:00:00.000Z",
      fields: { body: "an evolved charter" },
      eventKind: "charter-evolved",
    });
    await store.updateLoop(loop.id, { taskFileContent: "## Spec\nthe OLD prose" });

    await migration.migrateLoopsToObjects();
    expect((await kernelStore.getObject(undefined, loop.id))!.body).toBe("an evolved charter");
  });

  it("picks up a loop created BETWEEN runs, so a re-run is a safe catch-up", async () => {
    await seedLoop();
    await migration.migrateLoopsToObjects();
    await seedLoop({ name: "later" });
    const again = await migration.migrateLoopsToObjects();
    expect(again).toMatchObject({ scanned: 2, created: 1, existing: 1 });
  });
});

describe("never destructive", () => {
  it("leaves the loops table byte-identical", async () => {
    await seedLoop();
    await seedLoop({ name: "second", enabled: false });
    const before = await db.db.select().from(loopsTable);

    await migration.migrateLoopsToObjects();
    await migration.migrateLoopsToObjects();

    expect(await db.db.select().from(loopsTable)).toEqual(before);
  });
});

describe("dry run", () => {
  it("computes the full plan and writes NOTHING", async () => {
    const loop = await seedLoop({ enabled: false });
    const report = await migration.migrateLoopsToObjects({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.scanned).toBe(1);
    expect(report.created).toBe(0);
    expect(report.planned).toHaveLength(1);
    expect(report.planned[0]).toMatchObject({ id: loop.id, status: "paused", cron: "0 7 * * *" });

    expect(await db.db.select().from(schema.objects)).toHaveLength(0);
    expect(await db.db.select().from(schema.events)).toHaveLength(0);
  });

  it("plans the same rows a real run then creates", async () => {
    await seedLoop();
    await seedLoop({ name: "second" });
    const dry = await migration.migrateLoopsToObjects({ dryRun: true });
    const real = await migration.migrateLoopsToObjects();
    expect(real.planned).toEqual(dry.planned);
    expect(real.created).toBe(dry.planned.length);
  });
});

describe("team scoping", () => {
  it("migrates one team at a time for a staged cutover", async () => {
    const a = await seedLoop({ teamId: "team-alpha" });
    const b = await seedLoop({ teamId: "team-beta", name: "beta loop" });

    const report = await migration.migrateLoopsToObjects({ teamId: "team-beta" });
    expect(report).toMatchObject({ scanned: 1, created: 1 });
    expect(await kernelStore.getObject(undefined, b.id)).toBeDefined();
    expect(await kernelStore.getObject(undefined, a.id)).toBeUndefined();
  });
});
