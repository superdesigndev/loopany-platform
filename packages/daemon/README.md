# @crewlet/loopany

The **LoopAny daemon** - runs on your machine, connects to a LoopAny server, and
executes your scheduled agent loops locally via your own claude-code.

LoopAny is **BYOA** (bring your own agent): the server schedules, stores, and
notifies, but never runs an LLM or executes your code. This daemon is the
execution half - it polls the server for due runs, spawns Claude Code in the
loop's working directory, and reports the results back.

## Requirements

- Node.js >= 22
- [Claude Code](https://claude.com/claude-code) installed (`claude` on your PATH)
- A LoopAny server - its dashboard gives you the `server-url` and one-time
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
running. After that, `loopany up` alone reconnects.

## Commands

```
loopany                 Run the daemon in the foreground. Ctrl-C to stop.

Setup
  up                      Connect this machine / ensure its daemon is running;
                          refreshes the user-scope loopany skill.
  new --json '<config>'   Create a loop from an inline JSON config (--json - reads
                          stdin). --dry-run validates + previews, creates nothing.
  skill [status|install]  Manage the loopany agent skill install (user scope by
                          default; --project installs into the current directory).

Management
  status                  Is the daemon running? Show pid + server connection.
  down                    Stop the detached daemon started with `up`.
  log [<loop>]            Show a loop's recent runs (status, metrics, session id).
                          --transcript inlines transcripts; --json for machines.

Interactive
  loops                   List your loops.
  edit <id> --json '<obj>'  Edit a loop (JSON-only + --workflow-file/--ui-file/
                          --schema-file; --dry-run previews before/after).
```

Run `loopany --help` for the full usage text.

## How it works

The daemon short-polls the server over HTTPS - no inbound ports, no websockets.
When a run is due it executes claude-code in the loop's own folder, live-syncs
that folder's files back to the server (secrets and junk like `.env*`,
`node_modules`, `.git` are never sent), and reports the outcome. Your code and
credentials stay on your machine.

The package also bundles the **loopany agent skill**, which teaches a coding
agent how to author and evolve loops; `loopany up` (and `loopany new`) install
it at user scope (`~/.claude/skills/loopany/`) automatically, so any loop on this
machine can discover it.
