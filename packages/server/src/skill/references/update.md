# Edit an existing task or loop

A task lives in two places, and `loopany update` changes each where it lives. Use
the same **loopany-cli** prefix as for create (default `npx @crewlet/loopany@latest`);
it reuses this machine's persisted device token, so no auth flags are needed.

- **Work-state** (`status`, `priority`, `parent`, `assignee` (a person's email;
  `owner` is a legacy alias), `refs`, `follow_up_date`, `title`) — lives in the task's **README front matter** on this
  machine; the file is the source of truth. `loopany update <id> k=v` edits it in
  place (and records a dated `## Timeline` line); it syncs automatically.
- **Execution envelope** (`cron`, `timezone`, `notify`, `model`, `goal`, `enabled`,
  `name`, `runAt`, `allowControl`) — the server owns it. The same `update` command
  routes these keys to the server (one validator path; a typo'd key fails loudly
  listing both vocabularies). The existing `loopany edit <id> --json '<patch>'` still
  works too — it writes the same envelope keys JSON-only, if you prefer one object
  over `key=value` pairs.
- **What the loop does** (its instructions, context, log) — the README's `## Spec`
  / `## Current understanding` / `## Timeline`. Edit the file directly, keeping
  that structure. (How a run maintains it: `evolve.md`.)
- **Dashboard / metric schema / workflow** — the loop normally shapes these itself
  during its **evolution pass** (see `evolve.md`); leave them to it unless the user
  explicitly asks. Then push them with the content-file flags (below); the server
  validates with the same rules as the run-time `set-*` verbs (schema stays
  additive — never drop a key still bound by the UI or reported by recent runs).

First find the task (slug or loop id both work everywhere):

```bash
<loopany-cli> list                    # the tree
<loopany-cli> list --recurring        # just the scheduled ones
<loopany-cli> search <keywords>       # full-text
```

`loopany list` renders the tree (filter with `--status`/`--priority`/`--assignee`,
or drop to a flat view with `--flat`); `--json` emits the full records as a raw JSON
array when you need to parse rather than read. Reads are **team-wide**: rows that
live on another of the user's devices carry an `@machine` marker; `--here` narrows
to this machine, `--team <id>` to one team. A slug that exists on two machines is
ambiguous — the error lists candidates; qualify as `<machine>/<slug>`. For a
columnar view of just the scheduled loops, `loopany loops` prints
`id`/`name`/`cron`/`enabled`/`nextFire` by default and adds more columns with
`--fields` (comma-separated, from `timezone`,`notify`,`model`,`goal`,`taskFile`,
`runs`,`lastOutcome`,`machine`; an unknown field fails loud), plus its own `--json`.

Before reshaping a loop, see how its recent runs actually went with
`<loopany-cli> get <id> --runs` (`--limit N`, `--transcript` for full text,
`--json`) — a concise survey of status, metrics, and session ids, plus a `config:`
line with the loop's full settings (notify/agent/model + workflow/ui presence; the
old `show` verb is now an alias of `get`). Read it first so an edit is grounded in
what the runs really did, not a guess.

## One command, key=value pairs

```bash
<loopany-cli> update <id> status=in-progress priority=P1        # work-state → the README
<loopany-cli> update <id> status=follow-up follow_up_date=2026-07-17   # follow-up REQUIRES the date
<loopany-cli> update <id> status=done                           # done/archived also pauses a schedule
<loopany-cli> update <id> cron="0 9 * * *" notify=always        # envelope → the server
<loopany-cli> update <id> cron=null                             # stop recurring (task stays)
<loopany-cli> update <id> goal="ship v1.0"                      # make it closed (or change the finish line)
<loopany-cli> update <id> goal=null                             # back to an open monitor (clears goal AND completion)
<loopany-cli> update <id> enabled=false                         # pause (true = resume / reopen a completed loop)
<loopany-cli> update <id> --note "readout: checkout 29%→41%"    # append a dated Timeline line (with or without k=v)
```

Hard rules the CLI enforces (errors, not conventions):
- `status=follow-up` without a `follow_up_date` (in the patch or already in the file)
  is refused — a shipped-but-unproven task must carry its check-back date.
- `status=done|archived` on a recurring task also sets `enabled=false` — the node
  is the source of truth; the schedule follows it.
- There is no `delete` — `status=archived` is the terminal state.
- `order` is never hand-set (a rarely-needed `mv` verb exists for manual
  reordering; run `loopany mv --help` if a user asks).

The envelope keys `update` forwards to the server:

| key            | value                          | effect |
|----------------|--------------------------------|--------|
| `name`         | string                         | rename (display name; the slug never changes) |
| `cron`         | 5-field cron, or `null`        | (re)schedule / stop recurring (owner path has no cadence floor) |
| `timezone`/`tz`| IANA name                      | change the zone |
| `notify`       | `always` \| `auto` \| `never`  | delivery policy |
| `model`        | model id                       | coding-agent model |
| `agent`        | `claude-code` \| `codex` \| `grok` | which coding agent executes this loop on the bound machine |
| `allowControl` | boolean                        | `false` = **pin** the schedule (runs can't self-adjust) |
| `enabled`      | boolean                        | `false` pauses; `true` resumes — or **reopens** a completed loop (clears its completion stamps; goal survives) |
| `runAt`        | `2h` / ISO                     | one extra run soon, then resume cadence |
| `goal`         | string, or `null`              | set/change the finish line, or clear it (clearing also drops completion) |

Preview any change with `--dry-run` — file edits are described, envelope keys show
the server's before→after, and nothing is persisted:

```bash
<loopany-cli> update <id> goal=null cron="0 9 * * *" --dry-run
```

## Assign a task

```bash
<loopany-cli> update <id> assignee=sam@example.com      # a PERSON — worklist metadata (front matter)
<loopany-cli> update <id> assignee=studio/claude-code   # an EXECUTOR — <machine>/<agent>, re-binds the task
```

The executor form works on the user's **own devices only** and only on tasks
without a cron (a loop's executor is fixed — its Spec references machine-local
paths, so moving it is a migration, not a field write). When the task sits at
`status: todo`, assignment **auto-dispatches one run** on the target device; a run
that ends without finishing does not silently re-fire — re-assign or `loopany run`
to try again. The response says whether it dispatched and why not (paused, a run
already open, or the device's queue is full).

## Run a task now

```bash
<loopany-cli> run <id> [--wait]
```

Dispatches an agent at the task immediately (works on any task, cron or not);
`--wait` blocks until the run reports and prints the outcome.

## Content fields — reshape without a run

These read a file's raw content into the update (schema parsed as JSON), mirroring
the run-time `set-*` verbs — because multi-line JS/HTML/JSON is awkward inline:

```bash
<loopany-cli> update <id> --workflow-file wf.js      # replace the deterministic pre-stage JS
<loopany-cli> update <id> --ui-file dash.html        # replace the dashboard HTML
<loopany-cli> update <id> --schema-file schema.json  # replace the metric schema (JSON array)
```

Content-file paths must live **inside the current working directory** — a shared
path like `/tmp` can carry a stale file from a different run, which would silently
become this loop's workflow/dashboard. Write the file next to where you run the
command (e.g. `./wf.js`); `--allow-external-file` overrides deliberately.

A `--workflow-file` body must obey the workflow syntax contract — a plain statement
sequence run inside an async function, **not an ES module and not the Claude Code
`Workflow` tool** (no top-level `export`/`import`, never `export const meta = {…}`;
see `create.md` §4). The server parse-checks it and rejects a bad body (surfaced by
`--dry-run`).

Scope: reads and **config** keys (cron/notify/name/goal/enabled/runAt/timezone)
work team-wide — pausing or rescheduling a loop on the user's other laptop from
here is fine. **Content** (workflow/ui/schema) and work-state file edits apply
only from the machine that holds the task's folder; cross-machine attempts fail
with a clear error rather than doing something surprising.

> Pausing, reopening, or running a loop now are also one-click in the Loopany web
> dashboard — point the user there for those rather than the CLI if they prefer.
> The Tasks page renders the whole tree.

## Assigning to an agent

`loopany team` lists who can work here: teammates (humans — set with
`assignee: <email>` in the work-state) and registered AGENTS (machine × runtime
executors with presence). Hand a task to an agent by slug:

    loopany update <id> assignee=<agent-slug>     # e.g. claude-studio

Resolution is registry-first (slug, display name, or id); an ambiguous ref
returns candidates instead of guessing; `<machine>/<runtime>` is accepted as an
alias. Assignment auto-dispatches once when the task sits at `status: todo`.
`loopany team rename <agent> "<name>"` relabels an agent (its slug — the
address — stays stable).
