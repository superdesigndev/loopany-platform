/**
 * `loopany --help` / `-h` / `help` — the usage screen. Kept in its own module so
 * the help path loads nothing heavy (no daemon/network), and so the verb list has
 * a single readable source. Grouped setup-vs-management; the in-run callbacks
 * (`loopany report …`, which the agent invokes via the PATH wrapper) are NOT user
 * commands and are deliberately omitted.
 */
const HELP = `loopany - the Loopany daemon: connects this machine to a Loopany
server and runs your scheduled agent loops locally with your own coding agent.

Usage: loopany [command] [options]

  loopany                 Run the daemon in the foreground (poll this machine's
                          server for loops and execute them). Ctrl-C to stop.

Setup
  up                      Connect this machine / ensure its daemon is running
                          (idempotent; spawns a detached daemon if none is live;
                          refreshes the user-scope loopany skill).
  new --json '<config>'   Create a loop from an inline JSON config (--json - reads
    [--dry-run]           stdin). --dry-run validates + previews, creates nothing.
  skill [status|install]  Manage the loopany agent skill install (user scope by
    [--project]           default; --project installs into the current directory).
  update                  Update this machine's daemon to the version you invoked
                          (run via npx @crewlet/loopany@latest update): stops the
                          running daemon, starts the new one, refreshes the skill.

Management
  status                  Is this machine's daemon running? Show pid + connection.
  down                    Stop the detached daemon this machine started with up.
  log [<loop>]            Show a loop's recent runs (concise: status + metrics +
    [--transcript]        session id; --transcript/--full adds the transcript).
                          Defaults to the loop for the current directory (--json,
                          --limit N).

Interactive (edit loops from your own agent session, using the stored device token)
  loops                   List your loops.
  edit <id> --json '<obj>'  Edit a loop (JSON-only + --workflow-file/--ui-file/
    [--dry-run]           --schema-file; --dry-run previews before/after).

  -h, --help              Show this help.
`;

export function printHelp(out: (s: string) => void = (s) => process.stdout.write(s)): number {
  out(HELP);
  return 0;
}
