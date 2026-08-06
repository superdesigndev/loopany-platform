/** Proves the charter migration's data backfill against a real journal-at-0010 DB. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
let temp: string;
let pg: PGlite;

function pruneTo0010(to: string): void {
  fs.cpSync(sourceDir, to, { recursive: true });
  for (const file of fs.readdirSync(to)) if (/^0011_/.test(file)) fs.rmSync(path.join(to, file));
  const journalPath = path.join(to, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 10);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
}

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-mig0011-"));
  const old = path.join(temp, "drizzle-0010");
  pruneTo0010(old);
  pg = new PGlite();
  await migrate(drizzle(pg) as never, { migrationsFolder: old });
  await pg.exec(`
    INSERT INTO objects (id, team_id, kind, status, title, format, body, created_at, updated_at)
      VALUES ('doc-oldproduct','team-mig','doc','current','Old product','markdown','body','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z');
    INSERT INTO objects (id, team_id, kind, status, title, watcher, created_at, updated_at)
      VALUES ('task-oldtask','team-mig','task','open','Old task','loop-old','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z');
  `);
  await migrate(drizzle(pg) as never, { migrationsFolder: sourceDir });
});

afterAll(async () => {
  await pg?.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("migration 0011 charter doc classification", () => {
  it("backfills existing docs to product and leaves every non-doc classification null", async () => {
    const rows = (await pg.query<{ id: string; doc_kind: string | null }>(`SELECT id, doc_kind FROM objects ORDER BY id`)).rows;
    expect(rows).toEqual([
      { id: "doc-oldproduct", doc_kind: "product" },
      { id: "task-oldtask", doc_kind: null },
    ]);
  });

  it("enforces required classification and one charter per loop", async () => {
    await expect(pg.exec(`INSERT INTO objects (id,team_id,kind,status,created_at,updated_at) VALUES ('doc-bad','team-mig','doc','current','x','x')`)).rejects.toMatchObject({ constraint: "objects_doc_kind_required" });
    await pg.exec(`INSERT INTO objects (id,team_id,kind,doc_kind,status,format,key,created_by_loop,created_at,updated_at) VALUES ('doc-charter1','team-mig','doc','charter','current','markdown','loop-charter:loop-old','loop-old','x','x')`);
    await expect(pg.exec(`INSERT INTO objects (id,team_id,kind,doc_kind,status,format,key,created_by_loop,created_at,updated_at) VALUES ('doc-charter2','team-mig','doc','charter','current','markdown','loop-charter:loop-other','loop-old','x','x')`)).rejects.toThrow();
  });
});
