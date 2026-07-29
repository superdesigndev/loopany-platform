/**
 * `pnpm graph:pull` - take a READ-ONLY snapshot of one production team.
 *
 * Writes `<LOOPANY_DATA_DIR>/prod-snapshot.json` and prints a summary, including
 * everything the pull deliberately dropped. It never writes to production (see
 * `pull-prod.ts` for the three layers that guarantee it) and never prints the
 * connection string.
 */
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_DAYS, DEFAULT_MAX_FILES_PER_LOOP, DEFAULT_MAX_RUNS, DEFAULT_TEAM, pullProdSnapshot, snapshotPath } from "./pull-prod.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const team = flag("team") ?? DEFAULT_TEAM;
  const days = Number(flag("days") ?? DEFAULT_DAYS);
  const maxRuns = Number(flag("max-runs") ?? DEFAULT_MAX_RUNS);
  const maxFilesPerLoop = Number(flag("max-files") ?? DEFAULT_MAX_FILES_PER_LOOP);

  process.stdout.write(`pulling ${team} (read-only, ${days}d window)…\n`);
  const snapshot = await pullProdSnapshot({ team, days, maxRuns, maxFilesPerLoop, now: new Date().toISOString() });

  const out = snapshotPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);

  process.stdout.write(
    [
      `snapshot → ${out}`,
      `  team      ${snapshot.team.name} (${snapshot.team.id})`,
      `  loops     ${snapshot.loops.length}`,
      `  runs      ${snapshot.runs.length}`,
      `  files     ${snapshot.files.length}`,
      `  machines  ${snapshot.machines}`,
      "",
    ].join("\n"),
  );
  for (const d of snapshot.dropped) process.stdout.write(`  dropped   ${d.count} ${d.what} — ${d.why}\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  // Never echo the error verbatim if it might carry the URL: postgres-js puts the
  // host in `err.message` but not the password. Still, keep it to the message.
  process.stderr.write(`graph pull failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
