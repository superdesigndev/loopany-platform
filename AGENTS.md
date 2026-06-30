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
- **Artifact live-sync Phase 2 (web Files view) + Phase 3 (per-run diff).** Read-only,
  built on Phase 1. **Phase 2:** lazy-by-id server fns `getArtifacts`/`getArtifact`
  (`server/loopApi.ts`) → pure helpers in `server/artifactFiles.ts` (read bytes via
  `gateway.readBlob`, decode text; binary/oversize → download marker) → `FilesView.tsx`
  "Files" section in `JobDetailView`. Binary downloads stream from the
  session-authed, path-safe route `routes/api.artifact.$loopId.$.ts` (splat path;
  team-scoped via the shared `auth.loopInScope` predicate that `ownedLoop` also uses).
  **Phase 3:** `run_snapshots` table (migration `0012`, manifest = path→{hash,size,
  binary,oversize}); the gateway `report()` writes a snapshot from `artifact_files` at
  finalize (`store.buildLoopManifest`); `getRunDiff({runId})` lazily diffs run N vs the
  prior run (`store.prevRunSnapshot`) — unified text diff via the pure-string `diff`
  (jsdiff) lib in `server/runDiff.ts`, size-delta marker for binary/oversize — rendered
  in `RunView`'s "Changes (N)" section. The daemon flushes a final run-tagged sync
  before reporting (`watcher.flushLoop` + `runner` `reportRun`) so the snapshot captures
  end-state. Old runs with no snapshot degrade to a calm fallback; zero-exec invariant
  holds (server only stores/reads bytes + computes pure-string diffs).
- **Coding-agent recording (`loops.agent`).** A loop records WHICH coding agent it's
  bound to / was created by: `loops.agent` (`text`, TS-only enum `claude-code|codex`,
  NOT NULL default `claude-code`, migration `0013`). **Recording-only** — the daemon
  still EXECUTES every loop via Claude regardless of this value (Codex execution is a
  separate later phase, deliberately unbuilt). Capture at `loopany new`
  (`daemon/src/create.ts`): `resolveAgent(env, declared)` with precedence **measured
  env-fingerprint > declared (`--agent` flag / config `agent:`) > undefined**;
  undefined lets the server default it. Env fingerprints (verified, not memory):
  Claude Code = `CLAUDECODE`/`CLAUDE_CODE_*`; Codex = `CODEX_SANDBOX`/
  `CODEX_SANDBOX_NETWORK_DISABLED` (sandbox-only, so best-effort; we ignore
  `CODEX_COMPANION_*` which a Claude session also sets). The daemon sends `agent` in
  the `/api/machine/loop` POST; `gateway.createLoop` coerces an unknown value to the
  default (never rejects). `adapters.ts` reads `loop.agent` (no more hardcoded
  `executor:"claude"`); `JobSummary.kind` is `exec:<agent>` and `JobFull.agent`
  carries it. UI: `ComposeModal` has an agent selector — Codex is **selectable** but
  messaged "recorded — runs via Claude for now"; the snippet carries an `agent:` line;
  `SKILL.md` tells the agent to self-declare via `--agent`. Execution-path copy that
  truly means Claude (run-now, edit-via-Claude-Code in `JobDetailView`) stays "Claude"
  on purpose — that IS what runs. Daemon now has vitest (`create.test.ts`) for the
  detector/precedence; server tests cover createLoop persistence + adapter mapping.
- **CI/CD (`.github/workflows/`).** Two GitHub Actions workflows, deliberately split by
  trigger/cadence/blast-radius (they share nothing but the repo). **`deploy.yml`** — server
  → Fly (`loopany-testing`): fires on **push to `main`** (with `paths-ignore` for
  `packages/daemon/**`, `**/*.md`, `docs/**`) **plus `workflow_dispatch`**; a `fly-deploy`
  `concurrency` group (`cancel-in-progress`); `superfly/flyctl-actions/setup-flyctl@master`
  → `flyctl deploy --remote-only` (remote build, no Docker on runner). Note: `pnpm start`
  runs `drizzle-kit migrate` on container boot, so **every deploy applies pending
  migrations** (single machine, forward-only, no auto-rollback). **`publish-daemon.yml`** —
  daemon → npm: fires on **`push: tags: ['v*']`** plus `workflow_dispatch`; pnpm 8 +
  node 22; a **tag↔`packages/daemon/package.json` version guard** (a stray/mismatched tag
  can't publish); `npm publish` with `working-directory: packages/daemon` — **publishes ONLY
  the daemon, never the private `@loopany/server`**. Required repo secrets (captain adds
  them, never in the files): **`FLY_API_TOKEN`** (deploy) and **`NPM_TOKEN`** (publish).
  **Provenance is wired but OFF** (commented `id-token: write` + a note on the publish line):
  the repo is private now and provenance requires a public source repo — flip both when it
  goes public. These workflows only run on GitHub (push/tag), not in the local pipeline.

## Commands

- `pnpm dev` — server on :3000 (UI + scheduler + machine routes).
- `pnpm -r typecheck` · `pnpm --filter @loopany/server test`.
- `pnpm --filter @loopany/server db:generate` / `db:migrate`.
- `bash scripts/demo-cookie-unified.sh` — Cookie loop e2e through the unified server.

## Verified e2e

The **Cookie Daily Breakfast Report** loop runs end-to-end: scheduler → daemon poll → claude →
`loopany report` → run `done` (real breakfast report). Dashboard renders real data
(browser-verified, Geist style). 5 server tests green; both packages typecheck.
