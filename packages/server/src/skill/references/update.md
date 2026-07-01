# Edit an existing loop

A loop lives in two places, and you change each where it lives. Use the same
**loopany-cli** prefix as for create (default `npx @crewlet/loopany@latest`); it
reuses this machine's persisted device token, so no `--server-url`/`--connect-key`
or other auth is needed.

- **Schedule / delivery envelope** (cadence, name, timezone, notify, model, pause) —
  the server owns it. Change it with `loopany edit` (below).
- **What the loop does** (its instructions, context, log) — that's the loop's
  **task file (`loopany/<slug>/README.md`) on this machine**. Just edit that file
  directly in the repo, keeping its `## Spec` / `## Current understanding` /
  `## Timeline` structure. It syncs back to the server on the loop's next run;
  nothing else to do. (For how a run reads and maintains that file, see `evolve.md`.)
  To point the loop at a **different** task file (migrating/reshaping an existing
  loop), use `loopany edit --task-file <path>` (below) — the server just records
  the new path; move/create the file yourself.
- **Dashboard / metric schema / workflow gate** — normally a loop shapes these
  itself from its own run history during its **evolution pass** (see `evolve.md`),
  so leave them to it unless the user explicitly asks to reshape one. When they do,
  you *can* push them directly from here without waiting for a run — `loopany edit`
  accepts `--workflow-file` / `--ui-file` / `--schema-file` (below). The server
  validates each with the exact same rules the run-time `set-*` verbs use (schema
  changes stay additive — you can't drop a key still bound by the UI or reported by
  recent runs).

First find the loop id (only loops bound to THIS machine are listed):

```bash
<loopany-cli> loops
# -> loop-xxxx  on      0 8 * * *  Asia/Shanghai  Cookie Daily Breakfast Report
#    loop-yyyy  paused  0 * * * *                 Hourly metrics
```

Before reshaping a loop, see how its recent runs actually went — a concise survey
of their status, metrics, and session ids — with `<loopany-cli> log` (the loop for
the current directory) or `<loopany-cli> log <loop-id>` (`--limit N`, `--json`; add
`--transcript` for the full transcript). Read it first so an edit is grounded in
what the runs really did, not a guess.

Then change the envelope — pass only the fields that change:

```bash
<loopany-cli> edit <loop-id> --cron "0 9 * * *"        # reschedule (5-field cron)
<loopany-cli> edit <loop-id> --tz "America/New_York"   # change the timezone (IANA name)
<loopany-cli> edit <loop-id> --name "New name" --notify always   # rename + notify policy
<loopany-cli> edit <loop-id> --model <model>           # change the coding-agent model
<loopany-cli> edit <loop-id> --pause                   # or --resume
<loopany-cli> edit <loop-id> --run-at 2h               # one extra run in 2h, then resume cadence
<loopany-cli> edit <loop-id> --task-file <path>        # repoint at a different task-file README
```

Content fields — reshape the loop without waiting for a run. These read a file's
raw content into the patch (schema is parsed as JSON), mirroring the run-time
`set-*` verbs:

```bash
<loopany-cli> edit <loop-id> --workflow-file wf.js      # replace the deterministic pre-stage JS
<loopany-cli> edit <loop-id> --ui-file dash.html        # replace the dashboard HTML
<loopany-cli> edit <loop-id> --schema-file schema.json  # replace the metric schema (JSON array)
```

For anything else, pass a **partial JSON** patch of the fields to change — the
server validates it and rejects unknown keys:

```bash
<loopany-cli> edit <loop-id> --json '{"cron":"0 9 * * *","notify":"always"}'
<loopany-cli> edit <loop-id> --json-file patch.json
```

Explicit `--json`/`--json-file` keys win over any flag-derived value. The
whitelist is: `name`, `cron`, `timezone`, `notify`, `model`, `allowControl`,
`taskFile`, `enabled`, `runAt`, `workflow`, `ui`, `stateSchema`.

`--notify` is `always | auto | never`. It prints `updated <name> — <fields>` on
success, or `loopany: <error>` to fix. You can only edit loops bound to this
machine; if `<loopany-cli> loops` doesn't list it, the user is on a different
machine than the one running the loop.

> Pausing, deleting, or running a loop now are also one-click in the LoopAny web
> dashboard — point the user there for those rather than the CLI if they prefer.
