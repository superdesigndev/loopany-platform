# @crewlet/loopany

The **Loopany daemon** - runs on your machine, connects to a Loopany server, and
executes your scheduled agent loops locally via your own claude-code.

Loopany is **BYOA** (bring your own agent): the server schedules, stores, and
notifies, but never runs an LLM or executes your code. This daemon is the
execution half - it polls the server for due runs, spawns Claude Code in the
loop's working directory, and reports the results back.

## Requirements

- Node.js >= 22
- [Claude Code](https://claude.com/claude-code) installed (`claude` on your PATH)
- A Loopany server - its dashboard gives you the `server-url` and one-time
  `connect-key` used below

## Install

```bash
npm install -g @crewlet/loopany
# or run ad-hoc:
npx @crewlet/loopany --help
```

## Connect your machine

```bash
loopany up --server-url <url> --connect-key <dk_…>
```

`up` is idempotent: it registers this machine (first time), stores the
credentials under `~/.loopany/`, and spawns a detached daemon if none is
running. It also refreshes the user-scope loopany skill, the SessionStart hook,
and the `loopany` PATH shim. After that, `loopany up` alone reconnects.

## Commands

```
loopany                 Show the content-first HOME: this machine's live loops +
                        recent runs (the poll loop moved to `up --foreground`).

Setup
  up [--foreground]       Connect this machine / ensure its daemon is running
                          (idempotent; refreshes the loopany skill, the SessionStart
                          hook, and the `loopany` PATH shim). --foreground runs the
                          poll loop attached in this terminal instead of detached.
  new --json '<config>'   Create a loop from an inline JSON config (--json - reads
                          stdin). --dry-run validates + previews, creates nothing.
  setup hooks [--remove]  Install/refresh the SessionStart hook that lands the home
                          view as ambient context each session (--remove uninstalls).
  skill [status|install]  Manage the loopany agent skill install (user scope by
                          default; --project installs into the current directory).
  update                  Update this machine's daemon to the version you invoked
                          (run via npx @crewlet/loopany@latest update): stops the
                          running daemon, starts the new one, refreshes the
                          skill/hook/shim.

Management
  status                  Is the daemon running? Show pid + server connection.
  down                    Stop the detached daemon started with `up`.
  show [<id>]             Show a loop's full editable config + recent state (the
                          device credential inspects any loop on this machine).
  log [<loop>]            Show a loop's recent runs (status, metrics, session id).
                          --transcript/--full inlines transcripts; --json for machines.

Interactive
  loops [--fields a,b]    List your loops (default columns id/name/cron/enabled/
                          nextFire; --fields adds timezone/notify/model/goal/
                          taskFile/runs/lastOutcome; --json for machines).
  edit <id> --json '<obj>'  Edit a loop (JSON-only + --workflow-file/--ui-file/
                          --schema-file; --dry-run previews before/after).
```

Run `loopany --help` for the full usage text, or `loopany <verb> --help` for a
single verb's concise usage (prints and exits, running no side effect - safe to
inspect foot-guns like `update` or `down`).

## How it works

The daemon polls the server over HTTPS - no inbound ports, no websockets. While
idle it opts into a bounded server-held long-poll so a due run dispatches almost
instantly; with a run in flight it keeps a short poll so progress keeps flowing.
When a run is due it executes claude-code in the loop's own folder, live-syncs
that folder's files back to the server (secrets and junk like `.env*`,
`node_modules`, `.git`, `.worktrees`, and build/tool caches are never sent), and
reports the outcome. The loop folder is a synced **content home** (reports,
state, ui, small artifacts) - not a scratch workspace: heavy work products (a
repo clone, a git worktree, build output) belong outside it, and the daemon
defensively caps how much it syncs per loop (`LOOPANY_SYNC_MAX_FILES` /
`LOOPANY_SYNC_MAX_BYTES`) so a stray checkout can never flood the sync. Your code
and credentials stay on your machine.

The package also bundles the **loopany agent skill**, which teaches a coding
agent how to author and evolve loops; `loopany up` (and `loopany new`) install
it at user scope for every coding agent loopany knows about (Claude Code
`~/.claude/skills/loopany/` and Codex `~/.agents/skills/loopany/` today)
automatically, so any loop on this machine can discover it. Run `loopany skill
status` to see each agent's install location.
