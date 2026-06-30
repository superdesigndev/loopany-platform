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
- **Dashboard / metric schema / workflow gate** — you don't hand-author these from
  here. A loop refits its own dashboard and gate to the data it produces during its
  **evolution pass** (see `evolve.md`); leave them to it unless the user explicitly
  asks to reshape the dashboard, in which case describe the change in the task file's
  Spec so the next evolution pass picks it up.

First find the loop id (only loops bound to THIS machine are listed):

```bash
<loopany-cli> loops
# -> loop-xxxx  on      0 8 * * *  Asia/Shanghai  Cookie Daily Breakfast Report
#    loop-yyyy  paused  0 * * * *                 Hourly metrics
```

Before reshaping a loop, see how its recent runs actually went — their status and
execution transcript — with `<loopany-cli> log` (the loop for the current
directory) or `<loopany-cli> log <loop-id>` (`--limit N`, `--json`). Read it first
so an edit is grounded in what the runs really did, not a guess.

Then change the envelope — pass only the fields that change:

```bash
<loopany-cli> edit <loop-id> --cron "0 9 * * *"        # reschedule (5-field cron)
<loopany-cli> edit <loop-id> --tz "America/New_York"   # change the timezone (IANA name)
<loopany-cli> edit <loop-id> --name "New name" --notify always   # rename + notify policy
<loopany-cli> edit <loop-id> --model <model>           # change the coding-agent model
<loopany-cli> edit <loop-id> --pause                   # or --resume
<loopany-cli> edit <loop-id> --run-at 2h               # one extra run in 2h, then resume cadence
```

`--notify` is `always | auto | never`. It prints `updated <name> — <fields>` on
success, or `loopany: <error>` to fix. You can only edit loops bound to this
machine; if `<loopany-cli> loops` doesn't list it, the user is on a different
machine than the one running the loop.

> Pausing, deleting, or running a loop now are also one-click in the LoopAny web
> dashboard — point the user there for those rather than the CLI if they prefer.
