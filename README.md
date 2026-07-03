# LoopAny

Scheduled **agent loops** for you and your team. Describe a recurring task once;
LoopAny runs it on a schedule using **your own machine's coding agent**
(BYOA — bring your own agent) and surfaces each result on a shared dashboard and
your team's notification channel.

The server never runs an LLM and never executes your code. It only schedules,
stores artifacts, authenticates, and notifies — execution happens on **your**
machine via the [`@crewlet/loopany`](https://www.npmjs.com/package/@crewlet/loopany)
daemon, talking to your local Claude Code.

## Quickstart

You need two things: an account on a LoopAny server (the web app) and a machine
you control to run the loops on.

1. **Sign in** to the LoopAny web app.
2. **Create a loop.** Open the *New loop* dialog. It hands you a short **connect
   snippet** containing a server URL and a one-time connect-key (the agent you paste
   it into asks what the loop should do and how often).
3. **Connect your machine.** On the machine that should run the loop, start the
   daemon with the values from the snippet:

   ```bash
   npx @crewlet/loopany up --server-url <server-url> --connect-key <connect-key>
   ```

   Or paste the whole snippet into your local Claude Code — it fetches the
   loopany onboarding doc and follows it to connect the machine and build the
   loop for you.

That's it. The server schedules the loop; your machine picks up each due run,
executes it with your local agent, and reports the result back to the dashboard
(and, if configured, your team's push channel).

To check on or stop the machine's daemon later, run `npx @crewlet/loopany status`
(is it running? + connection state) or `npx @crewlet/loopany down` (stop it). To
see how a loop's recent runs went (a concise survey of status, metrics, and
session ids; add `--transcript` for the full transcript) before editing it, run
`npx @crewlet/loopany log` from the loop's folder. To upgrade the daemon (the
dashboard flags an outdated one), run `npx @crewlet/loopany@latest update` — it
stops the running daemon, starts the new version, and refreshes the skill. Run
`npx @crewlet/loopany --help` for the full command list.

## How it works

LoopAny is one server process plus one daemon per machine.

```
┌── LoopAny server (TanStack Start · one process · zero code-exec · zero LLM) ──┐
│  dashboard + server fns · Better Auth · in-process Scheduler (croner)          │
│  machine routes: /api/machine/poll · /agent-api/loop · /machine/report          │
│                  /api/machine/sync · /api/machine/blob/:hash (artifact sync)     │
│  SQLite (Drizzle) on a volume · artifact bytes in object storage                 │
└───────────▲ HTTP short-poll ────────────────────────────────────────────────────┘
            │
┌───────────┴── @crewlet/loopany (your machine · `npx`) ──────────────────────────┐
│  polls for due runs → runs the task with your local Claude Code                  │
│  syncs artifacts + reports the result back via the `loopany` callback            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

A scheduler tick creates a *pending run*; your bound machine's next poll claims it,
runs the agent, and reports the result (which can post to the loop's push channel).
Because the agent runs on your machine, your credentials, files, and tools never
leave it — the server only ever stores and serves the bytes your loop chooses to
sync back.

## Development

LoopAny is a pnpm monorepo:

- `packages/server` (`@loopany/server`) — the web app, scheduler, and machine API.
- `packages/daemon` (`@crewlet/loopany`) — the machine-side daemon (one binary,
  two roles: daemon and `loopany` callback).

```bash
pnpm install
pnpm dev                      # server on http://127.0.0.1:3000
pnpm -r test                  # run all tests
pnpm -r typecheck             # typecheck both packages
```

See [`.env.example`](.env.example) for configuration (data dir, optional GitHub
auth, artifact blob store, daemon settings) and [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the full contributor guide, including how the server deploys and how the daemon
publishes to npm.

### Auth & notifications

- **Auth** is off by default (the app runs open). Set `GITHUB_CLIENT_ID/SECRET`
  plus `LOOPANY_ALLOWED_LOGINS` to gate sign-in behind GitHub login.
- **Push channels** are configured per team in the dashboard (the *Notifications*
  modal) — Telegram and Feishu have add-forms today; Slack is a supported delivery
  transport. Channel secrets are stored server-side per team, never in env vars.
- **Failure alerts** fire on the same channel, not just on success: a failed run,
  a run that times out, or a prolonged machine-offline pushes a "run failed /
  reconnect your machine" alert. A persistently broken loop is anti-spammed — it
  alerts on the first failure, then only every 5th consecutive one. Setting a
  loop's notify policy to `never` silences failure alerts too.

## License

[MIT](LICENSE) © 2026 Superdesign
