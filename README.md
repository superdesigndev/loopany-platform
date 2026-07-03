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
│  machine routes: /api/machine/poll · /agent-api/loop · /machine/report          │
│                  /api/machine/sync · /api/machine/blob/:hash (artifact sync)     │
│  SQLite (Drizzle) on a volume · artifact bytes in object storage                 │
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
the SQLite DB lives in `~/.loopany`, and artifact bytes are held in memory. Use
the Quickstart above against `http://127.0.0.1:3000` to connect a machine.

All configuration is env-based - copy [`.env.example`](.env.example) to
`packages/server/.env` and uncomment what you need.

### Production (any Node host)

```bash
pnpm install
pnpm build          # nitro build → packages/server/.output
pnpm start          # applies pending DB migrations, then serves on $PORT
```

For a real deployment, set at minimum:

- `LOOPANY_DATA_DIR` - a persistent directory for the SQLite DB.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` + `LOOPANY_AUTH_SECRET` (a long
  random value) + `LOOPANY_BASE_URL` + `LOOPANY_ALLOWED_LOGINS` - gate sign-in
  behind GitHub. Leaving these unset runs the app **open, with no auth** - fine
  locally, not on the public internet.
- `LOOPANY_R2_*` - an S3-compatible object store (e.g. Cloudflare R2) for
  artifact bytes. Unset, artifacts are stored in memory and lost on restart.

> **Run exactly one server process.** The in-process scheduler owns the cron
> loop; two processes against the same DB would double-fire every run.

### Docker

The included [`Dockerfile`](Dockerfile) builds the server and stores data on a
volume at `/data`:

```bash
docker build -t loopany .
docker run -p 3000:3000 -v loopany-data:/data loopany
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

[MIT](LICENSE) © 2026 Superdesign
