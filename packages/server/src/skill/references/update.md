# Edit an existing loop

A loop lives in two places, and you change each where it lives. Use the same
**loopany-cli** prefix as for create (default `npx @crewlet/loopany@latest`); it
reuses this machine's persisted device token, so no `--server-url`/`--connect-key`
or other auth is needed.

- **Schedule / delivery envelope + goal** (cadence, name, timezone, notify, model,
  pause, goal, …) — the server owns it. Change it with `loopany edit` (below), which
  is **JSON-only**: one `--json '<patch>'` of just the fields that change.
- **What the loop does** (its instructions, context, log) — that's the loop's **task
  file (`loopany/<slug>/README.md`) on this machine**. Edit that file directly in the
  repo, keeping its `## Spec` / `## Current understanding` / `## Timeline` structure.
  It syncs back to the server on the loop's next run; nothing else to do. (For how a
  run reads and maintains that file, see `evolve.md`.) To point the loop at a
  *different* task file, put the new path in the patch: `--json '{"taskFile":"…"}'`
  (the server just records the path; move/create the file yourself).
- **Dashboard / metric schema / workflow** — normally a loop shapes these itself from
  its own run history during its **evolution pass** (see `evolve.md`), so leave them
  to it unless the user explicitly asks. When they do, push them from here with the
  content-file flags (below); the server validates each with the exact same rules the
  run-time `set-*` verbs use (schema changes stay additive — you can't drop a key
  still bound by the UI or reported by recent runs).

First find the loop id (only loops bound to THIS machine are listed):

```bash
<loopany-cli> loops
# -> loop-xxxx  on      0 8 * * *  Asia/Shanghai  Cookie Daily Breakfast Report
#    loop-yyyy  paused  0 * * * *                 Hourly metrics
```

Before reshaping a loop, see how its recent runs actually went — a concise survey of
their status, metrics, and session ids — with `<loopany-cli> log` (the loop for the
current directory) or `<loopany-cli> log <loop-id>` (`--limit N`, `--json`; add
`--transcript` for the full transcript). Read it first so an edit is grounded in what
the runs really did, not a guess.

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

Explicit `--json` keys win over any file flag. `loopany edit` prints
`updated <name> — <fields>` on success, or `loopany: <error>` to fix. You can only
edit loops bound to this machine; if `<loopany-cli> loops` doesn't list it, the user
is on a different machine than the one running the loop.

> Pausing, reopening, or running a loop now are also one-click in the LoopAny web
> dashboard — point the user there for those rather than the CLI if they prefer.
