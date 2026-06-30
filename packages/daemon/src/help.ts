/**
 * `loopany --help` / `-h` / `help` — the usage screen. Kept in its own module so
 * the help path loads nothing heavy (no daemon/network), and so the verb list has
 * a single readable source. Grouped setup-vs-management; the in-run callbacks
 * (`loopany report …`, which the agent invokes via the PATH wrapper) are NOT user
 * commands and are deliberately omitted.
 */
const HELP = `loopany — the LoopAny daemon: runs on your machine and executes your
scheduled agent loops locally via claude-code (BYOA — bring your own agent).

Usage: loopany [command] [options]

  loopany                 Run the daemon in the foreground (poll this machine's
                          server for loops and execute them). Ctrl-C to stop.

Setup
  up                      Connect this machine / ensure its daemon is running
                          (idempotent; spawns a detached daemon if none is live).
  new --config <file>     Create a loop from a config file.
  skill [status|install]  Manage the loopany agent skill install (-g for global).

Management
  status                  Is this machine's daemon running? Show pid + connection.
  down                    Stop the detached daemon this machine started with up.
  log [<loop>]            Show a loop's recent run history (status + transcript).
                          Defaults to the loop for the current directory (--json,
                          --limit N).

Interactive (edit loops from your own Claude Code, using the stored device token)
  loops                   List your loops.
  edit                    Edit a loop.

  -h, --help              Show this help.
`;

export function printHelp(out: (s: string) => void = (s) => process.stdout.write(s)): number {
  out(HELP);
  return 0;
}
