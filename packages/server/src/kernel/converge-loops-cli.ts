/** Operator wrapper for convergence S3.
 *
 *   pnpm --filter @loopany/server kernel:converge-loops -- --dry-run
 *   pnpm --filter @loopany/server kernel:converge-loops
 *
 * Run only against an isolated/local stack whose server is stopped. Pglite is
 * single-writer and the migration materializes files in the kernel workdirs.
 */
import { convergeKernelLoops } from "./convergeLoops.js";

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function value(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at !== -1 && argv[at + 1] && !argv[at + 1]!.startsWith("--")) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (has(argv, "help") || has(argv, "h")) {
    process.stdout.write(
      "usage: kernel:converge-loops [--dry-run] [--team <teamId>]\n\n" +
        "  creates production loop twins from kernel loop objects, keeping ids verbatim.\n" +
        "  materializes <workdir>/loopany-task.md without overwriting existing bytes.\n" +
        "  requires exactly one machine in the isolated stack.\n",
    );
    return 0;
  }

  const { runMigrations } = await import("../db/index.js");
  await runMigrations();
  const report = await convergeKernelLoops({ dryRun: has(argv, "dry-run"), teamId: value(argv, "team") });
  const lines = [
    `${report.dryRun ? "DRY RUN — nothing written" : "converging"} machine=${report.machineId ?? "none"}`,
    ...report.planned.map(
      (row) =>
        `  ${row.id}  ${row.enabled ? "active" : "paused"}  ${row.cron || "(on demand)"}  task=${row.taskFile} (${row.taskFileBytes}B)`,
    ),
    `scanned=${report.scanned} created=${report.created} existing=${report.existing} files-created=${report.filesCreated} files-reused=${report.filesReused} refused=${report.refused.length}`,
    ...report.refused.map((item) => `  REFUSED ${item.loopId}: ${item.message}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return report.refused.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`convergence failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
