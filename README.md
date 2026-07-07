# Loopany

Scheduled **agent loops** for you and your team. Describe a recurring task once;
Loopany runs it on a schedule using **your own machine's coding agent** and
surfaces each result on a shared dashboard and your team's notification channel.

## Why

Most systems you care about - a codebase, a product, a team, your metrics -
stay healthy through small recurring loops: check what changed, triage what's
new, summarize, nudge whatever drifted. Each loop is trivial on its own;
together they are how a complex system stays under control. And they all
compete for your attention - the moment you stop turning the crank, the system
goes quiet.

Loopany turns each of those chores into an agent loop. Describe it once, and an
agent on your own machine runs it on schedule - watching, digesting, acting,
and reporting every run. A loop can stay open-ended (a monitor or digest that
runs indefinitely) or work toward a goal (it has a finish line and closes
itself once the goal is met).

Loops also improve themselves. Loopany periodically reviews a loop's own run
history and evolves it: sharpening the task brief, folding repeated mechanical
work into a cheap deterministic pre-stage, refining its dashboard - so a loop
gets sharper and cheaper the longer it runs, and you spend your attention on
the judgment calls, not the cranking.

## Quickstart (connect to a server)

You need an account on a Loopany server (the web app) and a machine you control
to run the loops on.

1. **Sign in** to the Loopany web app.
2. **Create a loop.** The *New loop* dialog hands you a short **connect snippet**
   with a server URL and a one-time connect-key. Or start from a **template** - the
   cards beside *New loop* (like *React Doctor*) hand you the same snippet with the
   loop's task description filled in.
3. **Connect your machine.** Paste the whole snippet into your local Claude Code -
   it connects the machine and builds the loop with you. Or start the daemon
   directly:

   ```bash
   npx @crewlet/loopany up --server-url <server-url> --connect-key <connect-key>
   ```

Daemon cheatsheet (`npx @crewlet/loopany --help` for everything):

| Command | What it does |
| --- | --- |
| `status` / `down` | is the daemon running + connection state / stop it |
| `log` | survey a loop's recent runs (add `--transcript` for full text) |
| `@latest update` | upgrade the daemon in place (the dashboard flags outdated ones) |

## How it works

Loopany is one server process plus one daemon per machine. The server never
runs an LLM and never executes your code - it only schedules, stores artifacts,
authenticates, and notifies. Execution happens on **your** machine via the
[`@crewlet/loopany`](https://www.npmjs.com/package/@crewlet/loopany) daemon,
talking to your local coding agent.

```
┌── Loopany server (TanStack Start · one process · zero code-exec · zero LLM) ──┐
│  dashboard + server fns · Better Auth · in-process Scheduler (croner)          │
│  machine routes: /api/machine/cli (unified CLI dispatch) · /api/machine/poll     │
│                  /machine/report · /api/machine/sync · /api/machine/blob/:hash    │
│                  /agent-api/loop · /api/machine/loop|log (legacy CLI aliases)     │
│  Postgres (Drizzle; embedded pglite by default) · artifact bytes in object store │
└───────────▲ HTTP short-poll ────────────────────────────────────────────────────┘
            │
┌───────────┴── @crewlet/loopany (your machine · `npx`) ──────────────────────────┐
│  polls for due runs → runs the task with your local coding agent                 │
│  syncs artifacts + reports the result back via the `loopany` callback            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

A scheduler tick creates a *pending run*; your bound machine's next poll claims
it, runs the agent, and reports the result (which can post to the loop's push
channel). Because the agent runs on your machine, your credentials, files, and
tools never leave it - the server only stores the bytes your loop chooses to
sync back.

## Run your own server

### Prerequisites

- Node.js >= 22
- pnpm 8.15 (pinned via the root `packageManager` field; `corepack enable`
  picks it up automatically)

### Local development

```bash
git clone https://github.com/superdesigndev/loopany-platform
cd loopany-platform
pnpm install
pnpm dev            # http://127.0.0.1:3000
```

That is a fully working server out of the box: auth is off (the app runs open),
the database is an embedded, file-backed **pglite** Postgres at `~/.loopany/pgdata`
(zero external DB — it migrates itself at boot), and artifact bytes are held in
memory. Use the Quickstart above against `http://127.0.0.1:3000` to connect a machine.

All configuration is env-based. For **local development only**, copy
[`.env.example`](.env.example) to `packages/server/.env` and uncomment what you
need - vite loads that file for `pnpm dev`. **`pnpm start` and Docker do NOT read
`.env`**: in production pass real environment variables instead (Fly secrets,
`docker -e` / `--env-file`, or a systemd `Environment=`), never a committed `.env`.

### Production (any Node host)

```bash
pnpm install
pnpm build          # nitro build → packages/server/.output
pnpm start          # applies pending DB migrations, then serves on $PORT
```

For a real deployment, set at minimum:

- **Database** - either point `DATABASE_URL` at a Postgres (e.g. Supabase; set
  it to the transaction pooler `:6543`, plus `DIRECT_DATABASE_URL` at the direct
  `:5432` URL for migrations), or leave both unset and give `LOOPANY_DATA_DIR` a
  persistent directory - the embedded pglite database lives at `<dir>/pgdata`.
  `pnpm start` applies pending migrations before serving (over the direct URL for
  the hosted tier; in-process for the pglite tier).
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` + `LOOPANY_AUTH_SECRET` (a long
  random value) + `LOOPANY_BASE_URL` + `LOOPANY_ALLOWED_LOGINS` - gate sign-in
  behind GitHub. Leaving these unset runs the app **open, with no auth** - fine
  locally, not on the public internet.
- `LOOPANY_R2_*` - an S3-compatible object store (e.g. Cloudflare R2) for
  artifact bytes. Unset, artifacts are stored in memory and lost on restart.

> **Exposing a server publicly? Set the auth vars.** With `GITHUB_CLIENT_ID` /
> `GITHUB_CLIENT_SECRET` / `LOOPANY_AUTH_SECRET` / `LOOPANY_BASE_URL` /
> `LOOPANY_ALLOWED_LOGINS` unset the app runs **open, with no sign-in** - anyone
> who can reach it is in. This applies equally to a bare Node host and the Docker
> image below.

> **Run exactly one server process.** The in-process scheduler owns the cron
> loop; two processes against the same DB would double-fire every run.

> **Backing up the embedded pglite tier.** `<LOOPANY_DATA_DIR>/pgdata` is a LIVE
> Postgres data directory. Stop the server before copying it - a hot copy of a
> running data dir is not crash-consistent. If you need real, online backups, run
> the hosted tier instead (`DATABASE_URL`/Supabase gives you point-in-time backups).

### Docker

The included [`Dockerfile`](Dockerfile) builds the server. With no `DATABASE_URL`
it runs the embedded pglite database on a volume at `/data`; with a `DATABASE_URL`
(Supabase/any Postgres) the container is stateless and needs no volume:

```bash
docker build -t loopany .
# Embedded pglite (persist the DB on a volume):
docker run -p 3000:3000 -v loopany-data:/data loopany
# Or against Postgres (stateless):
docker run -p 3000:3000 -e DATABASE_URL=... -e DIRECT_DATABASE_URL=... loopany
```

Pass configuration with `-e KEY=value` or `--env-file` (same variables as
[`.env.example`](.env.example)).

### Notifications

Push channels are configured per team in the dashboard (the *Notifications*
modal) - Telegram and Feishu have add-forms today; Slack is a supported delivery
transport. Channel secrets are stored server-side per team, never in env vars.
Failure alerts ride the same channel: a failed run or a machine that goes
offline pushes an alert (anti-spammed: first failure, then every 5th).

## Development

```bash
pnpm dev              # server on http://127.0.0.1:3000
pnpm -r test          # all tests
pnpm -r typecheck     # both packages
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor guide (migrations,
releases, PR flow) and [`AGENTS.md`](AGENTS.md) for architecture notes.

## License

Licensed per package — see [`LICENSE`](LICENSE) for the full map:

- The machine-side daemon [`@crewlet/loopany`](packages/daemon) is
  [MIT](packages/daemon/LICENSE).
- The platform server [`@loopany/server`](packages/server) is
  [AGPL-3.0-only](packages/server/LICENSE).

© 2026 Superdesign. Contributions require a one-time
[CLA sign-off](.github/CLA.md) on your first pull request.
