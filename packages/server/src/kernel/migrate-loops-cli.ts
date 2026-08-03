/**
 * CLI wrapper for the production-loop migration (`loopMigration.ts`).
 *
 *   pnpm --filter @loopany/server kernel:migrate-loops -- --dry-run
 *   pnpm --filter @loopany/server kernel:migrate-loops
 *   pnpm --filter @loopany/server kernel:migrate-loops -- --team team-abc
 *
 * DEFAULTS TO A DRY RUN'S POSTURE in one respect only: it prints the full plan
 * either way, so a real run is auditable after the fact. It exits non-zero when
 * any loop was refused, so an operator cannot mistake a partial migration for a
 * clean one.
 *
 * Zero exec, zero LLM: this reads `loops` and writes `objects`/`events`, nothing
 * else. It never touches the `loops` table.
 */
import { migrateLoopsToObjects } from "./loopMigration.js";

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function value(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (flag(argv, "help") || flag(argv, "h")) {
    process.stdout.write(
      "usage: kernel:migrate-loops [--dry-run] [--team <teamId>]\n\n" +
        "  copies every loops row into one objects row (kind=loop).\n" +
        "  idempotent, insert-only, never destructive — the loops table is untouched.\n",
    );
    return 0;
  }

  const dryRun = flag(argv, "dry-run");
  const teamId = value(argv, "team");

  const { runMigrations } = await import("../db/index.js");
  await runMigrations();

  const report = await migrateLoopsToObjects({ dryRun, teamId });

  const lines: string[] = [];
  lines.push(`${dryRun ? "DRY RUN — nothing written" : "migrating"}${teamId ? ` (team ${teamId})` : ""}`);
  for (const p of report.planned) {
    lines.push(
      `  ${p.id}  ${p.status.padEnd(7)} ${p.cron ?? "-"}  body=${p.bodyBytes}B  payload=[${p.payloadKeys.join(",")}]`,
    );
  }
  lines.push(
    `scanned=${report.scanned} created=${report.created} existing=${report.existing} refused=${report.refused.length}`,
  );
  for (const r of report.refused) lines.push(`  REFUSED ${r.loopId}: ${r.code} — ${r.message}`);
  process.stdout.write(lines.join("\n") + "\n");

  return report.refused.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`migration failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
