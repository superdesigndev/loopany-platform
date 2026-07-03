#!/usr/bin/env node
/**
 * Loopany daemon — one binary, two roles (BYOA MINIMAL_DAEMON §1):
 *
 *   loopany                    → daemon mode: poll the server, run deliveries.
 *   loopany up […]             → setup mode: ensure a daemon is running for this
 *                                machine (idempotent) — folds SKILL.md §1.
 *   loopany new --config […]   → setup mode: create a loop from a config file,
 *                                filling timezone/claim/auth — folds SKILL.md §3–4.
 *   loopany skill [status|install] → install the loopany agent skill at USER scope
 *                                via `npx skills` (best-effort; the manual escape hatch
 *                                — `loopany up`/`new` also refresh ~/.claude/skills).
 *   loopany update             → setup mode: hand the running daemon over to this
 *                                (newer) CLI — stop the old daemon, start this one,
 *                                refresh the skill (this CLI is already the new version).
 *   loopany status             → setup mode: report whether THIS machine's daemon
 *                                is running (local pid) + its connection state.
 *   loopany down               → setup mode: stop the detached daemon `up` started.
 *   loopany log [<loop>]       → read mode: print a loop's recent run history
 *                                (status + transcript) for the loop in this workdir.
 *   loopany --help | -h | help → print usage and exit (NEVER start the daemon).
 *   loopany loops|edit […]     → interactive mode: the owner edits a loop from
 *                                their own Claude Code, reusing the persisted
 *                                device token (→ /api/machine/loop).
 *   loopany <verb> [...flags]  → callback mode (when LOOPANY_RUN_TOKEN is set;
 *                                claude calls this via the PATH wrapper) →
 *                                forward argv to the server's /agent-api/loop.
 */
const argv = process.argv.slice(2);
const INTERACTIVE_VERBS = new Set(["loops", "edit"]);
const HELP_FLAGS = new Set(["--help", "-h", "help"]);
// Leading tokens that mean "run the daemon WITH flags" (the detached spawn from
// `loopany up` re-execs us as `… --server-url <url> --api-key <token>`, and a
// power user may launch it the same way). Any OTHER leading flag is unknown.
const DAEMON_FLAGS = new Set(["--server-url", "--api-key"]);

// Lazy-import per branch: claude re-execs this CLI for every `loopany report …`
// callback, so keep that path from loading the daemon/interactive modules.
async function main(): Promise<number> {
  // In-run callback (run token present) takes precedence: `loopany report` etc.
  // Everything below is an owner-OUTSIDE-a-run command and is guarded by this so
  // it can never hijack a callback the agent makes mid-run.
  if (process.env.LOOPANY_RUN_TOKEN && argv.length > 0) {
    return (await import("./callback.js")).runCallback(argv);
  }
  // Help wins over the daemon fallback: `loopany --help` must print usage, never
  // launch a backgrounded daemon. Handled before any heavy import.
  if (argv.length > 0 && HELP_FLAGS.has(argv[0]!)) {
    return (await import("./help.js")).printHelp();
  }
  // Setup verbs the owner's Claude Code calls OUTSIDE a run to stand a loop up.
  if (argv[0] === "up") {
    return (await import("./ensure.js")).runEnsure(argv.slice(1));
  }
  if (argv[0] === "new") {
    return (await import("./create.js")).runCreate(argv.slice(1));
  }
  if (argv[0] === "skill") {
    return (await import("./skill-cli.js")).runSkill(argv.slice(1));
  }
  if (argv[0] === "update") {
    return (await import("./update.js")).runUpdate(argv.slice(1));
  }
  if (argv[0] === "status") {
    return (await import("./control.js")).runStatus(argv.slice(1));
  }
  if (argv[0] === "down") {
    return (await import("./control.js")).runDown(argv.slice(1));
  }
  if (argv[0] === "log") {
    return (await import("./log.js")).runLog(argv.slice(1));
  }
  // Owner editing outside a run — no run token, an explicit interactive verb.
  if (argv.length > 0 && INTERACTIVE_VERBS.has(argv[0]!)) {
    return (await import("./interactive.js")).runInteractive(argv);
  }
  // Bare `loopany` (no args) OR `loopany --server-url …/--api-key …` (the detached
  // spawn path) → run the daemon. Anything else is an unknown verb/flag: error
  // helpfully instead of silently launching a backgrounded daemon.
  if (argv.length === 0 || DAEMON_FLAGS.has(argv[0]!)) {
    return (await import("./daemon.js")).runDaemon();
  }
  process.stderr.write(`loopany: unknown command '${argv[0]}' — try \`loopany --help\`\n`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`loopany: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
