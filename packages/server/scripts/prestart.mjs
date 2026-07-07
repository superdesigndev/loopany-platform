#!/usr/bin/env node
// Pre-start migration gate + the BUILT server's boot-time config guard.
//
// HOSTED Postgres tier (DATABASE_URL set): apply pending migrations over the
// DIRECT/session URL using the SAME postgres-js migrator the app uses at boot
// (db/index.ts `runMigrations`). We deliberately do NOT shell out to
// `drizzle-kit migrate` — its bundled driver hangs/fails against the Supabase
// Supavisor pooler, whereas postgres-js connects cleanly. Running it here (a
// separate pre-serve step) makes a bad migration fail the deploy LOUDLY.
//
// Embedded pglite tier (no DATABASE_URL - light self-host): the database
// migrates IN-PROCESS at boot, so no migration here - but the tier must be
// OPTED INTO with LOOPANY_DB=pglite. The built artifact carries production
// semantics (vite bakes NODE_ENV=production into the bundle), so a missing
// DATABASE_URL secret must fail the container HERE, at startup, loudly -
// db/index.ts has the same refusal, but it sits in a lazily-imported chunk,
// so on its own the container would boot green and only 500 on the first DB
// request. `pnpm start` and the Docker CMD both run this script first, which
// turns that late 500 into a nonzero exit before the server ever serves.
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  if (process.env.LOOPANY_DB !== "pglite") {
    console.error(
      "[prestart] refusing to start on the ephemeral embedded database - " +
        "set DATABASE_URL (hosted Postgres), or LOOPANY_DB=pglite to opt into " +
        "the embedded pglite tier (and point LOOPANY_DATA_DIR at persistent storage)",
    );
    process.exit(1);
  }
  console.log("[prestart] no DATABASE_URL - embedded pglite (LOOPANY_DB=pglite) migrates in-process at boot; skipping");
  process.exit(0);
}

const { default: postgres } = await import("postgres");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");

// DDL + the migrator advisory lock run over the DIRECT (session-mode) URL —
// never the transaction pooler. Falls back to DATABASE_URL for a plain Postgres,
// but FAILS LOUD when that fallback would route DDL over the Supabase transaction
// pooler (it multiplexes connections and cannot hold the migrator's session-scoped
// advisory lock) - mirrors env.ts `directDatabaseUrl()`, which this script can't
// import (it runs unbundled, without the TS build).
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!process.env.DIRECT_DATABASE_URL && (url.includes(":6543") || url.includes("pooler.supabase.com"))) {
  console.error(
    "[prestart] DIRECT_DATABASE_URL is unset but DATABASE_URL points at the Supabase transaction pooler " +
      "(:6543 / pooler.supabase.com) - set DIRECT_DATABASE_URL to the direct (:5432, session-mode) " +
      "connection so migrations run off the pooler",
  );
  process.exit(1);
}
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
