# Contributing to Loopany

Thanks for your interest in contributing! This guide covers the basics for
getting set up and landing a change.

## Repo layout

Loopany is a pnpm monorepo with two packages:

- **`packages/server`** (`@loopany/server`, private) — the TanStack Start web app:
  UI + server functions + the in-process scheduler + machine/agent routes + Better
  Auth + artifact storage. Drizzle/SQLite. Deployed on Fly.
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

> Changed `packages/server/src/db/schema.ts`? Generate and apply the migration
> locally — dev does **not** auto-migrate:
> ```bash
> pnpm --filter @loopany/server db:generate   # write the SQL + snapshot
> pnpm --filter @loopany/server db:migrate     # apply to the dev DB
> ```

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
  (`.github/workflows/deploy.yml`).
- **Daemon** (`@crewlet/loopany`) — publishes to npm on a `vX.Y.Z` git tag
  (`.github/workflows/publish-daemon.yml`, via npm OIDC trusted publishing). The
  tag must match the version in `packages/daemon/package.json`.

## Licensing & CLA

Loopany is licensed per package (see the root [`LICENSE`](LICENSE) for the
full map):

- **`packages/daemon`** (`@crewlet/loopany`) — [MIT](packages/daemon/LICENSE).
- **`packages/server`** (`@loopany/server`) —
  [AGPL-3.0-only](packages/server/LICENSE). The skill files under
  `packages/server/src/skill/` that are bundled into the daemon npm package
  are MIT, so the published daemon stays MIT in its entirety.

Before your first pull request is merged you'll be asked to sign our
[Contributor License Agreement](.github/CLA.md) — a bot comments on the PR
and signing is a one-time, one-comment step. You keep the copyright to your
contributions; the CLA grants Superdesign the license rights described in
the document.
