# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Loopany** - multi-user scheduled **agent loops**. The server (TanStack Start)
schedules/stores/authenticates/notifies; execution is **BYOA** - claude-code runs on
each user's own machine via the `@crewlet/loopany` daemon. **Zero-exec invariant:
the server runs no LLM and executes no user code** - it only stores/reads bytes and
computes pure functions. Run instructions: `README.md`.

## Layout (pnpm monorepo)

- `packages/server` (`@loopany/server`) - TanStack Start UI + server fns +
  in-process Scheduler (croner) + machine routes + Better Auth + push notifications.
  Drizzle/SQLite.
  - `src/scheduler/` - cron engine (tick -> pending run -> Dispatcher).
  - `src/gateway/` - machine gateway (poll/agent-api/report/sync/blob), run tokens,
    delivery, prompt, notify, blobstore (R2/in-memory), artifacts, retention/GC.
  - `src/db/` - Drizzle schema (machines/loops/runs/blobs/artifact_files/run_snapshots)
    + store + auth-schema.
  - `src/server/` - boot (`ensureServer`), adapters (Loop/Run -> JobSummary/JobDetail),
    loopApi server fns.
  - `src/skill/` - ALL prompt/skill prose (see "The skill" below).
  - `src/routes/` - pages + server-only route files.
- `packages/daemon` (`@crewlet/loopany`) - one binary, two roles: poll-loop daemon
  and the in-run `loopany` callback; spawns claude.

## Commands

- `pnpm dev` - server on :3000 (UI + scheduler + machine routes).
- `pnpm -r typecheck` - both packages (server typecheck runs `tsr generate` first,
  so a fresh checkout typechecks with no prior build).
- `pnpm --filter @loopany/server test` / `pnpm --filter @crewlet/loopany test` -
  vitest; single file: append the path; single test: `vitest run -t "<name>"`.
- `pnpm --filter @loopany/server db:generate` / `db:migrate` - Drizzle migrations.
- `bash scripts/demo-cookie-unified.sh` - e2e demo loop through the unified server.
- Prod: nitro build, then `pnpm start` = `drizzle-kit migrate` +
  `node .output/server/index.mjs` (every deploy applies pending migrations).

## Core model

- Scheduler tick creates a pending run; the bound machine's **HTTP short-poll**
  (~3s, not WS) claims it; the daemon spawns claude; the agent talks back via
  run-token verbs (`loopany report/show/set-*/reschedule/finish`, `/agent-api/loop`);
  the final `report()` persists transcript/metrics/artifacts and retires the run lease.
- Run roles: `exec` (scheduled run), `evolve` (self-improvement pass), `edit`
  (owner-requested change). Only exec runs produce user-facing notifications,
  success or failure.
- **Open vs closed loops**: closed-ness derives from `loops.goal != null` (no kind
  column). A closed loop's exec run gets `canFinish` and may call `loopany finish`
  when the goal is met, stamping `completedAt`/`completionReason` + `enabled=false`.
  The invariant `completedAt != null implies goal != null` is enforced at the single
  write chokepoint `store.updateLoop`, which also runs lifecycle side effects for
  every caller: `goal:null` clears completion stamps; `enabled:true` on a completed
  loop is a reopen; `enabled:false` is a plain pause.
- A loop's standing brief lives ONLY in its task file's `## Spec` (there is no
  `task` column). The exec run's instructions live ENTIRELY in the first user turn
  (`buildExecTask` ← `skill/run/exec-core.md`): the self-sufficient CORE (identity +
  untrusted-data guard + the non-negotiable fallback core - read task file first, do
  the work / surface only what changed, end with exactly ONE `loopany report`/`finish`,
  `{{stateLine}}` report grammar, one pass then stop + per-run trigger + a pointer to
  the installable loopany skill for the deep protocol). `buildLoopSystemPrompt` returns
  `""`; on an OLD daemon `--append-system-prompt-file` then points at an empty file (a
  harmless no-op, so batches 1-2 shipped server-first with no daemon change), and the
  current daemon skips the flag entirely when the delivered `systemPrompt` is empty (the
  batch-5 `runner.ts` note under "Daemon gotchas"). A closed loop's goal is prompt-injected
  as `Goal (finish line): <goal>` (an own-line fill, `{{goalLine}}`). The old standing
  system prompt `skill/run/exec-loop.md` is retained as the source for the later
  skill-side `references/run.md` batch but is no longer imported or delivered.
- The EVOLVE and EDIT runs follow the SAME first-user-turn model (Batch 2):
  `buildEvolvePrompt`/`buildEditPrompt` both return `""` (empty system prompt, same
  harmless-no-op rationale as exec), and the standing prose ships in the user turn -
  `buildEvolveTask` concatenates `references/evolve.md` ahead of its payload,
  `buildEditTask` concatenates the short `run/edit.md` CORE ahead of its payload. The
  untrusted-data guard rides along in that prose (evolve reads run messages; edit reads
  the loop's current config - both untrusted). `buildEvolveTask` no longer dumps up to
  12 runs as pretty-printed JSON; it emits a COMPACT one-line-per-run survey
  (`renderRecentRuns`: ts / role / outcome-status / cost as `$x.xx` / state KEYS only,
  not values / FULL session id so the `find … <session>.jsonl` deep-dive resolves /
  message collapsed + clipped to ~100 chars), headed by on-demand pointers
  (`loopany log [--transcript]`, now reachable in-run, + the local session JSONL).
  `buildEditTask` KEEPS its inlined current ui/workflow/schema - that is current CONFIG,
  not history, and is useful for a surgical edit.
- `allowControl` defaults TRUE; `false` means the owner pins the schedule. A run's
  self-schedule surface is only `reschedule` + `set-cron`, with cadence floors
  (`LOOPANY_SELF_CRON_FLOOR_MINUTES`, `LOOPANY_SELF_RESCHEDULE_FLOOR_MINUTES`)
  applying to the run path ONLY - owner `loopany edit` is unlimited.

## The skill (`packages/server/src/skill/`)

- ALL prompt prose lives here, split by audience:
  1. `bootstrap.md` - first-contact onboarding, served at `/api/bootstrap`; never
     bundled or installed.
  2. `SKILL.md` + `references/{create,update,evolve,run}.md` - the PUBLIC installable
     skill, bundled into the daemon npm package and auto-installed at USER scope for
     EVERY coding agent loopany knows about (`SKILL_TARGET_AGENTS` in
     `daemon/src/skill-install.ts` - Claude Code `~/.claude/skills/loopany` + Codex
     `~/.agents/skills/loopany` today), via `npx skills add ... -a claude-code -a codex -g`
     (repeated `-a` flags per agent; the comma form `-a a,b` is an invalid single
     name, and `-a '*'` is deliberately avoided since it litters all ~72 supported
     agents regardless of presence) on `loopany up`/`new`; best-effort, never blocks.
     `installArgs` + `loopany skill status` both derive from `SKILL_TARGET_AGENTS`, so
     adding an agent is a one-line list edit.
  3. `skill/run/{exec-core,edit}.md` - INTERNAL run prompts, imported `?raw` by
     `gateway/prompt.ts`; never served, never bundled. `exec-core.md` is the exec
     run's full first-user-turn CORE (folds the former `exec-trigger.md`, deleted);
     the former standing prompt `exec-loop.md` still sits in `skill/run/` (Batch-3
     source for `references/run.md`) but is imported by nothing. `run/edit.md`
     stays SEPARATE from `references/update.md` on purpose: the edit RUN uses
     run-token verbs on the current loop (`loopany set-cron`/`set-ui` ..., no id)
     and must be self-contained (skill install is best-effort), while update.md is
     the OWNER authoring CLI (`loopany edit <id> --json`) - a merge would ship
     run-token instructions in the public bundle.
- `references/evolve.md` doubles as the evolve RUN prompt (same `?raw` import), so
  skill and run-dispatch cannot drift. `references/run.md` is the PUBLIC runtime
  protocol (dual-audience: in-run enrichment + owner docs) - the depth extracted
  from `run/exec-loop.md` §1-§4 (task-file discipline, report/finish grammar + finish
  bar, schedule levers, front-matter conventions); the server-injected exec CORE stays
  authoritative and self-sufficient, so run.md is enrichment, never a dependency.
- **HARD GUARDRAIL**: `packages/daemon/scripts/sync-skill.mjs` is a SELECTIVE
  whitelist copy (exactly `SKILL.md` + the 4 references). Never make it recursive -
  that would ship the internal run prompts and `bootstrap.md` into the public npm
  tarball. Guarded by `sync-skill.test.ts`. Edit the source files; never fork
  the content. `packages/daemon/skill/` is generated + gitignored.
- References are also served at `/api/skill/references/<file>` (static map, only
  the 4 exact names resolve; in dev vite's static layer 404s the `.md` path - the
  handler works in prod, covered by unit test).
- Skill/prompt markdown compiles INTO the server bundle via `?raw` imports, so a
  prompt-only `.md` edit MUST deploy (`deploy.yml` paths-ignore lists explicit doc
  paths, deliberately not a wholesale `**/*.md`).

## Template market (`packages/server/src/skill/templates/`)

- A template is a **canned loop INTENT, not a flow** - metadata only. There is NO
  template serving endpoint and NO per-template doc: all loop-building intelligence
  stays in `bootstrap.md` + `references/create.md` (propose-then-confirm cadence,
  config, dashboard authoring). The template just seeds the natural-language intent.
- Each template is a **folder** under `skill/templates/<name>/` with a single static
  `meta.json` (the `TemplateInfo`: `name`, `label`, `desc` = one-line card blurb,
  `description` = the canned task text appended to the snippet). Zero-exec, file-based.
- **Adding a template is pure content addition - no code change.** The registry
  (`server/templates.ts`) builds `TEMPLATES` from an `import.meta.glob` over `meta.json`;
  `listTemplates` returns it. Drop a new folder; the registry test (a non-empty
  `desc`/`description` per entry) covers it automatically.
- **Dashboard entry**: the template cards render directly beside "New Loop"
  (`routes/index.tsx`, `templates.map`). One click opens `ComposeModal` with that
  `template` - it skips the host chooser, goes straight to the snippet, and appends the
  template's `description` under the config lines. `ComposeModal` handles BOTH blank
  loops (`template = null`, the two-step rail) and templates (`template` set) - there is
  no separate modal. Snippet form:
  `Fetch <origin>/api/bootstrap and help me build a loop.` + `server-url`/`connect-key` +
  a blank line + the `description`. Same connect-key machinery as a blank loop
  (`mintClaim`/`getConfig`/`claimStatus`).
- **PUBLIC but NOT bundled.** `meta.json` rides to the client via `listTemplates`, and
  `sync-skill.mjs`'s whitelist stays selective (`skill/templates/` never ships in the
  daemon npm tarball; guarded by `sync-skill.test.ts`).
- Seven templates ship today, each `description` a short English paragraph at the same
  granularity (intent + defining disciplines, no tool flags, no machinery the create
  flow already handles). Keep them tight. English only. `templates.test.ts` pins the
  full name list AND asserts each template's defining behaviors stay in its
  description. The v1 three:
  - **React Doctor** (open): daily ~6am `npx react-doctor@latest`, fix the single worst
    issue in a fresh worktree off `main` (never dirty the checkout), PR via gh,
    no-stacking while a prior PR is unmerged (still refresh status + score), one
    `type: open|merged` markdown card per PR for the kanban, daily health score, and a
    **day-one dashboard set up at creation** (kanban + score chart, via the create-`ui`
    support - see "Server gotchas"). No react-doctor flags beyond the npx one-liner.
  - **Market Research** (open): infer the project's product/space, propose a research
    focus and confirm before creating; every morning ~5am research the day's market
    developments; exactly ONE dated report per day with `type: report` front matter so
    reports ride the calendar; dashboard at create = calendar + newest-report embed;
    sharpen the focus over time.
  - **Follow-up Tracker** (closed): paste right after shipping something - the session
    context IS the invocation (no extra discovery machinery; skill-side template
    fetching is deliberately deferred). Verify a CONCRETE observation path exists
    (logs/MCP/URL/gh) and smoke-test it once - never create a blind loop; define a
    concrete finish condition and create the loop CLOSED with it as the goal; confirm
    cadence; finish only when genuinely met, report regressions plainly; modest
    dashboard at create (latest-report embed + metric chart when one was defined).
  The four added later (adapted from top-scoring public loop cases), same disciplines
  at the same granularity:
  - **Docs Sweep** (open): weekly Monday ~6am, compare docs against what the code
    ships now, scoped to drift since the previous sweep; verify commands/links/examples
    by actually running them; never rewrite accurate docs to create activity (zero
    drift = clean stop); worktree + PR + no-stacking; drift count as metric; dashboard
    = latest-summary embed + drift chart.
  - **Housekeeper** (open): daily ~7am, ONE proven low-risk cleanup per day
    (prove-before-delete with concrete evidence, keep only if checks stay green);
    protect active/uncommitted/generated/uncertain work; uncertain candidates go to a
    deferred-candidates file, never deleted; worktree + PR + no-stacking; `type:
    open|merged` kanban cards + cleanups-landed metric.
  - **Dependency Triage** (open): weekly Monday; smoke-test gh sees the repo's
    Dependabot/Renovate PRs BEFORE creating, and confirm merge authority with the
    owner (merge low-risk patch/minor vs review-and-report-only); snapshot open PRs,
    process each exactly once on real evidence at the exact head (version labels are
    inputs, not proof of safety), tests in a worktree; `type:
    merged|deferred|blocked` kanban cards + open-PR-count metric.
  - **Error Sweep** (open monitor): daily ~6am production reliability pass; carries
    the Follow-up Tracker observation-path discipline (verify + smoke-test an error
    source, propose source/window and confirm, never a blind loop); separate
    actionable errors from noise, root-cause, smallest verified fix, one PR per fix,
    no-stacking; NEVER copy credentials/tokens/PII into reports or PRs; one dated
    `type: report` per run + actionable-error-count metric; nothing actionable = clean
    stop.

## Workflows (deterministic pre-stage)

- A loop's workflow is an **async function body, NOT an ES module**: top-level
  `await` + `return {message?, state?}` are legal; top-level `export`/`import` is a
  parse error (the daemon wraps the body in an async arrow inside a generated ESM
  file run by bare node). Enforced at write time by `validateWorkflow` (AsyncFunction
  constructor compile-only check) on all three write paths: createLoop, editLoop,
  and run-token `set-workflow`. No dialect tolerance (never strip `export`).
- `await tools.call("server.tool", args)` calls the machine's own MCP servers via
  mcporter (headless, `disableOAuth: true` - never launches a browser flow). The
  bridge `packages/daemon/src/mcp-bridge.mjs` is plain ESM on purpose (the workflow
  subprocess runs bare node, dev and prod); `scripts/copy-runtime-assets.mjs` ships
  it to `dist/`. Caps + timeout via `LOOPANY_WORKFLOW_TOOL_*` env.
- A failed workflow does NOT fail the run: `runner.ts` falls back to the agent with
  the original task + failure context. A `/SyntaxError/` failure is a user-fix case
  (exec runs have no `set-workflow`) - the agent writes `workflow-setup-<date>.md`
  and surfaces a one-line owner prompt. The workflow cursor never advances on failure.

## Artifacts / storage

- The daemon watcher (chokidar) syncs each loop's folder: full sha256 manifest
  (deletions = absence) -> `POST /api/machine/sync` (device token, not run token) ->
  server replies `needHashes` -> `PUT /api/machine/blob/:hash` (server verifies the
  hash). The manifest is always FULL but hashing is INCREMENTAL (`watcher.ts`
  `buildManifest`): a stat cache (size+mtime+ctime, git-index-style racy-write
  guard) means unchanged files are never re-read; bytes are re-read + re-verified
  only when the server wants them (never buffered per-flush); PUTs run
  4-concurrent; a rebuild whose digest matches the last acked sync skips the
  network entirely. Inline blobs (≤64KB each) are budgeted 1MB aggregate per POST
  (a burst must never 413 the server's 32MB `SYNC_BODY_CAP`; overflow takes the
  PUT path), and the FIRST flush after watcher start inlines nothing
  (post-restart the server already has almost everything). Bytes live in R2
  (`LOOPANY_R2_*`; in-memory store when unset - the test/dev
  default), metadata in `blobs`/`artifact_files`. The ignore list (`.git`,
  `node_modules`, `.env*`, key files, ...) is enforced on BOTH daemon and server.
  Per-file cap 10MB (larger = metadata-only `oversize`).
- `run_snapshots` capture the manifest at `report()`; `getRunDiff` diffs run N vs
  the prior snapshot (jsdiff) for the run page's "Changes".
- **Front-matter convention** (migration `0018`, `blobs.meta`): markdown products
  MAY open with a fenced `---` block of flat `key: value` scalars; the indexed
  subset `{type?, title?, date?}` is parsed once at byte ingress (both `sync()`
  inline and `putBlob`; `server/frontmatter.ts` - pure, bounded, never throws) and
  stored on the blob row (dedup reuses the first parse; old blobs stay `meta` null,
  no backfill). A SOFT convention (prompt + UI incentive, never a sync/storage
  gate). Front-matter `date:` is the AUTHORITATIVE product date
  (`lib/productDate.ts`); filename date is the fallback, sync time last. UI:
  `LoopFilesPanel` type/title chips (task file exempt, keeps its TASK treatment).
- Retention/GC (`gateway/retention.ts`, periodic `maintainStorage` with an in-flight
  latch): snapshot pruning (keep 20) unpins old blobs; blob GC computes a live
  keep-set, honors a 1h grace window, re-checks referencedness per candidate, and
  deletes bytes BEFORE metadata (never leaves a live `blobs` row pointing at deleted
  bytes). Bias: when in doubt KEEP (a leaked blob is a cost bug; a wrong delete is
  data loss). Per-loop 500MB cap enforced at `sync()` AND authoritatively at
  `putBlob` (real byte length; also handshake-gated - only accepts hashes the sync
  asked THIS machine for, so a device token is not an uncapped write channel).
  `store.deleteLoop` cascades runs/artifact_files/run_snapshots.

## Security / hardening invariants

- Wire boundary: `gateway/http.ts` `readJsonBody` caps machine-route bodies at 2MB
  (413). Per-field caps (`WIRE_TEXT_CAP` 512KB, `MESSAGE_CAP` 2000, ...) are
  row-bloat budgets, not the security boundary.
- The device token fully impersonates the machine; it is serialized OWNER-ONLY
  (`tokenVisibleTo`) - teammates/admins get `token: null`. `loopLog` (`loopany log`
  backend) is scoped to loops bound to that machine; cross-scope = flat 404.
- **Unified CLI dispatch `POST /api/machine/cli`** (`gateway.cli(token, argv)`) is a
  ROUTER in front of the existing gateway logic, keying authority on CREDENTIAL TYPE
  first: a `dk_`-prefixed **device** token → owner verbs (`new`→createLoop,
  `loops`→listLoops, `edit`→editLoop, `log`→loopLog, `show`→describe; `report`/`finish`
  are run-only → 403); a **run** credential (an `rk_`-prefixed run lease, or a
  pre-Batch-6 bare UUID over a deploy) → the per-run `dispatch()` verbs PLUS a read
  branch (`log`/`show`) scoped to the lease's OWN loop (this closes the historical
  in-run `loopany log` 400 seam; batch 4 also wired a `log` case into `dispatch`
  itself, so run-credential `log` now works on BOTH the unified `/api/machine/cli`
  and the legacy `/agent-api/loop` transports — keeping the in-run help that
  advertises `log` truthful everywhere). Run-credential rules: owner-only verbs
  (`new`/`edit`/`loops`/`status`) → 403; a `--loop`/positional loop id that is not the
  lease's loop → **403, never a silent retarget**; a terminal-grace (reclaimed) lease →
  409 (same reclaim grace as `agentApi`). Floors/`allowControl`/`canFinish`/the shared
  content validators all flow through unchanged because the run path reuses `dispatch`.
  The router branches on the `dk_` device prefix vs a run-lease lookup, NOT on an `rk_`
  prefix — so a bare-UUID run token still routes to the run path (see the run-lease
  gotcha above for the wire format + back-compat). `loopLog`'s scoping body is factored
  into a private `renderLoopLog(machineId, loopId, limit)` shared by both the device
  `loopLog` (derives machineId from the token) and the run `log` branch (uses
  `lease.machineId`+`lease.loopId`), so the flat-404 existence-never-leaks rule cannot
  drift between them. The legacy `/agent-api/loop`, `/api/machine/loop`, and
  `/api/machine/log` routes stay as thin aliases onto the same gateway methods (no
  behavior change for existing daemons); `/machine/report` is untouched (daemon
  finalize, not a user verb). Same 2MB `readJsonBody` cap as every machine route.
  Every `/api/machine/cli` verb now returns a **superset body**: its axi-shaped TOON in
  a `text` field (plus an `exitCode`) ALONGSIDE the existing structured JSON fields,
  never replacing them (the axi-conformance spine, batch 1 - `gateway/toon.ts`, detailed
  in `packages/server/AGENTS.md`). The 0.11 daemon ignores `text` and renders the
  structured fields, so this ships server-first with no daemon release; the in-run
  callback already prints `body.text`, so `renderLoopLog` gaining `text` is what finally
  makes in-run `loopany log` print (the F2 fix). `finalizeCli` wraps `cli()` to fill
  `text` from any structured `{error}` and ensure `exitCode` (idempotent + additive),
  and errors render as `error:`/`code:` TOON. Two behavior changes ride along: `report`
  and `finish` now reject an invalid `--status` with a 400 `VALIDATION_ERROR` instead of
  silently dropping it (F5), and a second `finish` on an already-finished loop pins
  `CONFLICT`. `describe()` (`show`) now emits the FULL editable envelope (batch 2):
  every `EDITABLE_LOOP_FIELDS` key keyed EXACTLY as `edit --json` accepts (`runAt` is
  the writable pinned override; the DB column stays `nextRunAt`) PLUS derived read-only
  aggregates (`nextFire`/`classification`/`runs`). `show --json` emits the envelope
  verbatim so dropping `id` roundtrips to a no-op `edit` patch (read/write identity,
  pinned by a roundtrip test); large `ui`/`workflow` show a `present, N bytes` hint
  unless `--full`. A run credential adds camelCase `selfSchedule`/`selfFinish` effective
  lines (these REPLACED the old kebab `self-schedule`/`self-finish` display keys). See
  `packages/server/AGENTS.md` for the durable notes.
- `auth.ts` THROWS at boot when the GitHub gate is on but `LOOPANY_AUTH_SECRET` is
  unset. Set the Fly secret before deploying with the gate on.
- Per-team connect-key: the claim carries the team (`rememberClaimIntent`, in-memory,
  24h TTL). A cross-team create is fail-closed: claim minter must be the machine
  owner AND membership is re-validated at `createLoop` time. A machine's home team
  is always the owner's personal team; a loop's team comes from the validated claim.
- Daemon jail: `LOOPANY_ROOTS` is an always-applied local jail (`roots.ts`) -
  server-sent roots can only NARROW it, paths are resolve-normalized before the
  prefix check. Child env is allowlisted everywhere (`spawn.ts`); the workflow
  subprocess gets extra keys only via `LOOPANY_WORKFLOW_ENV=KEY1,KEY2`. All daemon
  fetches go through `boundedFetch`; kills take the whole process group.
- Exec timeout is OPT-IN (`LOOPANY_EXEC_TIMEOUT_MS`; default unlimited). The guard
  against a vanished machine is the SERVER's inactivity-based sweep: poll writes a
  freshness stamp into run progress; a run is reclaimed only after `RUN_TIMEOUT_MS`
  of silence. A canceled run's late `report()`
  is ignored BEFORE any loop-level write (never advances cursor/taskFileContent).
- **The run credential is a RUN LEASE (`tokens.ts`, Batch 6)**, not a mint→revoke
  token: the per-run caps (`runId/loopId/machineId/role/allowControl/canSet*/canFinish`
  — the old `RunSlot` fields, now `RunLeaseCaps`) PLUS a tiny state machine `state:
  "active" | "terminal-grace"` + `expiresAt`. Wire token is `rk_<random>` (device
  stays `dk_`); the unified `cli` router branches on the `dk_` prefix, so a run token
  (rk_ OR a pre-Batch-6 bare UUID) falls through to the run path. The lease table is
  keyed by the FULL wire token, so `resolveLease` needs NO prefix parsing — a
  bare-UUID token minted before the deploy resolves identically (free back-compat; a
  daemon release is NOT required for this batch — the daemon forwards whatever token
  its env carries, opaque to shape). `resolveLease` lazily drops a lease past
  `expiresAt` (active leases carry `Infinity`, so a live run never times out here — the
  server's inactivity sweep is the vanished-machine guard).
- **The old revoke/reclaim scatter collapses to ONE terminalize transition +
  retire + prune.** `registerRunLease` mints `active`. `terminalizeLease(runId)`
  flips `active` → `terminal-grace` with `expiresAt = now + TERMINAL_GRACE_MS` (24h,
  subsumes the former `RECLAIM_GRACE_MS`); it is called ONLY by `reclaimRun`
  (`gateway/index.ts`) when the sweep reclaims a stuck run as a false failure — so
  `terminal-grace` UNIQUELY marks a swept run (this is load-bearing: it lets the
  reconcile branch fire only for swept runs, never a normal failure report).
  `retireLease(token)` deletes the lease single-shot — called by every `report()`
  finalize consummation (normal final report, the enriching report after `finish`, the
  ONE reconciling wake-report, a canceled-run report). `pruneExpiredLeases(now)` in
  `sweep()` bounds memory. NB: `finish` deliberately does NOT terminalize — it leaves
  the lease ACTIVE for one enriching report, so the run may still `show` / a second
  `finish` → 400 (idempotency guard), and the enriching report retires it.
- **Sweep-reclaimed runs are NOT retired immediately** - the usual cause is a laptop
  that merely fell ASLEEP mid-run, and on wake the daemon delivers the real (often
  successful) result. `reclaimRun` TERMINALIZES the run's lease (grace) instead of
  retiring it, so `report()`'s `phase==="error" && lease.state==="terminal-grace"`
  branch honors exactly ONE late wake-report: a success flips the run back to `done`
  (clears the false error, records message/artifacts, retracts via the normal success
  push; the failure streak self-corrects since it's derived from persisted rows), a
  real failure replaces the generic reclaim reason (no second push). Single-shot
  (lease retired after). While terminal-grace, `agentApi`/`runCli` refuse mutations
  with 409 (only the final report reconciles). The daemon's `runner.ts` `report()`
  logs a clear line on a 401 (already retired) instead of silently dropping it. A
  pending run has no lease yet, so its reclaim (`machine offline`) is unchanged.
  Leases stay IN-MEMORY for v1 (owner-settled §10: a deploy during a long sleep drops
  the lease → a wake-report 401s even inside grace; accepted known gap, no DB table).
- **Machine presence is THREE-state** (`lib/machinePresence.ts`, shared by server
  `adapters.toJobDetail` + client `MachinesModal`): `online` (polled < 30s),
  `asleep` (seen < `MACHINE_ASLEEP_TTL_MS` = 6h — calm, "resumes automatically"),
  else `offline`. `JobDetail.machine` carries `{online, presence, lastSeen}`; `online`
  still gates run/evolve (a sleeping machine can't execute). The failure push copy
  (`notify.ts` `failureMessage`) is de-alarmed and names sleep as the likely cause,
  distinguishing an interrupted running run from a skipped scheduled one (no more
  "📵 appears offline"). Banner/string edits in `LoopDetailView`: entities in JS
  STRING literals are not decoded — write `&`, not `&amp;` (only JSX text decodes).
- Failure alerting: notifications fire on failure too (`report()` !ok + sweep
  reclaim). Anti-spam streak derives from persisted run rows (exact, deploy-safe):
  notify at streak 1, then every 5th; a success resets. Only exec failures notify;
  `notify:"never"` silences everything. The gateway takes an injectable notifier
  (like its injectable blobStore) so tests observe pushes without network.

## Server gotchas

- **One process owns the scheduler** (`ensureServer` globalThis guard). Never run
  the unified server AND `main.ts` against the same DB (double-fire).
- vite binds `127.0.0.1` (not IPv6 `localhost`) - see `vite.config.ts`.
- `src/routeTree.gen.ts` is generated + gitignored; `typecheck` runs `tsr generate`
  first. Run `routes:generate` standalone if you need the file otherwise.
- **Changed `db/schema.ts`? Migrate locally right away**: `db:generate` then
  `db:migrate`. Dev does NOT auto-migrate on `pnpm dev`; prod applies on `pnpm start`.
- Drizzle `text(col, { enum })` is TS-only (no DB CHECK) - enum value changes need
  no migration and cannot break rows.
- Server route files use `createFileRoute(path).server.handlers`; dynamic-import
  heavy/native deps INSIDE handlers to stay out of the client bundle.
- `editLoop` accepts the envelope fields plus content fields (workflow/ui/stateSchema)
  through the SAME `validate{Ui,Workflow,Schema}` helpers the run-token `set-*` path
  uses (two surfaces cannot drift; schema stays additive). Keys outside
  `EDITABLE_LOOP_FIELDS` are rejected with a 400 listing the allowed set. Both
  `loopany new` and `loopany edit` support `--dry-run` (server validate-only, zero
  persistence).
- **`createLoop` also accepts an optional `ui`** (gateway `createLoop`, same
  `validateUi` + `WIRE_TEXT_CAP` clip as `set-ui`/`editLoop`), so a template-driven
  loop ships a **day-one dashboard** instead of waiting for an evolve pass. The daemon
  `loopany new` spreads the whole `--json` config, so `ui` passes through with no
  whitelist change; `--dry-run` reports `ui` as a presence flag (like `workflow`), not
  the markup. `create.md`'s "Dashboard at create" step tells the agent to author the
  initial `ui` when the product shape is already known (cross-refs `evolve.md` §3).
  **A dropped dashboard is never silent**: the REAL create response echoes `ui`
  presence (and the CLI prints `dashboard ui: applied|not applied`), and when a
  provided `ui` validated to null the response carries a `warning` that the CLI shouts
  to stderr — create still succeeds, just without a dashboard.
- `describe()`/`validCadence` probe crons in the LOOP's timezone (fire times shift
  with it).

## Daemon gotchas

- `cli.ts` dispatch order: in-run callback (`LOOPANY_RUN_TOKEN`+args) FIRST, then
  help/version/up/new/skill/status/down/log/update/interactive verbs. `-v`/`--version`
  (like `--help`/`-h`/`help`) is a light fast-path handled BEFORE the daemon fallback -
  it prints just the version (`help.ts` `printVersion`, reusing `daemonVersion()`) and
  never launches a daemon; the usage screen also leads with that version. The daemon
  fallback is guarded: an unknown leading verb errors exit 2, never silently
  backgrounds a daemon.
- Pidfile `~/.loopany/daemon.pid` records `<pid>:<startTime>` so a pid reused after
  an unclean crash is never mistaken for the daemon (or SIGTERMed by `down`).
  `loopany up` consults the pidfile first (never spawns a second daemon); the device
  token passes to the child via ENV, never argv (`ps`-visible).
- `loopany new` takes `--json '<inline>'` (or `--json -` for stdin); `loopany edit`
  is JSON-only (`--json '<obj>'`) plus the content-file trio (`--workflow-file`,
  `--ui-file`, `--schema-file`). Unknown flags reject loudly. The server is the sole
  validator.
- `loopany log [<loop>]` - concise run survey (session ids + metrics; `--transcript`
  for full text; `--json` structured). Backed by `GET /api/machine/log` (device token).
- `loopany update` hands the running daemon over to the invoking (new) CLI version:
  `down` then `runEnsure({force:true})` - force skips the still-reported-online
  short-circuit (server `ONLINE_TTL` 30s outlives the local pidfile clear).
- `loops.agent` records which coding agent created the loop (measured env
  fingerprint > `--agent` > server default) - RECORDING-ONLY; execution is always
  Claude today.
- External touches (process/network/fs) are injectable seams throughout; tests never
  need a real process or network.
- **Unified CLI transport `cli-client.ts` `postCli(argv, legacy, deps)`** (batch 5):
  the ONE client behind BOTH CLI worlds. It selects the credential by env (run token
  from `LOOPANY_RUN_TOKEN` wins, else the persisted device token), inlines the file
  flags (`--message-file`→`--message`, `--state-file`→`--state-content`, `--file`→
  `--file-content` — moved out of `callback.ts` so both credentials get it), and POSTs
  `{argv}` to the unified `/api/machine/cli` (server batch 4). On a **404** (old server)
  it invokes the per-credential `legacy` fallback — `legacyRun` → `/agent-api/loop` for
  a run token; the caller-supplied device fallback (`/api/machine/loop` GET/POST/PATCH,
  `/api/machine/log`) for owner verbs — one release of back-compat. `callback.ts` /
  `interactive.ts` / `log.ts` / `create.ts` all converge onto it; the LOCAL verbs
  (up/down/update/skill/status/help/version/bare-daemon) keep their own fast-paths and
  never touch the server. `log`'s cwd→loop resolution stays CLIENT-side (lists loops,
  then posts `log <id>`) because the server's `log` dispatch needs an explicit id.
  This ships in the npm daemon package, so it needs a coordinated `@crewlet/loopany`
  release. (The daemon still forwards whatever token its env carries — the `rk_` run
  lease is batch 6, not here.)
- **`runner.ts` skips the sys file + `--append-system-prompt-file` when the delivery's
  `systemPrompt` is empty** (batches 1-2 make it empty; an OLD server that still
  populates it keeps working — the flag path is preserved when the string is non-empty).

## Web UI gotchas

- Loop detail and run detail are PAGES, not modals: `/loops/$loopId` and
  `/loops/$loopId/runs/$runId` (route file `loops.$loopId_.runs.$runId.tsx` - the
  trailing `_` un-nests it). Never render Base UI `Dialog.*` parts (e.g. `ModalHead`)
  without a `Dialog.Root` ancestor - it throws at runtime; bare-page edit modes use
  `EditHead`.
- **Loop-detail Edit composer (`editVia`)** offers TWO paths: (1) **Dispatch** -
  `requestEdit({id, instruction})` runs ONE agent pass on the owner's machine
  (spends credits, no conversation); (2) **Copy prompt** - `copyEditPrompt` copies a
  self-contained prompt (`lib/editPrompt.ts` `buildEditPrompt`, a PURE + unit-tested
  helper) for the owner to paste into their OWN local coding-agent session and adjust
  the loop conversationally (no dispatch, no credits). The hint names WHERE to run it,
  deriving the loop's on-disk dir from `job.taskFile` via `loopDir` (degrades to a
  generic instruction, never a fabricated path). Generic operation copy is
  **agent-neutral** ("your coding agent"), NOT "Claude Code" - Loopany runs more than
  one agent (claude-code, codex, more later); the only "Claude Code"/"Codex" survivors
  are the `AGENT_LABEL` chip (the loop's ACTUAL recorded agent, a factual label).
  Guarded by `loopDetailEdit.regression.test.ts`.
- **Hard rule: no page-level horizontal scroll.** `min-w-0` on every grid/flex child;
  wide content scrolls inside its own pane (dashboard `overflow-x-auto`, `.taskmd
  table` as a scrolling block, `Timeline` row `min-w-0 overflow-x-auto`). Guarded by
  the `*.regression.test.ts` files - keep them green.
- Dashboard generative-UI primitives are `loop-embed`/`loop-calendar`/`loop-kanban`
  (registry in `LoopView.tsx`; `loop-kanban` in `components/LoopKanban.tsx` is a
  collection view grouping front-matter-`type`d markdown artifacts into columns -
  `columns` REQUIRED + comma-separated, unmatched types collect in a trailing
  "Other" column, task file always excluded). Registering one means moving THREE
  things together: (1) `LOOP_TAGS`/`LOOP_ATTRS` + the DOMPurify `uponSanitizeAttribute`
  force-keep hook (data-bearing attrs like `columns`/`match` are otherwise stripped,
  silently blanking the element); (2) the html-react-parser `replace` swap; (3) the
  skill authoring docs (`evolve.md` §3 + `skill/run/edit.md`, plus `create.md` §2
  for the `type` vocabulary). Board row is the ONLY horizontal-scroll container
  (`min-w-0 overflow-x-auto`, columns `shrink-0` fixed-width) - a wide board scrolls
  inside its pane, never widening the page. Skill markdown + UI copy is ENGLISH ONLY.
- Recharts stays OUT of the base client bundle (`LoopDetailView` lazy-loads the
  `LoopView` chunk). All animation is off, INCLUDING `<Tooltip
  isAnimationActive={false}>` (the position tween causes a transient page scrollbar
  flash). Testing: Recharts v3 mounts via effects - use a client render under `act`
  plus a jsdom ResizeObserver stub that fires a real contentRect on `observe`.
- Files panel: the task file IS the loop folder's README and appears EXACTLY ONCE
  (`lib/fileEntries.ts` dedup on normalized paths); the task row renders
  `taskFileContent` from the loop record, not the blob fetch.
- Dashboard refresh is fetch-then-set, never `router.invalidate` (its loader re-run
  throws on a transient blip; keep stale data instead).

## CI/CD (`.github/workflows/`)

- `deploy.yml`: push to `main` -> `flyctl deploy --remote-only` (Fly app
  `loopany-testing`). Migrations apply on container boot (forward-only).
- `publish-daemon.yml`: tag `v*` -> `npm publish` of the daemon ONLY, via **npm OIDC
  trusted publishing** - no `NPM_TOKEN`, and `setup-node` deliberately omits
  `registry-url` (setting it writes a dummy-token `.npmrc` that breaks OIDC; that was
  a real publish failure). Needs npm >= 11.5 (installed in-workflow). The tag must
  match `packages/daemon/package.json` version. pnpm version comes solely from the
  root `packageManager` field (do not also pass `version:` to `pnpm/action-setup`).
