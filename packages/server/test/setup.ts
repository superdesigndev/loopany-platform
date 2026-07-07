// Force the embedded pglite tier for all tests, never a real Postgres: a stray
// DATABASE_URL in the dev/CI shell would otherwise point db/index.ts at a live
// database.
delete process.env.DATABASE_URL;
