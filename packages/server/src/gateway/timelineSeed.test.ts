/**
 * Legacy-Timeline seeding idempotency — the regression guard for the unbounded
 * event-duplication bug.
 *
 * The seeding dedup used to compare against `listEvents(loopId, {limit: 200})`,
 * the NEWEST 200 rows. Seeded rows carry the Timeline entry's HISTORICAL `at`,
 * so they are the OLDEST rows in the stream: once a loop accumulated 200 newer
 * events they fell out of the window and every task-file sync re-inserted the
 * entire Timeline. Reproduced on a live server as 4 events → 230 after one
 * re-sync past the window.
 *
 * These tests encode exactly that: seed a loop, push it PAST the old 200-row
 * window with unrelated events, re-sync the same Timeline, and assert ZERO new
 * rows — on both surfaces (the live gateway ingest and the migration script's
 * `--execute` pass). The small-stream behaviour is covered alongside so the
 * mechanism is proven to still seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let seedMod: typeof import("./timelineSeed.js");
let migrate: typeof import("../../scripts/migrate-v2-split.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-tlseed-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  seedMod = await import("./timelineSeed.js");
  migrate = await import("../../scripts/migrate-v2-split.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as never as { exec(sql: string): Promise<void> }).exec("DELETE FROM events; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

const noopScheduler = {
  maybeFlagEvolve(): void {},
  finishEvolution(): void {},
  finishEdit(): void {},
  addLoop(): void {},
  removeLoop(): void {},
  runNow(): void {},
} as never;

const gateway = (): import("./index.js").MachineGateway => new gatewayMod.MachineGateway(noopScheduler, undefined);

/** A file-era README: front matter + Spec + an authored `## Timeline`. */
const readme = (...timeline: string[]): string =>
  ["---", "id: old-spike", "title: Old spike", "status: todo", "---", "", "## Spec", "Poke at the thing.", "", "## Timeline", ...timeline, ""].join("\n");

const TWO_LINES = ["- 2026-07-01 | Created.", "- 2026-07-02 | Shipped v1."];

async function seedLoop(): Promise<string> {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({
    userId: "u1",
    machineId,
    cron: "0 9 * * *",
    enabled: true,
    notify: "never",
    taskFile: "/h/loopany/old-spike/README.md",
    // Front matter already at its final work-state, so the ingests under test
    // add ONLY seeded rows (the store chokepoint emits status-changed on a diff).
    taskFileContent: readme(),
  });
  return loop.id;
}

/** Push the loop past the old newest-200 dedup window with unrelated events
 *  NEWER than every seeded (historical) row — one bulk insert, not 226 writes. */
async function padEvents(loopId: string, n: number): Promise<void> {
  const rows = Array.from({ length: n }, (_, i) => `('pad-${i}', '${loopId}', 'run-returned', 'agent:claude-code', '2026-07-26T00:00:00.${String(i).padStart(3, "0")}Z')`);
  await (db.client as never as { exec(sql: string): Promise<void> }).exec(`INSERT INTO events (id, loop_id, type, actor, at) VALUES ${rows.join(",")};`);
}

// ---- the live ingest path (every task-file sync / report) ----

test("re-syncing the same Timeline past 200 events seeds nothing (the duplication bug)", async () => {
  const gw = gateway();
  const loopId = await seedLoop();
  const doc = readme(...TWO_LINES);

  await gw.ingestTaskFileContent(loopId, doc);
  expect(await store.countEvents(loopId)).toBe(2); // both lines seeded once

  // A daily loop emits run-started + run-returned per run, so it crosses 200
  // events in ~100 runs. Past that point the two seeded rows are no longer in
  // the newest-200 window the old dedup read.
  await padEvents(loopId, 226);
  expect(await store.countEvents(loopId)).toBe(228);

  await gw.ingestTaskFileContent(loopId, doc);
  expect(await store.countEvents(loopId)).toBe(228); // was 230 — the whole Timeline re-seeded

  // And it stays flat across further syncs, not merely on the first re-run.
  await gw.ingestTaskFileContent(loopId, doc);
  await gw.ingestTaskFileContent(loopId, doc);
  expect(await store.countEvents(loopId)).toBe(228);
});

test("a NEW Timeline entry still seeds after the loop is past the window", async () => {
  const gw = gateway();
  const loopId = await seedLoop();
  await gw.ingestTaskFileContent(loopId, readme(...TWO_LINES));
  await padEvents(loopId, 226);

  await gw.ingestTaskFileContent(loopId, readme(...TWO_LINES, "- 2026-07-03 | Fixed the leak."));
  expect(await store.countEvents(loopId)).toBe(229);
  // The new row is the OLDEST in the stream (historical `at`), so it is not in
  // any newest-N listing — look it up by its content-derived identity instead.
  const keys = await store.seededTimelineKeys(loopId);
  expect(keys.has(seedMod.timelineSeedKey("2026-07-03T00:00:00.000Z", "Fixed the leak."))).toBe(true);
});

test("rows seeded BEFORE the fix (random ids) still dedup — the keyed query, not just the id", async () => {
  const gw = gateway();
  const loopId = await seedLoop();
  // Exactly what the old code wrote: the source marker, a random id.
  for (const [at, text] of [
    ["2026-07-01T00:00:00.000Z", "Created."],
    ["2026-07-02T00:00:00.000Z", "Shipped v1."],
  ] as const) {
    await store.addEvent({ loopId, type: "note", actor: "agent:claude-code", at, text, data: { source: "timeline" } });
  }
  await padEvents(loopId, 226);

  await gw.ingestTaskFileContent(loopId, readme(...TWO_LINES));
  expect(await store.countEvents(loopId)).toBe(228);
});

test("concurrent syncs converge on one row per entry (deterministic id + ON CONFLICT)", async () => {
  const gw = gateway();
  const loopId = await seedLoop();
  const doc = readme(...TWO_LINES);
  // Both passes read an empty key set before either writes — only the
  // deterministic primary key can keep this from doubling.
  await Promise.all([gw.ingestTaskFileContent(loopId, doc), gw.ingestTaskFileContent(loopId, doc)]);
  expect(await store.countEvents(loopId)).toBe(2);
});

test("seedTimelineEvents reports what it wrote; over-cap text keys on the CLIPPED body", async () => {
  const loopId = await seedLoop();
  const long = "x".repeat(3000);
  const doc = readme(`- 2026-07-01 | ${long}`);
  expect(await seedMod.seedTimelineEvents(loopId, doc, () => "timeline")).toBe(1);
  expect(await seedMod.seedTimelineEvents(loopId, doc, () => "timeline")).toBe(0);
  const [row] = await store.listEvents(loopId, { limit: 5 });
  expect(row!.text).toHaveLength(2000);

  // Undated / empty content seeds nothing at all.
  expect(await seedMod.seedTimelineEvents(loopId, readme("- just a bullet, no date"), () => "timeline")).toBe(0);
  expect(await seedMod.seedTimelineEvents(loopId, null, () => "timeline")).toBe(0);
});

// ---- the migration script's --execute pass (same module, same guarantee) ----

test("migrate-v2-split --execute is a true no-op on re-run past 200 events", async () => {
  const loopId = await seedLoop();
  await store.updateLoop(loopId, { taskFileContent: readme(...TWO_LINES) });
  // updateLoop alone does not seed — the script's first pass does.
  const beforeFirst = await store.countEvents(loopId);

  expect(await migrate.executeSeed()).toBe(0);
  const afterFirst = await store.countEvents(loopId);
  expect(afterFirst - beforeFirst).toBe(2);

  await padEvents(loopId, 226);
  const padded = await store.countEvents(loopId);

  await migrate.executeSeed();
  expect(await store.countEvents(loopId)).toBe(padded); // the idempotency claim, now true
  await migrate.executeSeed();
  expect(await store.countEvents(loopId)).toBe(padded);
});

test("the rehearsal's loss check accepts the daemon's own `- DATE | text` Timeline format", async () => {
  const { splitTaskDoc } = await import("../server/docSplit.js");
  const content = readme(...TWO_LINES);
  const split = splitTaskDoc(content);
  // Every separator docSplit's TIMELINE_LINE accepts must survive the loss check,
  // or the rehearsal exits 1 on rows that migrate perfectly well.
  expect(migrate.lostLines(content, split.doc, split.events, split.representedKeys)).toEqual([]);
  const colons = readme("- 2026-07-01: Created.", "* **2026-07-02** — Shipped v1.");
  const s2 = splitTaskDoc(colons);
  expect(migrate.lostLines(colons, s2.doc, s2.events, s2.representedKeys)).toEqual([]);
});
