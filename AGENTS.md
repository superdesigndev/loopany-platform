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
  node 22 — the pnpm version comes **solely from the root `packageManager: pnpm@8.15.0`**
  (matching `lockfileVersion 6.0`); `pnpm/action-setup@v6` is given **NO `version:` input**,
  since it errors (`Multiple versions of pnpm specified`) if both a `version:` input AND
  `packageManager` name pnpm; a **tag↔`packages/daemon/package.json` version guard** (a stray/mismatched tag
  can't publish); `npm publish` with `working-directory: packages/daemon` — **publishes ONLY
  the daemon, never the private `@loopany/server`**. **Auth is npm OIDC Trusted Publishing,
  NOT a token** — the job has `permissions: id-token: write` (+ `contents: read`) so the
  runner mints a short-lived OIDC token npm verifies against the Trusted Publisher configured
  on npmjs.com (publisher GitHub Actions, repo `superdesigndev/loopany-platform`, workflow
  `publish-daemon.yml`, no environment). The publish step has **no `NODE_AUTH_TOKEN`**;
  `setup-node`'s `registry-url` is kept only to target the public registry. Trusted publishing
  needs **npm CLI >= 11.5.1** (and Node >= 22.14.0); Node 22 bundles npm 10.x, so a
  `npm install -g npm@11` step runs after `setup-node` (pinned to npm@11, not `@latest`, for
  reproducibility — bump if npm ever requires 12+ for OIDC). **Provenance is automatic under
  OIDC — no `--provenance` flag** (npm emits it itself); per npm docs + the GH changelog,
  provenance is generated **only when the source repo is public** (Sigstore limitation — the
  same public-repo requirement applies to OIDC, it is NOT relaxed), but a **private-repo
  publish still succeeds, just without provenance**, and provenance starts emitting
  automatically the moment the repo goes public with **zero workflow change**. Required repo
  secret: **`FLY_API_TOKEN`** (deploy) — captain adds it, never in the files. **`NPM_TOKEN`
  is no longer used** and can be deleted from repo secrets. These workflows only run on GitHub
  (push/tag), not in the local pipeline.
- **Per-team connect-key → loop team (multi-team capture).** A user can belong to
  multiple teams; a loop captured from team B's dashboard must land in team B even
  though the user has ONE machine/daemon. A loop's team is decoupled from the
  machine's single `teamId`: the **connect-key/claim carries the team**, not the
  machine. `mintClaim` (`server/loopApi.ts`) reads the VALIDATED active team from
  `requestScope()` and binds it to the freshly-minted connect-key via
  `rememberClaimIntent(key,{userId,teamId})` (`gateway/tokens.ts`, in-memory map
  alongside `deviceOwners`/`claimResults`; 24h TTL). It **fails safe in the admin
  "All teams" view** — returns `{error}` rather than minting a key that would fall
  back to the personal team (`ComposeModal` surfaces it). `createLoop`
  (`gateway/index.ts`) resolves `loop.teamId` from `readClaimIntent(body.claim)`:
  no intent ⇒ fall back to the machine's home team (back-compat); when the intent
  team **differs** from the home team it's a CROSS-TEAM create, gated **fail-closed**
  (never silently mis-file — that was the original bug): `machine.userId ===
  intent.userId` (bind claim to its minter) **AND** re-validate authorization now —
  `store.isTeamMember(team,userId)` OR superadmin on an existing team (mirrors
  `requestScope`). The team value is server-minted, never client input. The "intent
  team === home team" short-circuit means **open mode** (single `team-shared`, no
  member rows) skips the checks and is unaffected. Superadmin re-check uses the
  standalone pure `src/superadmin.ts` (`isSuperAdmin`, re-exported by `auth.ts`) so
  the framework-agnostic gateway never imports the Better-Auth-init module;
  `store.userEmail(userId)` looks up the email. **Machine is membership-scoped, not
  single-team:** `store.listMachinesForTeam(teamId)` (owner↔team_members join) makes
  one machine visible in every team its owner belongs to; `machineFns` listing + web
  `createJob` machine pick/validation use it (a machine is usable if its owner is the
  current user or a member of the active team). `machine.teamId` is RETAINED as the
  home/default team (no-claim fallback); on self-register (`poll`) a machine's home
  team is ALWAYS the owner's personal team - NOT seeded from the connect-key intent.
  Keeping home = personal team means the fallback can never be a shared team the
  owner is merely a (possibly later-revoked) member of; a loop's actual team comes
  from the validated claim intent at `createLoop` time, never from this home team. The daemon is
  **unchanged** — the per-team key already travels as `claim` in `loopany new`, and
  `loopany up` keeps the single stored device token. **Phase-3 follow-ups (NOT
  built):** a durable `connect_keys` table (Option C) replacing the in-memory intent
  map so a snippet pasted after a server restart still files correctly; and the
  team-member **invitation UI** — without it only superadmins can be multi-team, so
  this path is admin-only in practice today.

## Commands

- `pnpm dev` — server on :3000 (UI + scheduler + machine routes).
- `pnpm -r typecheck` · `pnpm --filter @loopany/server test`.
- `pnpm --filter @loopany/server db:generate` / `db:migrate`.
- `bash scripts/demo-cookie-unified.sh` — Cookie loop e2e through the unified server.

## Verified e2e

The **Cookie Daily Breakfast Report** loop runs end-to-end: scheduler → daemon poll → claude →
`loopany report` → run `done` (real breakfast report). Dashboard renders real data
(browser-verified, Geist style). 5 server tests green; both packages typecheck.
