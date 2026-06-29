#!/usr/bin/env node
/**
 * LoopAny daemon — one binary, two roles (BYOA MINIMAL_DAEMON §1):
 *
 *   loopany                    → daemon mode: poll the server, run deliveries.
 *   loopany up […]             → setup mode: ensure a daemon is running for this
 *                                machine (idempotent) — folds SKILL.md §1.
 *   loopany new --config […]   → setup mode: create a loop from a config file,
 *                                filling timezone/claim/auth — folds SKILL.md §3–4.
 *   loopany loops|edit […]     → interactive mode: the owner edits a loop from
 *                                their own Claude Code, reusing the persisted
 *                                device token (→ /api/machine/loop).
 *   loopany <verb> [...flags]  → callback mode (when LOOPANY_RUN_TOKEN is set;
 *                                claude calls this via the PATH wrapper) →
 *                                forward argv to the server's /agent-api/loop.
 */
const argv = process.argv.slice(2);
const INTERACTIVE_VERBS = new Set(["loops", "edit"]);

// Lazy-import per branch: claude re-execs this CLI for every `loopany report …`
// callback, so keep that path from loading the daemon/interactive modules.
async function main(): Promise<number> {
  // In-run callback (run token present) takes precedence: `loopany report` etc.
  if (process.env.LOOPANY_RUN_TOKEN && argv.length > 0) {
    return (await import("./callback.js")).runCallback(argv);
  }
  // Setup verbs the owner's Claude Code calls OUTSIDE a run to stand a loop up.
  if (argv[0] === "up") {
    return (await import("./ensure.js")).runEnsure(argv.slice(1));
  }
  if (argv[0] === "new") {
    return (await import("./create.js")).runCreate(argv.slice(1));
  }
  // Owner editing outside a run — no run token, an explicit interactive verb.
  if (argv.length > 0 && INTERACTIVE_VERBS.has(argv[0]!)) {
    return (await import("./interactive.js")).runInteractive(argv);
  }
  return (await import("./daemon.js")).runDaemon();
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`loopany: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
