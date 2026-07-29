/**
 * `pnpm graph:seed` - seed the Graph Engineering v1 workspace demo.
 *
 * Runs in its OWN process and exits before the dev server starts, because the
 * embedded pglite tier is single-writer: two processes holding the same
 * `<LOOPANY_DATA_DIR>/pgdata` is the one way to wedge a local demo. `pnpm
 * graph:demo` chains the two for exactly that reason.
 *
 * Applies migrations first (idempotent), so a completely fresh data dir works
 * with no extra step.
 */
import { runMigrations } from "../../db/index.js";
import { seedGraphDemo } from "./seed.js";

async function main(): Promise<void> {
  await runMigrations();
  const result = await seedGraphDemo();

  process.stdout.write(
    [
      `graph demo seeded into team ${result.teamId}`,
      `  objects            ${result.objects}`,
      `  edges              ${result.edges}`,
      `  events             ${result.events}`,
      `  open obligations   ${result.openObligations}`,
      `  pending actions    ${result.pendingActions}`,
      "",
    ].join("\n"),
  );

  // A refused transition means the history script and the type specs disagree.
  // Fail loudly - a demo that silently seeds a wrong state is worse than none.
  if (result.refusals.length) {
    process.stderr.write(`\n${result.refusals.length} transition(s) REFUSED:\n`);
    for (const r of result.refusals) process.stderr.write(`  - ${r}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`graph demo seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
