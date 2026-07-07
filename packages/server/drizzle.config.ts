import { defineConfig } from "drizzle-kit";

import { directDatabaseUrl } from "./src/env";

// The drizzle-kit CLI (db:generate / db:migrate) targets Postgres. `db:generate`
// only diffs the schema → SQL (no DB needed). `db:migrate` runs DDL over the
// DIRECT (session-mode, :5432) URL — the migrator's advisory lock + DDL must NOT
// go through the transaction pooler: `directDatabaseUrl()` THROWS when the
// DATABASE_URL fallback would silently route DDL over a Supabase transaction
// pooler (prestart.mjs replicates the same guard for the deploy path). The
// embedded pglite tier migrates in-process (db/index.ts `runMigrations`), not
// via this CLI.
const url = directDatabaseUrl() ?? "";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url },
});
