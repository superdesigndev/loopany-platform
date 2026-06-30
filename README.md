# LoopAny

Scheduled **agent loops** for your team. You describe a recurring task; LoopAny runs
it on a schedule via **your own machine's claude-code** (BYOA — bring your own agent)
and surfaces the result on a shared dashboard + your team's push channel. The server never runs an LLM
or executes your code; it only schedules, stores, authenticates, and notifies.

> Carved out of [c0](../c0)'s loop engine. Full design + decision log:
> [`docs/loopany-mvp-design.md`](docs/loopany-mvp-design.md).

## Architecture (one process + a daemon per machine)

```
┌── LoopAny server (TanStack Start · one process · zero code-exec · zero LLM) ──┐
│  dashboard + server fns · Better Auth (GitHub) · in-process Scheduler (croner) │
│  machine routes: /api/machine/poll · /agent-api/loop · /machine/report          │
│                  /api/machine/sync · /api/machine/blob/:hash (artifact sync)     │
│  SQLite (Drizzle) on a volume                                                    │
└───────────▲ HTTP short-poll ────────────────────────────────────────────────────┘
            │
┌───────────┴── @crewlet/loopany (your machine · `npx`) ──────────────────────────┐
│  polls for due runs → runs the workflow gate + `claude -p` in a jailed workdir   │
│  reports back via the `loopany` shim (run token)                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

A scheduler tick creates a *pending run*; the bound machine's next poll claims it,
runs claude, and reports the result (which can post to the loop's push channel).

## Run it locally

```bash
pnpm install

# 1) the server (UI + scheduler + machine endpoints), one process on :3000
pnpm dev                      # → http://127.0.0.1:3000

# 2) connect a machine (a daemon on the box that should run the loops)
cd packages/daemon && pnpm build
LOOPANY_TOKEN=<device-token> LOOPANY_SERVER_URL=http://127.0.0.1:3000 \
  node dist/cli.js            # foreground; Ctrl-C to stop
```

For the MVP a machine/device token is registered via `POST /api/admin`
(`{action:"register-machine",name,token}`) — see `scripts/demo-cookie-unified.sh`
for the full end-to-end (registers a machine, creates the **Cookie Daily Breakfast Report**
loop, runs it through claude, prints the report).

```bash
bash scripts/demo-cookie-unified.sh   # e2e against the unified dev server
bash scripts/demo-cookie.sh           # e2e against the standalone headless backend
```

## Production (Fly.io)

One always-on machine (the scheduler owns the cron loop — never scale past 1),
SQLite on a volume. See `fly.toml` for the setup commands. Build = nitro
(`.output/server/index.mjs`); `pnpm start` applies migrations then listens.

A push to `main` auto-deploys the server to Fly via GitHub Actions
(`.github/workflows/deploy.yml`, `flyctl deploy --remote-only`; needs the
`FLY_API_TOKEN` repo secret). The daemon (`@crewlet/loopany`) publishes to npm on
a `vX.Y.Z` tag (`.github/workflows/publish-daemon.yml`; authenticates via npm OIDC
trusted publishing — no `NPM_TOKEN` secret needed).

## Auth & notifications (optional)

- **Auth** is off by default (open). Set `GITHUB_CLIENT_ID/SECRET` +
  `LOOPANY_ALLOWED_LOGINS` to gate the dashboard behind GitHub login.
- **Push channels** are configured per team in the dashboard (the **Notifications**
  modal), not via global env. Each team can add Telegram or Feishu channels; a loop
  routes its results to one of them (or to the dashboard only). Slack is also a
  supported delivery transport but has no UI add-form yet. Channel secrets are
  stored server-side per team, never in environment variables.

See [`.env.example`](.env.example) for all variables.

## Packages

- `packages/server` (`@loopany/server`) — the product server.
- `packages/daemon` (`@crewlet/loopany`) — the machine-side daemon (one binary,
  two roles: daemon / `loopany` callback).
