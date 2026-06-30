# Edit an existing loop

The loop lives in two places, and you edit each where it lives. Use the same
**loopany-cli** prefix as for create (default `npx @crewlet/loopany@latest`); it
reuses this machine's persisted device token, so no `--server-url`/`--connect-key`
or other auth is needed.

- **Schedule / delivery envelope** (cadence, name, timezone, notify, model, pause)
  — the server owns it. Change it with `loopany edit` (below).
- **What the loop does** (its instructions, context, log) — that's the loop's
  **task file (`loopany/<slug>/README.md`) on this machine**. Just edit that file
  directly in the repo. It syncs back to the server on the loop's next run; nothing
  else to do. (For how a run reads and maintains that file, see `evolve.md`.)

First find the loop id (only loops bound to THIS machine are listed):

```bash
<loopany-cli> loops
# -> loop-xxxx  on      0 8 * * *  Asia/Shanghai  Cookie Daily Breakfast Report
#    loop-yyyy  paused  0 * * * *                 Hourly metrics
```

Then change the envelope (pass only what changes):

```bash
<loopany-cli> edit <loop-id> --cron "0 9 * * *"      # reschedule (5-field cron)
<loopany-cli> edit <loop-id> --name "New name" --notify always
<loopany-cli> edit <loop-id> --pause                 # or --resume
<loopany-cli> edit <loop-id> --run-at 2h             # one extra run in 2h, then resume cadence
```

It prints `updated <name> — <fields>` on success, or `loopany: <error>` to fix.
You can only edit loops bound to this machine; if `<loopany-cli> loops` doesn't
list it, the user is on a different machine than the one running the loop.

> Pausing, deleting, or running a loop now are also one-click in the LoopAny web
> dashboard — point the user there for those rather than the CLI if they prefer.
