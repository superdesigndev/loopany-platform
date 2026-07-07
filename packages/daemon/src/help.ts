/**
 * `loopany --help` / `-h` / `help` — the usage screen, and `loopany -v` /
 * `--version` — the bare version line. Kept in its own module so both paths load
 * nothing heavy (no daemon/network), and so the verb list has a single readable
 * source. The usage screen leads with the daemon version (a troubleshooting
 * affordance, reusing `daemonVersion()`); when the version is unreadable it
 * degrades to the plain header instead of throwing. Grouped setup-vs-management;
 * the in-run callbacks (`loopany report …`, which the agent invokes via the PATH
 * wrapper) are NOT user commands and are deliberately omitted.
 *
 * The owner loop verbs (loops/edit/log/new) and the in-run callbacks are no longer
 * two separate mechanisms: both funnel through the one shared CLI client that POSTs to
 * the unified `/api/machine/cli` dispatch (see `cli-client.ts`) — only the LOCAL verbs
 * grouped below (up/down/update/skill/status) run without touching the server.
 */
import { daemonVersion } from "./version.js";

const HELP_BODY = ` connects this machine to a Loopany
server and runs your scheduled agent loops locally with your own coding agent.

Usage: loopany [command] [options]

  loopany                 Show the content-first HOME: this machine's live loops +
                          recent runs (the poll loop moved to \`up --foreground\`).

Setup
  up [--foreground]       Connect this machine / ensure its daemon is running
                          (idempotent; refreshes the loopany skill, the SessionStart
                          hook, and the \`loopany\` PATH shim). --foreground runs the
                          poll loop attached in this terminal instead of detached.
  new --json '<config>'   Create a loop from an inline JSON config (--json - reads
    [--dry-run]           stdin). --dry-run validates + previews, creates nothing.
  setup hooks [--remove]  Install/refresh the SessionStart hook that lands the home
                          view as ambient context each session (--remove uninstalls).
  skill [status|install]  Manage the loopany agent skill install (user scope by
    [--project]           default; --project installs into the current directory).
  update                  Update this machine's daemon to the version you invoked
                          (run via npx @crewlet/loopany@latest update): stops the
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

/** `loopany <version>` for humans, or a plain fallback when it's unreadable. */
function versionLabel(version: string | undefined): string {
  return version ? `loopany v${version}` : "loopany";
}

export function printHelp(
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  out(`${versionLabel(version)} - the Loopany daemon:${HELP_BODY}`);
  return 0;
}

/** `loopany -v` / `--version`: just the version line, never starts the daemon. */
export function printVersion(
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  out(`${version ? `loopany v${version}` : "loopany (version unknown)"}\n`);
  return 0;
}
