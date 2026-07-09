import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Force the embedded pglite tier for all tests, never a real Postgres: a stray
// DATABASE_URL in the dev/CI shell would otherwise point db/index.ts at a live
// database.
delete process.env.DATABASE_URL;

// Isolate the data dir per vitest worker: without this, any test that reaches
// db/index.ts through a STATIC import chain (e.g. notify.test.ts -> notify.ts ->
// store.ts) opens a PGlite on the developer's REAL ~/.adscaile/pgdata - the same
// live data dir a running `pnpm dev` uses (pglite data dirs are single-instance,
// so a concurrent open risks corrupting the dev database, and test rows would
// pollute it either way). Test files that mkdtemp their own dir before
// dynamically importing the db still override this per-file value.
process.env.ADSCAILE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "adscaile-test-"));
