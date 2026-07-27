/**
 * `loopany daemon <up|down|status|update>` — the namespaced machinery group.
 * Pure dispatch onto the existing modules (zero logic here, so the deprecated
 * bare aliases in cli.ts and this canonical spelling cannot drift).
 */
export async function runDaemonGroup(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "up":
      return (await import("./ensure.js")).runEnsure(rest);
    case "down":
      return (await import("./control.js")).runDown(rest);
    case "status":
      return (await import("./control.js")).runStatus(rest);
    case "update":
      return (await import("./update.js")).runUpdate(rest);
    default:
      process.stderr.write(`loopany: daemon needs one of: up, down, status, update${sub ? ` (got: '${sub}')` : ""}\n`);
      return 2;
  }
}
