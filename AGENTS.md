# CLAUDE.md

Guidance for Claude Code working in this repo.

**LoopAny** — multi-user scheduled **agent loops**. The server (TanStack Start)
schedules/stores/authenticates/notifies; execution is **BYOA** — claude-code runs
on each user's own machine via the `@crewlet/loopany` daemon. The server runs **no
LLM and executes no user code**.

> Architecture and the key design decisions (with the deviation/lessons log) are
> captured in this file — see **Key facts / gotchas** below. Run instructions:
> `README.md`.

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
- Machine transport is **HTTP short-poll** (not WS).
- **Failure visibility / alerting (`gateway/notify.ts` + `gateway/index.ts`).** Notifications
  fire on **failure**, not only success — silent failure is the BYOA default failure mode
  (the daemon lives on a laptop that sleeps/disconnects). Two server-side paths, both reusing
  the existing per-channel `dispatchNotification` (no new provider): (1) `report()` — when a
  run finalizes `!ok`, alerts via `notifyRunFailure(loopId, role, reason)`; (2) `sweep()` —
  when a stale pending/running run is reclaimed (`machine offline` / `run never claimed` /
  `machine timed out / disconnected`), same call. **Anti-spam is derived from persisted run
  rows, NOT an in-memory counter** (deploy-safe): `store.execFailureStreak(loopId)` counts
  consecutive trailing `error` **exec** runs (newest-first, stop at first non-error; evolve/
  edit/canceled/open ignored); `shouldNotifyFailure(notify, streak)` notifies on streak `1`
  (the success→failure transition) and then every `FAILURE_NOTIFY_EVERY` (=5) — so a loop that
  fails every tick pushes at 1, 5, 10…, not every run; a success between failures resets the
  streak so the next failure re-alerts. `notify:"never"` suppresses failure alerts too.
  **Role gating:** only `exec` failures notify — evolve/edit are internal (config change /
  self-shaping) and never produce user-facing noise, success OR failure (mirrors the success
  path's existing exclusion). `failureMessage(reason)` maps machine-availability reasons
  (offline/disconnect/never-claimed) to a distinct "reconnect your machine" phrasing. The
  gateway takes an **injectable notifier** (3rd ctor arg, defaulting to `dispatchNotification`,
  mirroring the injectable `blobStore`) so tests observe pushes without network. Zero-exec
  invariant holds: the server only reads its own run rows to decide. No UI change needed — runs
  already persist `phase:"error"` + `error`, which `JobDetailView`/run lists already render.
- **The loopany agent skill (`packages/server/src/skill/`).** The loop-builder
  knowledge is a real, installable agent skill — NOT one inline doc. Single source of
  truth: `packages/server/src/skill/{SKILL.md,references/{create,update,evolve}.md}`.
  `SKILL.md` is the **overview** (frontmatter `name: loopany` + a strong `description`
  so Claude auto-triggers it) that routes to the three references: `create.md` (up →
  task file → config → `new`), `update.md` (`loopany edit` envelope vs. task file), and
  `evolve.md` (task-file-as-running-memory model). **`/api/skill` serves the overview**
  (`routes/api.skill.ts`, Vite `?raw`) — the bootstrap an agent follows on first capture;
  **`/api/skill/references/<file>`** (`routes/api.skill.references.$.ts`, static map,
  path-safe — only the 3 exact names resolve) serves the references over HTTP as a
  **fallback** when the local install was skipped. Do NOT fork the content; edit the four
  files. The skill is **bundled into the `@crewlet/loopany` npm package**: `package.json`
  `files` lists `skill`, generated from the server's `src/skill/` by
  `packages/daemon/scripts/sync-skill.mjs` on `build`/`prepublishOnly` (so it never
  drifts); `packages/daemon/skill/` is **gitignored** (generated, like `routeTree.gen.ts`).
- **Loopany skill auto-install (`loopany new` → `npx skills`, into the loop workdir).**
  The install fires at **loop creation**, NOT `loopany up` (corrected in 0.4.0 — `up`
  may run from anywhere just to start the daemon, so it must not drop a skill into an
  arbitrary cwd; `src/ensure.ts` no longer touches skills and the old
  `--no-skill`/`--skill-global` flags are gone). After `loopany new` confirms the gateway
  create succeeded, the daemon **best-effort installs the bundled skill** into that loop's
  resolved **workdir** (`<workdir>/.claude/skills/loopany/`) via the `skills` CLI
  (vercel-labs/skills) — `packages/daemon/src/skill-install.ts`, exact verified invocation
  `npx --yes skills add <bundled-dir> -a claude-code -y --copy` run with the child `cwd`
  set to the workdir (so a project-level install lands there, not in `process.cwd()`;
  `installSkill({cwd})`). `src/create.ts` `resolveLoopWorkdir(config.workdir, loopId)`
  mirrors the daemon's own resolution (explicit `workdir` tilde-expanded+absolute, else
  `~/.loopany/work/<loopId>` scratch — never cwd). project scope is the `skills` CLI
  default; `-y` non-interactive + idempotent-overwrite; `--copy` self-contained, no symlink
  into the package's temp dir; LOCAL path source ⇒ end users never need the private
  platform repo. It is **announced** (one status line) and **never blocks** loop creation —
  it runs only after a confirmed create, and any failure (no network/npx, no write perm,
  bundled skill absent) degrades silently to the always-working `/api/skill` path.
  `installSkill()` takes an injectable `Runner` (carrying `cwd`) and `runCreate` takes
  injectable fetch/installer seams, so tests need no network/npx (`skill-install.test.ts`,
  `create.test.ts`). **Web-created loops** (New-loop dialog, no local `loopany new`) are
  intentionally NOT covered (deferred lazy-at-run-time idea). Thin verb `loopany skill
  {status,install}` (`skill-cli.ts`, `-g`/`--global`) is the **manual escape hatch** —
  install into cwd, or `-g` for `~/.claude`.
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
  `gateway.readBlob`, decode text; binary/oversize → download marker) → the unified
  `LoopFilesPanel.tsx` in `LoopDetailView` (the loop page; see the Unified Files panel
  bullet below). Binary downloads stream from the
  session-authed, path-safe route `routes/api.artifact.$loopId.$.ts` (splat path;
  team-scoped via the shared `auth.loopInScope` predicate that `ownedLoop` also uses).
  **Phase 3:** `run_snapshots` table (migration `0012`, manifest = path→{hash,size,
  binary,oversize}); the gateway `report()` writes a snapshot from `artifact_files` at
  finalize (`store.buildLoopManifest`); `getRunDiff({runId})` lazily diffs run N vs the
  prior run (`store.prevRunSnapshot`) — unified text diff via the pure-string `diff`
  (jsdiff) lib in `server/runDiff.ts`, size-delta marker for binary/oversize — rendered
  in `RunDetailView`'s "Changes (N)" section. The daemon flushes a final run-tagged sync
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
  carries it. UI: the New-loop dialog (`ComposeModal`) has **no agent selector** — the
  upfront picker + its `agent:` snippet line were removed because the daemon's
  `resolveAgent` already measures the real host (env fingerprint > declared > default),
  making a dialog declaration a rarely-hit fallback that could only go stale. The snippet
  no longer emits `agent:`; `SKILL.md` tells the agent to self-declare via `--agent`. The
  recorded agent is now driven purely by daemon self-detection, and the "Loop created"
  confirmation shows the **measured** `loops.agent` (threaded back via `ClaimResult.agent`
  → `claimStatus`), never a pre-selected value. **The paste snippet is one line** —
  `Fetch <origin>/api/skill and help me build a loop.` — plus the read-only config
  (`server-url`/`connect-key`/optional `loopany-cli`). The old pre-filled task + schedule
  inputs (`EditableChip`s baked into a multi-clause "build a loop for the thing you did
  above … each time" instruction) were removed: ALL loop-building intelligence lives in the
  skill (it asks for task, cadence, and per-run output format and handles the empty-context
  case), so the snippet is a dumb bootstrap with nothing to mis-prefill. The claim/
  connect-key binding stays so a created loop still resolves back to the dialog. Execution-path copy that
  truly means Claude (run-now, edit-via-Claude-Code in `LoopDetailView`) stays "Claude"
  on purpose — that IS what runs. Daemon now has vitest (`create.test.ts`) for the
  detector/precedence; server tests cover createLoop persistence + adapter mapping.
- **CI/CD (`.github/workflows/`).** Two GitHub Actions workflows, deliberately split by
  trigger/cadence/blast-radius (they share nothing but the repo). **`deploy.yml`** — server
  → Fly (`loopany-testing`): fires on **push to `main`** (with `paths-ignore` for
  `packages/daemon/**`, `**/*.md`) **plus `workflow_dispatch`**; a `fly-deploy`
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
  `publish-daemon.yml`, no environment). The publish step has **no `NODE_AUTH_TOKEN`**,
  and the `setup-node` step **deliberately omits `registry-url`**: `registry-url` makes
  `setup-node` write an `.npmrc` (via `NPM_CONFIG_USERCONFIG`) carrying
  `_authToken=${NODE_AUTH_TOKEN}` AND export `NODE_AUTH_TOKEN` as a dummy value when none is
  given, so `npm publish` then authenticates with that dummy/empty token **instead of OIDC**
  and 404s ("no permission" - the actual `v0.3.1` failure). Without `registry-url` no
  token-based `.npmrc` is written, so npm falls back to the default registry
  (`registry.npmjs.org`) and the OIDC path; the public registry + access come from
  `packages/daemon/package.json` `publishConfig.access: public` and the
  `npm publish --access public` flag. Trusted publishing
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
- **Loop detail is a PAGE, not a modal (`/loops/$loopId`).** The old dashboard
  modal (`JobDetailView` + `RunView` inside `Modal`) was retired for dedicated
  routes. `routes/loops.$loopId.tsx` → `components/LoopDetailView.tsx` (the loop
  page body: a header card with name/cron/next/agent/machine-status/id + the action
  toolbar [Run once / Edit / ··· menu], an optional agent-authored `LoopView`
  dashboard, then a 2-col grid of the **unified Files panel** and the **Runs**
  section). The dashboard (`routes/index.tsx`) + `LoopCard` now **navigate**
  (`useNavigate`) instead of `setView` — no more `Modal` for detail. The page owns
  its own `getJobDetail` fetch + self-poll (3s while a run is live, else 8s; ssr:false
  so the session cookie rides along), same cadence as the old modal. The edit paths
  (hand-to-Claude-Code via `requestEdit`; manual `LoopForm` fallback) survive as
  in-page mode takeovers. Reconnect opens `MachinesModal` rendered on the page itself.
  **`loops.agent` is surfaced as a quiet chip** beside the title status pills (not the
  meta row). **Edit modes use a bare-page `EditHead`, NEVER `ModalHead`:** `ModalHead`
  renders Base UI `Dialog.Title`/`Dialog.Close`, which call `useDialogRootContext()`
  and throw (`Cannot destructure property 'store' of 'useDialogRootContext(...)'`)
  with no `Dialog.Root` ancestor — the original modal flow wrapped them in `<Modal>`,
  the page does not, so any `Dialog.*` part rendered directly on the page crashes the
  view on first click (`loopDetailEdit.regression.test.ts` guards this). **Layout: the
  content viewer is the star** — the main grid is `lg:grid-cols-[minmax(0,1fr)_minmax(
  300px,360px)]` (files panel bulk, runs a capped rail) inside a `max-w-[1360px]` shell
  (run page `max-w-[1040px]`). The hard rule against page-level horizontal scroll:
  `min-w-0` on every grid/flex child + contain wide content in its own pane — the
  agent-authored dashboard (`LoopView`) is wrapped in `overflow-x-auto` (a too-wide
  card row scrolls inside the dashboard box, a responsive auto-fit grid wraps), and
  `.taskmd table` is a `display:block; width:max-content; max-width:100%; overflow-x:
  auto` block so a wide markdown table scrolls inside the viewer, never widening the
  page / shoving the runs rail off-screen.
- **Unified Files panel (`components/LoopFilesPanel.tsx`).** Merges the former
  separate task-file box + `FilesView` (both DELETED) into ONE master-detail: a file
  list (task file pinned first with a `TASK` chip, then synced artifacts path-sorted)
  drives a content viewer; the **task file is selected by default**. Reuses the Phase
  2 server fns — `getArtifacts` (self-polls by loopId) for the list, `getArtifact`
  for text bodies; markdown (task file + `*.md`) renders via `TaskFileView` (now takes
  a `bare` prop = no own inset/scroll, host owns the surface), other text in a mono
  `<pre>`, binary/oversize → the existing `/api/artifact/$loopId/$` download route.
  **The task file IS the loop folder's README, so it appears EXACTLY ONCE** — the
  list/dedup logic is the framework-free `lib/fileEntries.ts` (`buildFileEntries` +
  `isTaskPath` + `isTaskEntry`, unit-tested in `fileEntries.test.ts`). Once the README
  has synced it arrives as a normal artifact, so we **badge that artifact row as the
  task** (default-selected, `TASK` chip) and drop the duplicate; only before the first
  sync (no matching artifact) do we emit a single SYNTHETIC task entry from the loop
  record. The match is robust — `job.taskFile` is usually an ABSOLUTE machine path
  while the artifact path is loop-relative, so `isTaskPath` compares on a normalized
  path (equal / whole-segment suffix / basename), NOT the old brittle `f.path ===
  taskFile` that silently failed and rendered the README twice. The task row always
  renders its body from the loop record's `taskFileContent` (authoritative, always
  present), not the artifact blob fetch — robust to a missing/cold blob.
- **Run detail is its own route (`/loops/$loopId/runs/$runId`).** `RunView.tsx` now
  exports **`RunDetailView`** (page-oriented; the old modal `RunView` is gone). The
  route file is `loops.$loopId_.runs.$runId.tsx` — the trailing `_` on the `$loopId`
  segment **un-nests** it from the loop page (standalone full page, deep-linkable +
  browser-back, not nested in an `<Outlet/>`). It resolves the run from
  `getJobDetail(loopId).runs` (the latest ~100); a run older than that window is
  located by paging backward with the existing `loadOlderRuns` cursor fn (bounded
  by `MAX_OLDER_PAGES`) so a run clickable in the `Timeline` strip never dead-ends
  — still NO new backend. Only if the backward walk is exhausted does it show the
  calm "no longer available" fallback. It self-polls while running (a SILENT poll,
  separate from the err-setting initial load, so a transient blip can't brick the
  page), refetches the `getTranscript` trace when the run settles (keyed on
  `run.running`), and renders the Phase-3 `getRunDiff` "Changes". Run rows in the
  loop page's Runs list + the `Timeline` strip `onPickRun` both `<Link>`/navigate
  here.

## Commands

- `pnpm dev` — server on :3000 (UI + scheduler + machine routes).
- `pnpm -r typecheck` · `pnpm --filter @loopany/server test`.
- `pnpm --filter @loopany/server db:generate` / `db:migrate`.
- `bash scripts/demo-cookie-unified.sh` — Cookie loop e2e through the unified server.

## Verified e2e

The **Cookie Daily Breakfast Report** loop runs end-to-end: scheduler → daemon poll → claude →
`loopany report` → run `done` (real breakfast report). Dashboard renders real data
(browser-verified, Geist style). 64 server tests + 28 daemon tests green; both packages typecheck.
