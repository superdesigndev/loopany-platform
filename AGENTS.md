# CLAUDE.md

Guidance for Claude Code working in this repo.

**LoopAny** — multi-user scheduled **agent loops**. The server (TanStack Start)
schedules/stores/authenticates/notifies; execution is **BYOA** — claude-code runs
on each user's own machine via the `@crewlet/loopany` daemon. The server runs **no
LLM and executes no user code**.

> This was carved out of [c0](../c0). The single source of truth for architecture
> and every design decision (with the deviation/lessons log) is
> **`docs/loopany-mvp-design.md`** — read it first. Run instructions: `README.md`.

## Layout (pnpm monorepo)

- `packages/server` (`@loopany/server`) — TanStack Start UI + server fns +
  in-process Scheduler (croner) + machine routes (`/api/machine/poll`,
  `/agent-api/loop`, `/machine/report`) + Better Auth + push notifications. Drizzle/SQLite.
  - `src/scheduler/` — the cron engine (tick → pending run → Dispatcher).
  - `src/gateway/` — machine gateway (poll/agent-api/report/**sync/blob**), run tokens, delivery, prompt, notify (per-team push channels), **blobstore** (R2/in-memory), **artifacts** (path-safety/ignore/caps).
  - `src/db/` — Drizzle schema (machines/loops/runs/**blobs/artifact_files**) + store + auth-schema.
  - `src/server/` — boot (`ensureServer`), adapters (Loop/Run → JobSummary/JobDetail), loopApi server fns.
  - `src/routes/` — pages + server-only route files.
- `packages/daemon` (`@crewlet/loopany`) — poll loop + `loopany` callback; spawns claude.

## Key facts / gotchas

- **One process owns the scheduler** (`ensureServer` globalThis guard). Never run
  the unified server AND `main.ts` against the same DB (double-fire).
- **vite binds `127.0.0.1`** (not IPv6 `localhost`) — see `vite.config.ts`.
- **`src/routeTree.gen.ts` is generated, not committed** (gitignored). The TanStack
  Start vite plugin writes it on `dev`/`build`, but `tsc --noEmit` needs it too. So
  `typecheck` runs `tsr generate` first (`@tanstack/router-cli`, pinned to the same
  `router-generator` the Start plugin uses) — a fresh checkout typechecks with **no
  prior build**. Run `routes:generate` standalone if you need the file otherwise.
- Machine transport is **HTTP short-poll** (not WS) — see design doc §11 D1.
- Server route files use `createFileRoute(path).server.handlers`; heavy/native
  imports are **dynamic-imported inside handlers** to stay out of the client bundle.
- Prod: nitro build → `pnpm start` = `drizzle-kit migrate` then `node .output/server/index.mjs`.
- **Changed `db/schema.ts`? Migrate locally right away**: `db:generate` (writes the
  SQL + snapshot under `drizzle/`) **then** `db:migrate` (applies to the dev DB). Dev
  does NOT auto-migrate on `pnpm dev` — skip the apply and the running server hits a
  missing column. Prod applies on `pnpm start`; local is on you.
- **Drizzle `text(col, { enum: [...] })` is a TS-only constraint** — SQLite columns are
  plain `text` with no DB-level CHECK (confirmed in `drizzle/*.sql`). Adding/removing an
  enum value (e.g. dropping the deprecated `draft` RunRole) is a pure type change; it needs
  no migration and cannot break existing rows.
- **Artifact live-sync (Phase 1).** The daemon (`packages/daemon/src/watcher.ts`,
  chokidar v4) watches each loop's own folder (`dirname(taskFile)` → `workdir` →
  scratch), learns the watch set from the poll response's `watch:[…]` (server-
  authoritative, restart-safe), sha256-hashes the folder into a FULL manifest
  (deletions = absence), and content-addressed-syncs to `POST /api/machine/sync`
  (**device token**, NOT the run token — it's revoked at run end). Negotiated upload:
  server replies `needHashes`; daemon `PUT /api/machine/blob/:hash` (server verifies
  `sha256(body)===:hash`); small text blobs (≤64KB) inline in the POST. Per-file cap
  **10MB** → larger files sync as metadata only (`artifact_files.oversize`). Blob BYTES
  live in **Cloudflare R2** (`gateway/blobstore.ts`, `LOOPANY_R2_*` env; in-memory store
  when unset — that's the test/dev default, so tests need no creds/network), metadata in
  `blobs`/`artifact_files`. The zero-exec invariant holds: the server only stores/reads
  bytes. The ignore list (`.git`/`node_modules`/`.loopany`/`.env*`/`*.pem`/`id_rsa*`/…)
  is enforced on BOTH daemon (don't send) and server (`gateway/artifacts.ts`, don't store).
  Phases 2 (web Files view) + 3 (`run_snapshots` per-run diff) are NOT built yet — `runId`
  is already threaded onto syncs and `artifact_files.lastRunId` recorded as the Phase 3 seam.

## Commands

- `pnpm dev` — server on :3000 (UI + scheduler + machine routes).
- `pnpm -r typecheck` · `pnpm --filter @loopany/server test`.
- `pnpm --filter @loopany/server db:generate` / `db:migrate`.
- `bash scripts/demo-cookie-unified.sh` — Cookie loop e2e through the unified server.

## Verified e2e

The **Cookie Daily Breakfast Report** loop runs end-to-end: scheduler → daemon poll → claude →
`loopany report` → run `done` (real breakfast report). Dashboard renders real data
(browser-verified, Geist style). 5 server tests green; both packages typecheck.
