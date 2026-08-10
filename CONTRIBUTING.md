# Contributing to Loopany

Thanks for your interest in contributing! This guide covers the basics for
getting set up and landing a change.

## Repo layout

Loopany is a pnpm monorepo with two packages:

- **`packages/server`** (`@loopany/server`, private) — the TanStack Start web app:
  UI + server functions + the in-process scheduler + machine/agent routes + Better
  Auth + artifact storage. Drizzle over Postgres (embedded pglite for local
  dev, external Postgres in production). Deployed on Fly.
- **`packages/daemon`** (`@crewlet/loopany`, public on npm) — the machine-side
  daemon that runs on each user's own machine, polls the server for due runs, and
  executes them via the user's local coding agent (BYOA).

`AGENTS.md` is the in-repo design/decision log — read it for architecture context.

## Prerequisites

- Node.js `>= 22`
- pnpm `8.15.0` (pinned via the root `packageManager` field; `corepack enable`
  picks it up automatically)

## Install

```bash
pnpm install
```

## Run the server locally

```bash
pnpm dev          # server on http://127.0.0.1:3000 (UI + scheduler + machine routes)
```

Copy `.env.example` to `packages/server/.env` if you need to configure auth,
the artifact blob store, or other options. The app runs open (no auth) by default.

> Changed `packages/server/src/db/schema.ts`? Author the migration, then let
> dev apply it. `db:generate` diffs the schema → SQL (no DB needed); the default
> embedded **pglite** dev tier auto-applies generated migrations in-process at
> boot, so restart `pnpm dev` to pick them up:
> ```bash
> pnpm --filter @loopany/server db:generate   # write the SQL + snapshot
> ```
> `db:migrate` (the drizzle-kit CLI) targets a real Postgres over the direct
> `:5432` URL only — use it when developing against a real Postgres
> (`DATABASE_URL` / `DIRECT_DATABASE_URL`), not the embedded pglite tier.

## Tests & typecheck

```bash
pnpm -r test                          # run every package's test suite
pnpm --filter @loopany/server test    # server only
pnpm --filter @crewlet/loopany test   # daemon only
pnpm -r typecheck                     # typecheck both packages
```

Please keep tests and `typecheck` green before opening a PR.

## Branches & pull requests

- Branch off `main` for your change; keep the branch focused.
- Open a PR against `main`. The CI deploy workflow runs on merge to `main`.
- Write a clear PR description: what changed and why.

## Releases

- **Server** — deploys to Fly automatically on push to `main`
  (`.github/workflows/deploy.yml`, staging `loopany-testing`). Production
  (`loopany-prod` / loopany.ai) ships only via a manual `workflow_dispatch`
  (`.github/workflows/deploy-prod.yml`). Migrations are forward-only (an image
  rollback does not roll back schema); check the `machines.daemon_version`
  fleet before removing legacy endpoints.
- **Daemon** (`@crewlet/loopany`) — publishes to npm on a `vX.Y.Z` git tag
  (`.github/workflows/publish-daemon.yml`, via npm OIDC trusted publishing). The
  tag must match the version in `packages/daemon/package.json`.

## Licensing

Loopany is licensed under the [MIT License](LICENSE), and every package is MIT:

- **`packages/daemon`** (`@crewlet/loopany`) — [MIT](packages/daemon/LICENSE).
- **`packages/server`** (`@loopany/server`) — [MIT](packages/server/LICENSE).

Contributions are accepted under the MIT license (inbound=outbound): by opening
a pull request you agree that your contribution is provided under the same MIT
license as the project. There is **no CLA** and **no DCO / sign-off**
requirement - nothing extra to sign, and you keep the copyright to your work.
