# Edit an existing loop

A loop lives in two places, and you change each where it lives. Use the same
**loopany-cli** prefix as for create (default `npx @crewlet/loopany@latest`); it
reuses this machine's persisted device token, so no `--server-url`/`--connect-key`
or other auth is needed.

- **Schedule / delivery envelope + goal** (cadence, name, timezone, notify, model,
  pause, goal, …) — the server owns it. Change it with `loopany edit` (below), which
  is **JSON-only**: one `--json '<patch>'` of just the fields that change.
- **What the loop does** (its instructions, context, log) — the loop's **task file
  (`loopany/<slug>/README.md`) on this machine**. Edit it directly in the repo,
  keeping its `## Spec` / `## Current understanding` / `## Timeline` structure; it
  syncs back to the server on the loop's next run. (How a run maintains it:
  `evolve.md`.) To point the loop at a *different* task file, patch the path:
  `--json '{"taskFile":"…"}'` (the server records the path only; move/create the
  file yourself).
- **Dashboard / metric schema / workflow** — the loop normally shapes these itself
  during its **evolution pass** (see `evolve.md`); leave them to it unless the user
  explicitly asks. Then push them with the content-file flags (below); the server
  validates with the same rules as the run-time `set-*` verbs (schema stays
  additive — never drop a key still bound by the UI or reported by recent runs).

First find the loop id (only loops bound to THIS machine are listed):

```bash
<loopany-cli> loops
# -> loop-xxxx  on      0 8 * * *  Asia/Shanghai  Cookie Daily Breakfast Report
#    loop-yyyy  paused  0 * * * *                 Hourly metrics
```

The default columns are `id`/`name`/`cron`/`enabled`/`nextFire`; add more with
`--fields` (comma-separated, from `timezone`,`notify`,`model`,`goal`,`taskFile`,
`runs`,`lastOutcome`) — an unknown field fails loud. `--json` emits the full records
as a raw JSON array (every field, `runs`/`lastOutcome` always computed) when you need
to parse the list instead of read it.

Before reshaping a loop, see how its recent runs actually went with
`<loopany-cli> log` (the loop for the current directory) or
`<loopany-cli> log <loop-id>` (`--limit N`, `--json`; `--transcript` for the full
transcript) — a concise survey of status, metrics, and session ids. Read it first so
an edit is grounded in what the runs really did, not a guess.

## Edit the envelope — one JSON patch

Pass only the fields that change. The server validates the patch and rejects unknown
keys, so a typo fails loudly instead of a silent no-op:

```bash
<loopany-cli> edit <loop-id> --json '{"cron":"0 9 * * *","notify":"always"}'   # reschedule + notify policy
<loopany-cli> edit <loop-id> --json '{"enabled":false}'                         # pause (true = resume / reopen)
<loopany-cli> edit <loop-id> --json '{"allowControl":false}'                    # pin the schedule — runs stop self-scheduling
<loopany-cli> edit <loop-id> --json '{"goal":"ship v1.0"}'                      # make it closed (or change the finish line)
<loopany-cli> edit <loop-id> --json '{"goal":null}'                             # back to an open monitor (clears goal AND completion)
```

The whitelist — every key `--json` accepts:

| key            | value                          | effect |
|----------------|--------------------------------|--------|
| `name`         | string                         | rename |
| `cron`         | 5-field cron string            | reschedule (owner path has no cadence floor) |
| `timezone`     | IANA name                      | change the zone |
| `notify`       | `always` \| `auto` \| `never`  | delivery policy |
| `model`        | model id                       | coding-agent model |
| `allowControl` | boolean                        | `false` = **pin** the schedule (runs can't self-adjust) |
| `enabled`      | boolean                        | `false` pauses; `true` resumes — or **reopens** a completed loop (clears its completion stamps; goal survives) |
| `runAt`        | `2h` / ISO                     | one extra run soon, then resume cadence |
| `taskFile`     | absolute path                  | repoint at a different task-file README |
| `goal`         | string, or `null`             | set/change the finish line, or clear it (clearing also drops completion) |
| `workflow`     | JS string                      | usually via `--workflow-file` instead |
| `ui`           | HTML string                    | usually via `--ui-file` instead |
| `stateSchema`  | array of `{key,label?,unit?}`  | usually via `--schema-file` instead |

Preview any patch with `--dry-run` — the server shows each key's before→after and any
rejections, changing nothing (exits non-zero if the patch would be rejected):

```bash
<loopany-cli> edit <loop-id> --json '{"goal":null,"cron":"0 9 * * *"}' --dry-run
```

## Content fields — reshape without a run

These read a file's raw content into the patch (schema parsed as JSON), mirroring the
run-time `set-*` verbs — because multi-line JS/HTML/JSON is awkward to embed in a
`--json` string:

```bash
<loopany-cli> edit <loop-id> --workflow-file wf.js      # replace the deterministic pre-stage JS
<loopany-cli> edit <loop-id> --ui-file dash.html        # replace the dashboard HTML
<loopany-cli> edit <loop-id> --schema-file schema.json  # replace the metric schema (JSON array)
```

A `--workflow-file` body must obey the workflow syntax contract — a plain statement
sequence run inside an async function, **not an ES module and not the Claude Code
`Workflow` tool** (no top-level `export`/`import`, never `export const meta = {…}`;
see `create.md` §4). The server parse-checks it and rejects a bad body (surfaced by
`--dry-run`).

Explicit `--json` keys win over any file flag. `loopany edit` prints
`updated <name> — <fields>` on success, or `loopany: <error>` to fix. You can only
edit loops bound to this machine; if `<loopany-cli> loops` doesn't list it, the user
is on a different machine than the one running the loop.

> Pausing, reopening, or running a loop now are also one-click in the Loopany web
> dashboard — point the user there for those rather than the CLI if they prefer.
