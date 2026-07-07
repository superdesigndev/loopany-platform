import { defineConfig } from "drizzle-kit";

// The drizzle-kit CLI (db:generate / db:migrate) targets Postgres. `db:generate`
// only diffs the schema → SQL (no DB needed). `db:migrate` runs DDL over the
// DIRECT (session-mode, :5432) URL — the migrator's advisory lock + DDL must NOT
// go through the transaction pooler. The embedded pglite tier migrates in-process
// (see db/index.ts `runMigrations`), not via this CLI.
const url = process.env.DIRECT_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url },
});
