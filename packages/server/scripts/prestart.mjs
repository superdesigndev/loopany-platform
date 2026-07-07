#!/usr/bin/env node
// Pre-start migration gate.
//
// HOSTED Postgres tier (DATABASE_URL set): apply pending migrations over the
// DIRECT/session URL using the SAME postgres-js migrator the app uses at boot
// (db/index.ts `runMigrations`). We deliberately do NOT shell out to
// `drizzle-kit migrate` — its bundled driver hangs/fails against the Supabase
// Supavisor pooler, whereas postgres-js connects cleanly. Running it here (a
// separate pre-serve step) makes a bad migration fail the deploy LOUDLY.
//
// Embedded pglite tier (no DATABASE_URL — local dev / light self-host): the
// database migrates IN-PROCESS at boot, so we SKIP here.
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  console.log("[prestart] no DATABASE_URL — embedded pglite migrates in-process at boot; skipping");
  process.exit(0);
}

const { default: postgres } = await import("postgres");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");

// DDL + the migrator advisory lock run over the DIRECT (session-mode) URL —
// never the transaction pooler. Falls back to DATABASE_URL for a plain Postgres.
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

const client = postgres(url, { max: 1 });
try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log("[prestart] migrations applied");
} catch (e) {
  console.error("[prestart] migration failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await client.end();
}
