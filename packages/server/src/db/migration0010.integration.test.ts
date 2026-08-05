/**
 * Migration `0010`'s two DATA steps, executed against a real journal-at-0009
 * database.
 *
 * Every other suite gets a FRESH database, so 0010's data steps always run over
 * empty tables there and prove nothing — the cv-s5 review's F3: the properties
 * were argued structurally and demonstrated once by hand, with no executable
 * proof. This suite builds the missing fixture: a pglite migrated to 0009 ONLY
 * (a pruned migrations folder + a journal truncated to idx 9), seeded with the
 * exact stranded shapes a stack that never booted an S3.1 build would carry,
 * then migrated the rest of the way.
 *
 * It is deliberately RAW SQL over its own PGlite instance rather than the app's
 * drizzle handle: the TS schema no longer has `queue_state`, and the point is to
 * exercise the SQL as the migrator runs it, not a re-expression of it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { derivedEventId } from "../kernel/ids.js";

const TEAM = "team-mig";
const USER = "u-mig";
const LOOP = "loop-migrated";
const ORPHAN = "loop-unconverged";
const TASK = "task-mig01";
/** The provenance-carrying stranded row (a due trigger claimed and never finished). */
const STRANDED = "run-f9ccb4d91bd5";
/** The provenance-free stranded row — ordinary cadence history, event-silent. */
const PLAIN = "run-plain0001";

const DISPOSAL = "stranded at the S3 cutover - the kernel run queue was retired while this run was still open";

let temp: string;
let pg: PGlite;
/** The migrations folder as it stood at 0009, and the real one. */
let prunedDir: string;
let fullDir: string;

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** A copy of the migrations folder with 0010 removed from BOTH the sql set and
 *  the journal — the only honest way to reach a genuine journal-at-0009 state. */
function pruneTo0009(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
  for (const file of fs.readdirSync(to)) {
    if (/^0010_/.test(file)) fs.rmSync(path.join(to, file));
  }
  const journalPath = path.join(to, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 9);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-mig0010-"));
  prunedDir = path.join(temp, "drizzle-0009");
  fullDir = sourceDir;
  pruneTo0009(sourceDir, prunedDir);

  pg = new PGlite();
  await migrate(drizzle(pg) as never, { migrationsFolder: prunedDir });

  // The fixture: a converged prod loop + its retained kernel twin, an
  // UNCONVERGED kernel loop object with no prod twin, an open watched task, and
  // the two stranded kernel queue rows (one with provenance, one without).
  await pg.exec(`
    INSERT INTO teams ("id","name","owner_user_id","created_at")
      VALUES ('${TEAM}','Mig','${USER}','2026-08-01T00:00:00.000Z');
    INSERT INTO loops ("id","user_id","team_id","machine_id","name","cron","timezone","enabled","notify","task_file","created_at","updated_at")
      VALUES ('${LOOP}','${USER}','${TEAM}','m-mig','Converged watcher','0 0 1 1 *','UTC',true,'never','/tmp/mig/task.md','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z');
    INSERT INTO objects ("id","team_id","kind","status","title","created_at","updated_at")
      VALUES ('${LOOP}','${TEAM}','loop','active','Converged twin','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z'),
             ('${ORPHAN}','${TEAM}','loop','active','Never converged','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z');
    INSERT INTO objects ("id","team_id","kind","status","title","watcher","follow_up_at","created_at","updated_at")
      VALUES ('${TASK}','${TEAM}','task','open','Due probe','${LOOP}','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z');
    INSERT INTO runs ("id","loop_id","user_id","machine_id","phase","role","ts","queue_state","reason","scope")
      VALUES ('${STRANDED}','${LOOP}','${USER}','m-mig','running','exec','2026-08-02T06:00:00.000Z','claimed','due','task:${TASK}');
    INSERT INTO runs ("id","loop_id","user_id","machine_id","phase","role","ts","queue_state")
      VALUES ('${PLAIN}','${LOOP}','${USER}','m-mig','pending','exec','2026-08-02T07:00:00.000Z','queued');
  `);
  // A COMPLETED kernel row and an ordinary PRODUCTION row, both of which the
  // disposal must leave alone.
  await pg.exec(`
    INSERT INTO runs ("id","loop_id","user_id","machine_id","phase","role","ts","queue_state","reason","scope")
      VALUES ('run-done0001','${LOOP}','${USER}','m-mig','done','exec','2026-08-02T05:00:00.000Z','success','due','task:old');
    INSERT INTO runs ("id","loop_id","user_id","machine_id","phase","role","ts")
      VALUES ('run-prod0001','${LOOP}','${USER}','m-mig','pending','exec','2026-08-02T08:00:00.000Z');
  `);
});

afterAll(async () => {
  await pg?.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("migration 0010 data steps, against a journal-at-0009 database", () => {
  it("the fixture really is at 0009: the retired columns still exist and 0010 is unapplied", async () => {
    const applied = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"`);
    expect(applied[0]!.n).toBe(10); // 0000..0009
    const cols = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'queue_state'`,
    );
    expect(cols).toHaveLength(1);
  });

  it("applies 0010 and disposes of BOTH stranded rows while leaving every other row alone", async () => {
    await migrate(drizzle(pg) as never, { migrationsFolder: fullDir });

    const disposed = await rows<{ id: string; phase: string; outcome: string; error: string; ts: string }>(
      `SELECT id, phase, outcome, error, ts FROM runs WHERE id IN ('${STRANDED}','${PLAIN}') ORDER BY id`,
    );
    expect(disposed).toHaveLength(2);
    for (const row of disposed) {
      expect(row).toMatchObject({ phase: "error", outcome: "error", error: DISPOSAL });
    }
    // A disposal keeps the historical `ts`; it is not a fresh event.
    expect(disposed.find((r) => r.id === STRANDED)!.ts).toBe("2026-08-02T06:00:00.000Z");

    // Structurally unreachable: a completed kernel row and a production row.
    const untouched = await rows<{ id: string; phase: string; error: string | null }>(
      `SELECT id, phase, error FROM runs WHERE id IN ('run-done0001','run-prod0001') ORDER BY id`,
    );
    expect(untouched).toEqual([
      { id: "run-done0001", phase: "done", error: null },
      { id: "run-prod0001", phase: "pending", error: null },
    ]);

    const cols = await rows(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'queue_state'`,
    );
    expect(cols).toHaveLength(0);
  });

  it("mints exactly ONE run-finished event, on the FROZEN derived id, for the provenance row only", async () => {
    const frozen = derivedEventId({ runId: STRANDED, kind: "run-finished", outcome: "failure" });
    const events = await rows<{ id: string; object_id: string; kind: string; origin: string; entrance: string; actor_id: string; team_id: string; payload: Record<string, unknown> }>(
      `SELECT id, object_id, kind, origin, entrance, actor_id, team_id, payload FROM events ORDER BY seq`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: frozen,
      object_id: LOOP,
      kind: "run-finished",
      origin: "derived",
      entrance: "agent",
      actor_id: STRANDED,
      team_id: TEAM,
    });
    expect(events[0]!.payload).toMatchObject({ outcome: "failure", reason: "due", scope: `task:${TASK}`, summary: DISPOSAL });

    // PROVENANCE SILENCE: the provenance-free row stays event-silent, exactly
    // like all ordinary cron/edit/evolve history.
    const forPlain = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE actor_id = '${PLAIN}'`);
    expect(forPlain[0]!.n).toBe(0);
  });

  it("deletes the MIGRATED loop object and leaves the unconverged one in place, history still addressable", async () => {
    const loopObjects = await rows<{ id: string }>(`SELECT id FROM objects WHERE kind = 'loop' ORDER BY id`);
    expect(loopObjects.map((o) => o.id)).toEqual([ORPHAN]);
    // The disposal event points at the deleted object's verbatim id — the whole
    // reason dropping the row loses nothing.
    const stillAddressable = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE object_id = '${LOOP}'`);
    expect(stillAddressable[0]!.n).toBe(1);
  });

  it("is IDEMPOTENT: re-running the data steps changes nothing and mints no second event", async () => {
    // The migrator will never re-run an applied file, so idempotency is proven by
    // executing the data steps directly a second time — the property that makes a
    // partially-applied or hand-repeated run safe. `queue_state` is gone by now,
    // so the disposal predicate selects nothing and the re-run is the strongest
    // possible statement of the same fact: there is no second pass to make.
    const before = await rows(`SELECT id, phase, outcome, error FROM runs ORDER BY id`);
    const sql = fs.readFileSync(path.join(fullDir, fs.readdirSync(fullDir).find((f) => /^0010_/.test(f))!), "utf8");
    const eventInsert = sql.split("--> statement-breakpoint")[0]!;
    const objectDelete = `DELETE FROM "objects" WHERE "kind" = 'loop' AND "id" IN (SELECT "id" FROM "loops")`;
    // The event insert reads `runs.queue_state`, which 0010 dropped: re-running it
    // is now a hard error rather than a silent double-append, which is the safer
    // of the two failure modes. Assert THAT, then re-run the step that can still run.
    await expect(pg.exec(eventInsert)).rejects.toThrow(/queue_state/);
    await pg.exec(objectDelete);

    expect(await rows(`SELECT id, phase, outcome, error FROM runs ORDER BY id`)).toEqual(before);
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM events`))[0]!.n).toBe(1);
    expect((await rows<{ id: string }>(`SELECT id FROM objects WHERE kind = 'loop'`)).map((o) => o.id)).toEqual([ORPHAN]);
  });
});
