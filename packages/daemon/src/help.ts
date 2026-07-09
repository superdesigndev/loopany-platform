/**
 * `adscaile --help` / `-h` / `help` — the usage screen, and `adscaile -v` /
 * `--version` — the bare version line. Kept in its own module so both paths load
 * nothing heavy (no daemon/network), and so the verb list has a single readable
 * source. The usage screen leads with the daemon version (a troubleshooting
 * affordance, reusing `daemonVersion()`); when the version is unreadable it
 * degrades to the plain header instead of throwing. Grouped setup-vs-management;
 * the in-run callbacks (`adscaile report …`, which the agent invokes via the PATH
 * wrapper) are NOT user commands and are deliberately omitted.
 *
 * The owner loop verbs (loops/edit/log/new) and the in-run callbacks are no longer
 * two separate mechanisms: both funnel through the one shared CLI client that POSTs to
 * the unified `/api/machine/cli` dispatch (see `cli-client.ts`) — only the LOCAL verbs
 * grouped below (up/down/update/skill/status) run without touching the server.
 */
import { daemonVersion } from "./version.js";

const HELP_BODY = ` connects this machine to a adScaile
server and runs your scheduled agent loops locally with your own coding agent.

Usage: adscaile [command] [options]

  adscaile                 Show the content-first HOME: this machine's live loops +
                          recent runs (the poll loop moved to \`up --foreground\`).

Setup
  up [--foreground]       Connect this machine / ensure its daemon is running
                          (idempotent; refreshes the adscaile skill, the SessionStart
                          hook, and the \`adscaile\` PATH shim). --foreground runs the
                          poll loop attached in this terminal instead of detached.
  new --json '<config>'   Create a loop from an inline JSON config (--json - reads
    [--dry-run]           stdin). --dry-run validates + previews, creates nothing.
  setup hooks [--remove]  Install/refresh the SessionStart hook that lands the home
                          view as ambient context each session (--remove uninstalls).
  skill [status|install]  Manage the adscaile agent skill install (user scope by
    [--project]           default; --project installs into the current directory).
  update                  Update this machine's daemon to the version you invoked
                          (run via npx @crewlet/adscaile@latest update): stops the
                          running daemon, starts the new one, refreshes the skill/hook/shim.

Management
  status                  Is this machine's daemon running? Show pid + connection.
  down                    Stop the detached daemon this machine started with up.
  show [<id>]             Show a loop's full editable config + recent state (the
                          device credential inspects any loop on this machine).
  log [<loop>]            Show a loop's recent runs (concise: status + metrics +
    [--transcript]        session id; --transcript/--full adds the transcript).
                          Defaults to the loop for the current directory (--json,
                          --limit N).

Interactive (edit loops from your own agent session, using the stored device token)
  loops [--fields a,b]    List your loops (--json emits the raw JSON array).
    [--json]              Default columns are id/name/cron/enabled/nextFire;
                          --fields adds any of timezone,notify,model,goal,
                          taskFile,runs,lastOutcome.
  edit <id> --json '<obj>'  Edit a loop (JSON-only + --workflow-file/--ui-file/
    [--dry-run]           --schema-file; --dry-run previews before/after).

  -h, --help              Show this help.
  -v, --version           Print the daemon version and exit.
`;

/**
 * Concise per-verb usage, printed by `adscaile <verb> --help` / `-h`. Kept terse on
 * purpose (the full screen above is one `--help` away): the load-bearing property is that
 * `<verb> --help` short-circuits to THIS text with NO side effect — critical for the
 * foot-gun verbs (`update` hands the daemon over immediately, `down` stops it). Every
 * command verb the router knows (`route.ts` COMMAND_VERBS) has an entry; a missing entry
 * degrades to the full usage screen rather than throwing.
 */
const VERB_USAGE: Record<string, string> = {
  up: "adscaile up [--foreground]\n  Connect this machine / ensure its daemon is running (idempotent; refreshes the\n  adscaile skill, the SessionStart hook, and the PATH shim). --foreground runs the\n  poll loop attached in this terminal instead of detached.",
  new: "adscaile new --json '<config>' [--dry-run]\n  Create a loop from an inline JSON config (--json - reads stdin). --dry-run\n  validates + previews, creating nothing.",
  skill: "adscaile skill [status|install] [--project]\n  Manage the adscaile agent skill install (user scope by default; --project installs\n  into the current directory).",
  setup: "adscaile setup hooks [--remove]\n  Install/refresh (or --remove) the SessionStart hook that lands the home view as\n  ambient context each session.",
  update: "adscaile update\n  Hand this machine's daemon over to the (newer) CLI you invoked: stop the running\n  daemon, start the new one, refresh the skill/hook/shim.",
  status: "adscaile status\n  Report whether this machine's daemon is running (local pid) + its connection state.",
  down: "adscaile down\n  Stop the detached daemon this machine started with `up`.",
  log: "adscaile log [<loop>] [--transcript|--full] [--json] [--limit N]\n  Show a loop's recent runs (concise: status + metrics + session id). Defaults to the\n  loop for the current directory.",
  show: "adscaile show [<id>] [--full] [--json]\n  Show a loop's full editable config + recent state (the device credential inspects\n  any loop on this machine).",
  loops: "adscaile loops [--fields a,b] [--json]\n  List your loops (--json emits the raw JSON array). Default columns are\n  id/name/cron/enabled/nextFire.",
  edit: "adscaile edit <id> --json '<obj>' [--dry-run] [--workflow-file|--ui-file|--schema-file <path>]\n  Edit a loop (JSON-only + content-file trio). --dry-run previews before/after.",
  report: "adscaile report ...\n  In-run only: the running agent reports progress/results. Outside a run this is rejected.",
  finish: "adscaile finish ...\n  In-run only: the running agent marks a closed loop's goal met. Outside a run this is rejected.",
  complete: "adscaile complete ...\n  In-run only alias of `finish`. Outside a run this is rejected.",
};

/** `adscaile <version>` for humans, or a plain fallback when it's unreadable. */
function versionLabel(version: string | undefined): string {
  return version ? `adscaile v${version}` : "adscaile";
}

/**
 * `adscaile <verb> --help` / `-h`: print that verb's concise usage and exit 0, running NO
 * handler side effect. Unknown verbs fall back to the full usage screen.
 */
export function printVerbHelp(
  verb: string,
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  const usage = VERB_USAGE[verb];
  if (!usage) return printHelp(out, version);
  out(`${versionLabel(version)}\n\n${usage}\n\nRun \`adscaile --help\` for all commands.\n`);
  return 0;
}

export function printHelp(
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  out(`${versionLabel(version)} - the adScaile daemon:${HELP_BODY}`);
  return 0;
}

/** `adscaile -v` / `--version`: just the version line, never starts the daemon. */
export function printVersion(
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  out(`${version ? `adscaile v${version}` : "adscaile (version unknown)"}\n`);
  return 0;
}
