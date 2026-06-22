# TODO

Working backlog. See `docs/loopany-mvp-design.md` for architecture.

## 1. Investigate `Jasons-MacBook-Pro-3.local` going offline repeatedly

Machine `m-937e49fe47600c72` (Jason's MacBook Pro) repeatedly hits `machine offline`
/ `claude timed out (900s)` mid-run; after the task fails the machine auto-reconnects.
**Primary suspicion: laptop sleep** stopping the daemon heartbeat.

Evidence (observed 2026-06-20, loop `Support Inbox Triage` / `loop-mqmbdq4e`):
- Timed-out run `09d81d0d` ran the full 15min with **zero progress / zero transcript**
  -> stuck on an external dependency (suspected Intercom), not heavy workload; normal
  runs only take 67-89s.
- `machine offline` is a separate, independent symptom: heartbeat gap >30s
  (`ONLINE_TTL_MS`) -> the pending run gets reclaimed.

Thresholds for reference: daemon `POLL_MS=3s` / claude `TIMEOUT_MS=15min`; server
`ONLINE_TTL_MS=30s` / `PENDING_GRACE_MS=60s` / `RUN_TIMEOUT_MS=20min`.

To do:
- [ ] Check Jason's machine `~/.loopany/daemon.log` for that window: truly offline or daemon stuck?
- [ ] Confirm whether it's laptop sleep / lid close / wifi flapping; suggest running the daemon with `caffeinate -i`
- [ ] Check whether the Intercom credentials / MCP call can hang forever (no timeout)
- [ ] Code-side mitigation: add a client-side timeout to the poll `fetch` (`daemon/src/daemon.ts:76` only has an abort
      signal); relax `ONLINE_TTL_MS` to 60-90s to reduce false positives

## 2. The daemon should no longer need to create `.loopany/bin` ✅ DONE

~~Currently the daemon writes a `.loopany/bin/loopany` PATH wrapper (shim) into the working directory.~~
This is now unified into the `@crewlet/loopany` entry point: no per-run shim generation, no polluting the workdir.

Implementation (`callback-bin.ts` + `runner.ts` + `daemon.ts` + `cli.ts`):
- The shim's responsibilities (file-flag inlining + run-token + POST `/agent-api/loop`) already had an
  equivalent implementation in `callback.ts::runCallback`; `cli.ts` already routed `loopany <verb>` (with run
  token) to it. `shim.ts` / `SHIM_SOURCE` was a redundant second copy and has been deleted.
- New `callback-bin.ts`: at daemon boot, write **one** re-exec wrapper to
  `~/.loopany/bin/loopany` that replays how the daemon itself was launched (`execPath` + `execArgv` + entry),
  launch-agnostic (covers npx / `node dist` / `tsx src`). At run time, prepend that directory to
  claude's PATH. `cli.ts` switched to branch-based lazy loading, so the callback path no longer loads daemon/interactive code.
- `sys-<runId>.md` also moved out of the workdir -> `~/.loopany/runs/`, with `rmSync` in the `finally`
  after the run, so it no longer piles up.
- Also: `.loopany/` and `/loopany/` were added to `.gitignore` (this session).
- e2e verified: a real daemon boot writes a clean wrapper `exec 'node' '…/dist/cli.js' "$@"`;
  `loopany report --message` / `--message-file` (multi-line body) -> callback -> POST ->
  prints response -> exit 0; file-flag inlining correct. Both packages typecheck.

## 3. Carefully optimize every prompt

Do a full pass over all prompts under `packages/server/src/scheduler/prompts/`
(`exec-loop.md` / `evolve.md` / `edit.md` / `control-on.md` / `control-off.md`).

Background: already found that `evolve.md` treated the set-schema as purely descriptive, causing a
prose-only exec loop to be misjudged as non-evolvable (fixed, see commit `55cd56b`). Similar
conceptual gaps may remain.

To do:
- [ ] Review each prompt one by one: are capability boundaries stated clearly, any misleading wording, any mechanism left unexplained?
- [x] Add the `loopany` subcommand list to the exec/evolve standing prompts. Done for exec-loop.md: its intro now points the
      agent at `loopany help`, the role-aware verb list. (Correction: that verb list already exists - `-h` / `--help` / `help`
      all route to it in `gateway/index.ts:536`; the earlier "doesn't exist yet" note was wrong.) evolve.md still TBD.
- [ ] Investigate the character-dropping bug in transcript storage (`unknown command` rendered as `u k ow comma d`)
