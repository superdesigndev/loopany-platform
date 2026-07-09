/**
 * The CLI routing decision — pure over (argv, env), no imports/side-effects — so the
 * whole dispatch table (esp. the Batch-6 bare→home move + the `up --foreground` /
 * daemon-flag / run-only-forward branches) is unit-testable without launching anything.
 * `cli.ts` is the entry that maps a `Route` to the lazily-imported handler.
 */
const INTERACTIVE_VERBS = new Set(["loops", "edit"]);
const HELP_FLAGS = new Set(["--help", "-h", "help"]);
// The per-verb short-circuit only fires on the actual FLAG forms (not the bare `help`
// verb, which is a leading token, never a trailing flag on another verb).
const HELP_FLAG_ARGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);
// Leading tokens that mean "run the daemon WITH flags" (the detached spawn from
// `loopany up` re-execs us as `… --server-url <url> --api-key <token>`, and a power
// user may launch it the same way). Any OTHER leading flag is unknown. This re-exec
// path is PRESERVED unchanged by the Batch-6 bare-command move — only the truly-bare
// `loopany` (no args, no flags) changed meaning (bare → home, not daemon).
const DAEMON_FLAGS = new Set(["--server-url", "--api-key"]);
// Run-ONLY verbs typed OUTSIDE a run (F3): forward them to the server on the device
// credential so its crafted run-only 403 reaches the agent, instead of a generic
// "unknown command". A run report/finishes ITSELF; the owner edits via `edit`.
const FORWARD_VERBS = new Set(["report", "finish", "complete"]);
// Every command word the router recognizes below (the daemon-flag re-exec is a leading
// FLAG, not a verb, so it is deliberately absent). Any of these carrying `--help`/`-h`
// short-circuits to that verb's usage BEFORE its handler runs — so a foot-gun like
// `update` (immediate daemon handover) is always safe to inspect, and a NEW verb inherits
// the guarantee by being added here alongside its branch.
const COMMAND_VERBS = new Set(["up", "new", "skill", "setup", "update", "status", "down", "log", "show", ...INTERACTIVE_VERBS, ...FORWARD_VERBS]);

function hasHelpFlag(args: string[]): boolean {
  return args.some((a) => HELP_FLAG_ARGS.has(a));
}

export type Route =
  | { kind: "callback"; argv: string[] } // in-run (incl. bare → `home` on the run cred)
  | { kind: "help"; verb?: string } // `verb` set = per-verb usage (`<verb> --help`)
  | { kind: "version" }
  | { kind: "daemon" } // the poll loop: `--server-url …` re-exec OR `up --foreground`
  | { kind: "ensure"; args: string[] } // `up` (detached, idempotent)
  | { kind: "create"; args: string[] }
  | { kind: "skill"; args: string[] }
  | { kind: "setup"; args: string[] }
  | { kind: "update"; args: string[] }
  | { kind: "status"; args: string[] }
  | { kind: "down"; args: string[] }
  | { kind: "log"; args: string[] }
  | { kind: "show"; args: string[] }
  | { kind: "interactive"; argv: string[] }
  | { kind: "forward"; argv: string[] } // run-only verb out-of-run → device-cred 403
  | { kind: "home" } // bare `loopany` out-of-run → content-first home (device cred)
  | { kind: "unknown"; verb: string };

export function classify(argv: string[], env: NodeJS.ProcessEnv): Route {
  // In-run (run token present) EVERY `loopany …` is a callback — including the bare
  // `loopany` (zero args), which now posts `home` for the run's own context (fixing
  // the old `argv.length > 0` guard that let bare `loopany` fall through to the daemon
  // mid-run). The callback can't hijack an owner command: the owner runs outside a run.
  if (env.LOOPANY_RUN_TOKEN) return { kind: "callback", argv: argv.length > 0 ? argv : ["home"] };
  const verb = argv[0];
  // Help/version win over everything (never launch a daemon), loading nothing heavy.
  if (verb !== undefined && HELP_FLAGS.has(verb)) return { kind: "help" };
  if (verb !== undefined && VERSION_FLAGS.has(verb)) return { kind: "version" };
  // `<verb> --help`/`-h` prints THAT verb's usage and exits 0 BEFORE its handler runs —
  // parsed up here (ahead of the `up`→daemon branch, so `up --foreground --help` still
  // shows help instead of launching the poll loop). Structural: any recognized command
  // verb inherits the no-side-effect help guarantee.
  if (verb !== undefined && COMMAND_VERBS.has(verb) && hasHelpFlag(argv.slice(1))) return { kind: "help", verb };
  // The detached re-exec path (`loopany --server-url …`) runs the poll loop — the ONE
  // surface (besides `up --foreground`) that still launches the daemon. Checked BEFORE
  // the verb switch so a leading daemon flag never reads as an unknown verb.
  if (verb !== undefined && DAEMON_FLAGS.has(verb)) return { kind: "daemon" };
  // `up --foreground` runs the poll loop attached (the old bare behavior); plain `up`
  // ensures a detached daemon (idempotent) as before.
  if (verb === "up") return argv.includes("--foreground") ? { kind: "daemon" } : { kind: "ensure", args: argv.slice(1) };
  if (verb === "new") return { kind: "create", args: argv.slice(1) };
  if (verb === "skill") return { kind: "skill", args: argv.slice(1) };
  if (verb === "setup") return { kind: "setup", args: argv.slice(1) };
  if (verb === "update") return { kind: "update", args: argv.slice(1) };
  if (verb === "status") return { kind: "status", args: argv.slice(1) };
  if (verb === "down") return { kind: "down", args: argv.slice(1) };
  if (verb === "log") return { kind: "log", args: argv.slice(1) };
  if (verb === "show") return { kind: "show", args: argv.slice(1) };
  if (verb !== undefined && INTERACTIVE_VERBS.has(verb)) return { kind: "interactive", argv };
  // report/finish/complete OUTSIDE a run are run-only (F3): forward on the device
  // credential so the server's crafted 403 reaches the agent, not a generic unknown.
  if (verb !== undefined && FORWARD_VERBS.has(verb)) return { kind: "forward", argv };
  // Bare `loopany` (no args) → the content-first home (P8), NOT the poll loop.
  if (argv.length === 0) return { kind: "home" };
  return { kind: "unknown", verb: verb! };
}
