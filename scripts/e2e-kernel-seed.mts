/**
 * E2E seed for the GATED packed run (cross-team wall scenario): pre-register
 * connect keys into the pglite dir BEFORE the server boots, so each device
 * token enrolls into its own user's personal team exactly like a production
 * connect flow - the gate stays ON and unknown tokens still 401.
 *
 * pglite is SINGLE-WRITER: this process must fully exit (close() flushes to
 * fs) before the server opens the same dir.
 *
 * Usage: LOOPANY_DATA_DIR=<dir> LOOPANY_DB_PATH=<db> \
 *          npx tsx scripts/e2e-kernel-seed.mts userA=dk_... userB=dk_...
 */
process.env.LOOPANY_LOG_LEVEL = "silent";

const pairs = process.argv.slice(2);
if (pairs.length === 0) {
  console.error("usage: e2e-kernel-seed.mts <userId=dk_token> ...");
  process.exit(2);
}

const db = await import("../packages/server/src/db/index.js");
await db.runMigrations();
const store = await import("../packages/server/src/db/store.js");
const tokens = await import("../packages/server/src/gateway/tokens.js");

for (const p of pairs) {
  const eq = p.indexOf("=");
  const userId = p.slice(0, eq);
  const token = p.slice(eq + 1);
  if (!userId || !token) {
    console.error(`bad pair: ${p}`);
    process.exit(2);
  }
  const teamId = store.teamIdForUser(userId);
  await tokens.rememberConnectKey(token, { userId, teamId });
  console.log(`seeded connect key: ${userId} -> ${teamId} (machine ${tokens.machineIdFromToken(token)})`);
}

await (db.client as { close?: () => Promise<void> }).close?.();
