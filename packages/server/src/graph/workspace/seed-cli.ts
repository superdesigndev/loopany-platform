/**
 * `pnpm graph:seed` - seed the Graph Engineering v1 workspace demo.
 *
 * DEFAULT dataset is the REAL production snapshot (`pnpm graph:pull` writes it;
 * this replays it through `applyTransition`). `--synthetic` seeds the hand-built
 * fleet instead - that one is self-contained, needs no snapshot, and is what the
 * test suite uses.
 *
 * Runs in its OWN process and exits before the dev server starts, because the
 * embedded pglite tier is single-writer: two processes holding the same
 * `<LOOPANY_DATA_DIR>/pgdata` is the one way to wedge a local demo. `pnpm
 * graph:demo` chains the two for exactly that reason.
 *
 * Applies migrations first (idempotent), so a fresh data dir works with no extra
 * step.
 */
import fs from "node:fs";

import { runMigrations } from "../../db/index.js";
import { snapshotPath } from "./pull-prod.js";
import type { SeedResult } from "./seed.js";
import { seedGraphDemo } from "./seed.js";
import { seedFromProdSnapshot, type RealSeedResult } from "./seed-real.js";

const isReal = (r: SeedResult | RealSeedResult): r is RealSeedResult => "snapshot" in r;

async function main(): Promise<void> {
  await runMigrations();
  const synthetic = process.argv.includes("--synthetic");

  if (!synthetic && !fs.existsSync(snapshotPath())) {
    process.stderr.write(
      [
        `no production snapshot at ${snapshotPath()}`,
        "",
        "  pnpm graph:pull        take a read-only snapshot of the real fleet",
        "  pnpm graph:seed -- --synthetic   seed the hand-built demo fleet instead",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const result: SeedResult | RealSeedResult = synthetic ? await seedGraphDemo() : await seedFromProdSnapshot();

  const lines = [
    synthetic
      ? `graph demo seeded (SYNTHETIC fleet) into team ${result.teamId}`
      : `graph demo seeded (REAL production snapshot) into team ${result.teamId}`,
  ];
  if (isReal(result)) {
    lines.push(
      `  source             ${result.snapshot.team}`,
      `  pulled             ${result.snapshot.pulledAt} (${result.snapshot.window.days}d window)`,
    );
  }
  lines.push(
    `  objects            ${result.objects}`,
    `  edges              ${result.edges}`,
    `  events             ${result.events}`,
    `  open obligations   ${result.openObligations}`,
    `  pending actions    ${result.pendingActions}`,
    "",
  );
  process.stdout.write(lines.join("\n"));

  // What this deploy agreed to RUN. Loud, because arming is the act that makes a
  // workspace dispatch real work on a clock with nobody watching.
  if (isReal(result)) {
    for (const a of result.armed) {
      process.stdout.write(`  ARMED    ${a.loop} - ${a.cadence}, first fire ${a.nextFire} (${a.transition})\n`);
    }
  }

  // What the replay chose not to carry, and why. Never silent.
  if (isReal(result)) {
    for (const d of result.dropped) process.stdout.write(`  dropped  ${d.count} ${d.what} — ${d.why}\n`);
  }

  // A refused transition means the source data and the type specs disagree.
  // Report loudly; a handful on real data is information, not a crash.
  if (result.refusals.length) {
    process.stderr.write(`\n${result.refusals.length} transition(s) REFUSED:\n`);
    for (const r of result.refusals.slice(0, 20)) process.stderr.write(`  - ${r}\n`);
    if (result.refusals.length > 20) process.stderr.write(`  … and ${result.refusals.length - 20} more\n`);
    // The synthetic fleet is authored against the specs, so ANY refusal there is
    // a bug. Real data legitimately contains shapes the specs do not model.
    if (synthetic) process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`graph demo seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
