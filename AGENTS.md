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
  rows, NOT an in-memory counter** (deploy-safe): `store.execFailureStreak(loopId)` is EXACT -
  two indexed queries, no bounded row scan: find the newest `done` **exec** run, then COUNT the
  `error` exec runs newer than it (evolve/edit/canceled/open rows match neither query, so they
  never break or inflate the streak); `shouldNotifyFailure(notify, streak)` notifies on streak `1`
  (the success→failure transition) and then every `FAILURE_NOTIFY_EVERY` (=5) - so a loop that
  fails every tick pushes at 1, 5, 10... and, with no scan cap, keeps reminding at every 5th
  failure forever; a success between failures resets the streak so the next failure re-alerts. `notify:"never"` suppresses failure alerts too.
  **Role gating:** only `exec` failures notify — evolve/edit are internal (config change /
  self-shaping) and never produce user-facing noise, success OR failure (mirrors the success
  path's existing exclusion). `failureMessage(reason)` maps machine-availability reasons
  (offline/disconnect/never-claimed) to a distinct "reconnect your machine" phrasing. The
  gateway takes an **injectable notifier** (3rd ctor arg, defaulting to `dispatchNotification`,
  mirroring the injectable `blobStore`) so tests observe pushes without network. Zero-exec
  invariant holds: the server only reads its own run rows to decide. No UI change needed — runs
  already persist `phase:"error"` + `error`, which `JobDetailView`/run lists already render.
- **Run lifecycle hardening (`gateway/index.ts` report/sweep + scheduler).** `report()` checks
  the run's phase FIRST: a **canceled** run's late report is ignored BEFORE any loop-level write -
  it never advances the workflow cursor or `taskFileContent` (the next run would silently skip
  data whose output the user never saw) and never flips the phase; the run token is still revoked,
  a canceled edit clears its `editRequest` marker, and a canceled **evolve clears `evolveDue`**
  (symmetric with edit - otherwise the canceled pass re-fires on the very next tick). `sweep()`'s
  `reclaimRun` also **revokes the run's tokens** (`revokeRunTokensForRun` - a swept run's orphaned
  agent must not keep a live agent-api credential), and the running-run timeout is
  **INACTIVITY-based, not since-claim**: `poll()` writes an `at` freshness stamp into the run's
  progress JSON (throttled to once per `PROGRESS_STAMP_REFRESH_MS` = 60s even when the step/label
  hasn't moved, so the ~3s poll hot path isn't a per-heartbeat UPDATE) and the sweep reclaims only
  when nothing was heard for the full `RUN_TIMEOUT_MS` window (`max(claim ts, at)`) - a healthy
  long run is never falsely failed; stampless runs from older daemons degrade to the old
  since-claim behavior. `finishEdit`/`finishEvolution` clear `nextRunAt` ONLY when it is
  missing/past (`spentNextRunAt`) - a FUTURE value survives, so a run's own `reschedule` isn't
  wiped by its own finalization. `describe()` (the `loopany show` payload) probes the next fire
  IN the loop's timezone, and `validCadence` probes the cron in the loop's timezone too (fire
  times shift with it). Wire-input bounds (untrusted daemon input): the OUTER boundary is
  `gateway/http.ts` `readJsonBody(request, MACHINE_BODY_CAP)` (2MB, content-length check +
  capped read → 413) at every machine-route JSON ingress (poll/report/loop POST+PATCH/agent-api;
  sync reuses the helper with its own `SYNC_BODY_CAP`), so the per-field caps are row-bloat
  budgets, not the security boundary. Per-field: poll progress processes at most
  `MAX_PROGRESS_ENTRIES` (32); task/workflow/`taskFileContent` (and `editLoop`'s `workflow`/`ui`
  patch fields) clip at `WIRE_TEXT_CAP` (512KB); a workflow cursor over `CURSOR_CAP` (256KB
  serialized) is dropped rather than persisted onto the loop row (the run still records normally);
  messages and a report's `error` clip at `MESSAGE_CAP` (2000), `sessionId` at `SESSION_ID_CAP`
  (200); a report's claimed `outcome` is whitelisted against `RUN_OUTCOMES`, anything else falls
  back to the role default.
- **Open/closed loops + goal self-termination (batch 1 of the loop redesign; migration
  `0015`).** Closed-ness DERIVES from goal presence — NO `kind` column: `loops.goal == null`
  ⇒ OPEN (monitor/digest, never self-terminates); `!= null` ⇒ CLOSED (each exec run is the
  comparator and may call `loopany finish` when the setpoint is met). Terminal state lives on
  the loop: `loops.completedAt` + `loops.completionReason` (both nullable); completing forces
  `enabled=false` (scheduler skips for free). **Structural invariant `completedAt != null implies
  goal != null` is enforced at the single write chokepoint `store.updateLoop`**, which also runs
  the lifecycle side effects for EVERY caller (editLoop/patchJob/finish/reopen): `goal:null` also
  clears the completion stamps; `enabled:true` on a completed loop is a REOPEN (drops stamps, goal
  survives); `enabled:false` is a plain pause (stamps untouched); an explicit `completedAt` in the
  same patch (finish) wins over the reopen clear. `allowControl` **default flipped to TRUE** (0015
  flips existing rows too) — `false` now means "owner PINS the schedule". **The `finish`/`complete`
  verb** (gateway dispatch) is gated by `slot.canFinish`, minted at poll as `run.role === "exec" &&
  loop.goal != null` (independent of allowControl, like the structural caps — evolve/edit NEVER get
  it). It records the run as an ordinary success (phase=done/outcome=exec/status=resolved, accepts
  `--message`/`--reason`/`--state`), stamps the loop terminal + disabled, `scheduler.removeLoop`,
  captures the end-state snapshot, and fires `completionMessage`
  via the injectable notifier unless `notify:"never"`. (**Batch 2 superseded the token-revoke
  detail:** finish now records a server-computed `durationMs` and leaves the token live for ONE
  enriching `report()` — see the batch-2 bullet's finish carry-overs; no double-finalize/notify
  still holds.) Open-loop finish ⇒ 403 "no goal to finish";
  non-exec ⇒ 403 "only an exec run". `describe()`/`loopany show` gained `goal:` + `self-finish:
  allowed|off` lines (run-gated like `self-schedule:`). **Cadence floors apply to the RUN
  self-schedule path ONLY** (owner `editLoop` unlimited): run-token `set-cron` rejected when
  adjacent fires (probed in the loop tz via `cronIntervalMs`, like `validCadence`) are under
  `LOOPANY_SELF_CRON_FLOOR_MINUTES` (15); run-token `reschedule --next` rejected under
  `LOOPANY_SELF_RESCHEDULE_FLOOR_MINUTES` (5) — both lazy env reads in `env.ts`. UI: `lib/format`
  `isDone` (the old disabled+resolved heuristic) is REPLACED by `isCompleted(j)=j.completedAt!=null`
  (+ `isClosed(j)=!!j.goal`); the dashboard split is completed-vs-not (section renamed "Completed";
  paused loops stay active). Closed active loops get a quiet "Goal" chip + a "Working toward:
  <goal>" line; completed loops get a green "Completed" badge + reason/date meta, the menu's
  pause item becomes "Reopen" (patch `enabled:true`), and "Run once" is disabled until reopened.
  NO progress bar / goalMetric / goalTarget (out of scope). Deferred to batch 2/3: the `task`
  column removal + static trigger, CLI/skill changes. Goal/completedAt/completionReason surface on
  `JobSummary`/`JobFull` via `adapters.ts`; `goal` accepted by createLoop/editLoop (clip
  `GOAL_CAP`=2000) + web `patchJob`.
- **CLI/JSON surface + `task`-column removal (batch 2 of the loop redesign; migration
  `0016` = `ALTER TABLE loops DROP COLUMN task`).** The **`task` column is GONE end to end** —
  schema, createLoop/editLoop/patchJob/`main.ts`, `adapters.ts` (`JobFull.task` dropped),
  `types.ts` (`JobFull.task`/`JobPayload.task`), and the manual `LoopForm` fallback. A loop's
  standing brief lives ONLY in its task file's `## Spec`. **`createLoop` now requires
  `workflow || taskFile`** (was `workflow || task`). **The per-run message is a server-composed
  STATIC trigger** (`gateway/prompt.ts` `buildExecTask`): a fixed template
  `skill/run/exec-trigger.md` (imported `?raw` alongside `exec-loop`/`edit`; run-only, NOT
  bundled/served — it's under `skill/run/` so the selective `sync-skill.mjs` whitelist already
  excludes it) filled with `{{name}}`, `{{taskFile}}`, and a `{{goalLine}}` that becomes
  `Goal (finish line): <goal>` for a closed loop (prompt-injected so it wins over the file). The
  daemon needs NO change to compose it: `delivery.task` IS the trigger, so the workflow escalation
  (`${d.task}\n\nworkflow signal:…`) and `buildWorkflowFallbackTask(d.task,…)` already embed it.
  **`exec-trigger.md` is minimal + neutral ON PURPOSE — batch 3 owns the polished prose there.**
  **Daemon CLI (breaking, next version — no users):** `loopany new --json '<inline>'` (or `--json -`
  reads stdin) REPLACES `--config <file>`; `loopany edit` slims to **JSON-only + the content trio**
  (`--json '<obj>'`, `--workflow-file`, `--ui-file`, `--schema-file`) — every scalar envelope flag
  (`--cron/--tz/--name/--notify/--model/--pause/--resume/--run-at/--task-file`) AND `--json-file`
  are DELETED; `buildPatch` now REJECTS an unknown/removed flag with `unknown flag --x — try
  --help` (was: silently ignored). **`--dry-run` on BOTH verbs** (server validate-only; zero-exec,
  no persistence): create returns `{config, timezone, nextRuns:[3 in-tz ISO], classification:
  open|closed, classificationText}`; edit returns `{changes:[{key,from,to}], rejections:[{key,
  reason}], ok}` (ok=false ⇒ CLI exits 1; the dry-run reflects the `store.updateLoop` reopen/
  goal-clear stamp side effects). New body field `dryRun:true` (POST) / `editLoop(…, dryRun)` (PATCH,
  4th arg via `body.dryRun`); `nextFires()` helper probes the cron in the loop tz. **Route rename:**
  `/api/bootstrap` serves `bootstrap.md` (`routes/api.bootstrap.ts`); the old `/api/skill` root route
  is DELETED; `ComposeModal` snippet is now `Fetch <origin>/api/bootstrap and help me build a loop.`
  References STAY at `/api/skill/references/<file>` (untouched; in DEV that `.md` path 404s via
  vite's static layer — the handler works in prod, guarded by its unit test). **finish carry-overs
  (batch-1 review deferrals, now due — this CHANGES batch-1 behavior):** (a) TOCTOU — `finishLoop`
  re-reads the loop and REFUSES (400, clear error) when `goal` is now null (owner cleared it since
  poll), so it never stamps a state violating `completedAt⇒goal`; (b) finish records durationMs +
  sessionId. `finishLoop` NO LONGER revokes the run token immediately — it records a server-computed
  `durationMs` (from the run's claim ts) and leaves the token live for exactly ONE enriching post-run
  `report()`: report()'s new `run.phase === "done"` branch records the precise durationMs/sessionId
  (+transcript/artifacts/taskFileContent) and THEN revokes, WITHOUT re-stamping/re-notifying/
  advancing the cursor (double-notify stays impossible). Deferred to batch 3: the six skill markdown
  files (SKILL/bootstrap/create/update/evolve + `exec-loop.md`, which polishes the trigger prose).
- **The loopany agent skill (`packages/server/src/skill/`).** The loop-builder
  knowledge is a real, installable agent skill — NOT one inline doc. **ALL prompt prose
  now lives under `src/skill/`** (the unify that retired `scheduler/prompts/` entirely).
  The surfaces, split by audience (the **bootstrap-skill-split**): (1) **`bootstrap.md`**
  — the SERVER-ONLY first-capture onboarding doc served at `/api/bootstrap` (renamed from
  `/api/skill` in batch 2) (**NO frontmatter**
  — it's fetched-and-followed, not installed; NOT bundled, NOT installed — like the run
  prompts); (2) the PUBLIC installable **`SKILL.md`** + authoring trio
  `references/{create,update,evolve}.md` (bundled + installed into `.claude/skills/loopany/`);
  (3) the INTERNAL run prompts in **`skill/run/{exec-loop.md,edit.md}`** (server-side
  run-dispatch only — never served, never bundled; see the public-surface guardrail below).
  **`bootstrap.md` owns first-contact onboarding** (the double-duty SKILL.md used to carry):
  interpret the pasted `server-url`/`connect-key`/`loopany-cli`, connect the machine
  (`loopany up`), fetch the references over HTTP because the skill isn't on disk yet, then
  build the loop. It carries the **session-situation division** (the captain's split):
  if the user already did a clear task this session → guide THAT into a loop; if there's
  no task yet → look at what THIS project is and brainstorm a few concrete loops FOR IT and
  let the user pick (create.md §0/§0.5 remain the shared task-real + propose→confirm guards).
  **`SKILL.md` is now the CLEAN installable root** (frontmatter `name: loopany` + a strong
  `description` so Claude auto-triggers it) with the bootstrap noise stripped (no connect-key /
  `loopany up` / "not on disk yet, fetch over HTTP") — it just routes to the on-disk references,
  which a later in-loop session reads from disk. It routes to the three references: `create.md`
  (task file → config → `new`), `update.md` (`loopany edit` envelope vs. task file), and
  `evolve.md` (the evolution pass that **improves the loop from its own run history**,
  reoriented to optimize the loop's TASK and WORKFLOW ahead of the dashboard). Its levers,
  in priority order: **§1 the task** — refactor the loop's own brief (`## Spec` /
  `## Current understanding`) from the log, **editing the task-file README directly on disk**
  (there is NO `loopany set-task`; task content is edited on disk, consistent with a normal
  run maintaining its own file); **§2 workflow** — precipitate repeated deterministic work
  into the cheap pre-stage (`set-workflow`); **§3 dashboard** — the lighter schema+UI lever
  (`set-schema`/`set-ui`, `{{latest.<key>}}` binding, series primitives). It opens with a
  **two-lens log reading** guide: `loopany log` (quick survey, now includes each run's
  `session` id — see the log bullet) vs. the session JSONL (deep dive, located via that
  session id — the primary input for the task/workflow levers). **`evolve.md` is ALSO the
  single source for the evolve RUN prompt** — `gateway/prompt.ts`
  `import evolve from "../skill/references/evolve.md?raw"` (`buildEvolvePrompt()`), so the
  skill and run-dispatch read the SAME file and the evolution guidance can't drift (the unify
  that retired the old near-duplicate `scheduler/prompts/evolve.md`). `buildEvolveTask`'s
  one-line instruction leads with reviewing the log to **sharpen the task + distil/refine the
  workflow**, dashboard as the lighter lever, still "Do not message the user." The OTHER run prompts (`exec-loop`, `edit`) live under
  **`skill/run/`** and are imported the same way (`import execLoop from "../skill/run/exec-loop.md?raw"`,
  `import edit from "../skill/run/edit.md?raw"`). The `?raw` import bundles the text into the
  nitro `.output` identically from `skill/run/` as it did from `scheduler/prompts/` (no runtime
  `fs`/ENOENT). **§4 of `exec-loop.md` is ONE static section for every loop — the standing prompt
  does NOT branch on `allowControl`** (the old `control-on`/`control-off` variants and the
  `resolveControl()`/`CONTROL_BLOCK` folding are gone). §4 is a uniform judge → `show` → adjust
  block: the run first decides whether what it found warrants a cadence change, runs `loopany show`
  to learn whether it may self-schedule, and if so uses ONLY the two cadence levers **`reschedule`
  + `set-cron`** — a run is deliberately NOT offered `pause`/`resume`/`notify` anymore (those stay
  owner/edit surfaces). `buildLoopSystemPrompt` fills just `{name, taskFile, stateLine}`. **`loopany
  show` reports the effective self-schedule capability**: `describe(loopId, allowControl?)` in
  `gateway/index.ts` appends `self-schedule: allowed|off` from the run slot's EFFECTIVE
  `allowControl` (`structural || loop.allowControl`, so an evolve/edit pass reads `allowed` while a
  normal exec run reflects the loop flag); the `show` handler passes `slot.allowControl` in
  (undefined ⇒ line omitted for non-run callers). §3's old "if you may control the schedule,
  `loopany pause` until they act" clause was removed — a blocked run makes one bounded report and
  exits, it does not pause itself. (This §4 is a DELIBERATE behavior change, NOT byte-equivalent to
  the prior on/off design.) `exec-loop`/`edit` are run-only (no authoring twin), and `edit` is **kept separate from
  `update.md` on purpose** — the edit RUN uses run-token verbs on the current loop (`loopany
  set-cron`/`set-tz`/`set-ui`…, no id, via `/agent-api/loop`) while `update.md` is the AUTHORING
  CLI (`loopany edit <id> --json '{"cron":…}'`, local daemon — batch 2 slimmed this to JSON-only);
  the two command surfaces serve different
  actors and can't merge into one doc without making one audience wrong or breaking the run.
  **`/api/bootstrap` serves `bootstrap.md`** (`routes/api.bootstrap.ts`, `import bootstrap from
  "../skill/bootstrap.md?raw"`) — the first-capture onboarding doc; **`/api/skill/references/<file>`**
  (`routes/api.skill.references.$.ts`, static map, path-safe — only the 3 exact names
  `create`/`update`/`evolve` resolve; `exec-loop`/`edit`/`bootstrap` 404) serves the references over
  HTTP as a **fallback** when the local install was skipped. **HARD GUARDRAIL — the internal run
  prompts AND `bootstrap.md` must NEVER reach the public surface:** the skill is **bundled into the
  `@crewlet/loopany` npm package** (`package.json` `files` lists `skill`), but
  `packages/daemon/scripts/sync-skill.mjs` is a **SELECTIVE copy** — it whitelists ONLY `SKILL.md` +
  `references/{create,update,evolve}.md` (NOT a naive `cpSync(src, dst, {recursive})`, which would
  ship `skill/run/` AND `bootstrap.md` into the public tarball and into every user's installed
  `./.claude/skills/loopany/`). The bundle (`packages/daemon/skill/`, **gitignored**, generated like
  `routeTree.gen.ts`) therefore ends up with exactly `SKILL.md` + the references trio and nothing
  else (guarded by `packages/daemon/src/sync-skill.test.ts`, which asserts the exact 4-file set and
  explicitly that `bootstrap.md`/`run/` are absent). Do NOT fork the content; edit the six source
  files (`bootstrap.md`, `SKILL.md`, the three references, and the two `run/` prompts).
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
- **Daemon CLI ergonomics (`loopany --help` / `status` / `down`).** `cli.ts`
  `main()` dispatch order: in-run callback (`LOOPANY_RUN_TOKEN`+args) → `--help`/`-h`/
  `help` (`help.ts`, prints usage, exit 0, NEVER starts the daemon) → `up` → `new` →
  `skill` → `status`/`down` (`control.ts`) → `log` → interactive verbs → fallback. The fallback
  is **guarded**: bare `loopany` (no args) OR a leading `DAEMON_FLAGS` token
  (`--server-url`/`--api-key`, the detached spawn re-execs us that way) runs the daemon;
  **any other leading verb/flag errors `unknown command … try --help` (exit 2)** rather
  than silently backgrounding a daemon (the old fall-through bug). All new verbs sit
  AFTER the callback guard, so they never hijack an in-run callback. **Local pidfile**
  (`pidfile.ts`, `~/.loopany/daemon.pid` under the same `LOOPANY_DIR` as the device
  token): `runDaemon()` **refuses to boot when a live VERIFIED daemon already owns the pidfile**
  (a second daemon would overwrite it, and its exit would delete the file while daemon #1 still
  runs - invisible to `status`, unkillable by `down`, double-polling the server), writes its own
  pid on boot, and on exit clears the file **only if it still records ITS pid** (never delete a
  file a newer daemon has since claimed). The pidfile records
  **two identity fields** — `<pid>:<startTime>` — where `startTime` is the daemon
  process's start time, derived best-effort from `ps -p <pid> -o lstart=` via the ONE
  shared `processStartTime()` helper (same string at write- and check-time; macOS+Linux
  portable; undefined when `ps` is unavailable, and the file degrades to a bare `<pid>`,
  which old files also parse as). A recorded pid is treated as "our daemon" only when it
  is alive (`kill(pid,0)`; ESRCH=dead, EPERM=alive-but-not-ours) **AND** (no recorded
  startTime, OR the live `processStartTime(pid)` still equals the recorded one) — so a pid
  **reused** by an unrelated process after an unclean crash (which left the pidfile
  behind) is NOT mistaken for the daemon and `down` never SIGTERMs it. A start-time
  mismatch OR dead pid clears the stale pidfile as a side effect; when the start-time
  can't be read at check time it degrades to alive-only (best-effort, never crashes).
  `status` reports running+pid plus server URL, a device-token **fingerprint** (last 6
  chars, never the full token), and a best-effort server `connection` line
  (`/api/machine/status`, via the shared `fetchMachineStatus` in `control.ts` - also
  `loopany up`'s readiness probe - with a **3s timeout** so a hung server degrades quickly
  to "unknown — server unreachable");
  `down` SIGTERMs the verified pid and is a **clean no-op** when none runs (and on the
  probe→signal ESRCH race). **`loopany up` (`ensure.ts`) consults the local pidfile FIRST** - a
  live verified daemon means never spawn a second one, so an unreachable server can't make
  repeated `up`s leak a new daemon per attempt; the detached spawn passes the device token via
  child ENV (`LOOPANY_TOKEN`, which `runDaemon` reads) with argv carrying only the non-secret
  `--server-url` (argv is `ps`-visible for the daemon's whole lifetime, the token file is 0600);
  and on readiness timeout it SIGTERMs exactly the child it spawned (whose clean exit clears its
  own pidfile) instead of leaving it running detached. `control.ts` exposes every external touch (pid read, liveness,
  start-time lookup, kill, fetch, server/token, output) as an **injectable seam** so
  `control.test.ts` needs no real process/network; `cli.test.ts` runs the entry as a real
  subprocess to prove help/unknown EXIT (never launch the daemon). Shipped in daemon
  **0.5.0**.
- **Daemon hardening (`roots.ts` jail + env allowlists + bounded I/O).**
  **`LOOPANY_ROOTS` is an ALWAYS-APPLIED local jail** (new `src/roots.ts`): when the env roots are
  set, server-sent `roots` survive only when they sit INSIDE a local root (`effectiveRoots` -
  narrowing only; disjoint server roots are ignored and the local jail stands), so a
  hostile/compromised server can never widen the jail and point a run at e.g. `~/.ssh`. The jail
  confines the run workdir (`resolveWorkdir` throws outside it), the **watcher's watch-dirs**
  (an outside loop folder is not watched; the daemon-owned `~/.loopany/work` scratch stays
  allowed), and **task-file reads** (`readTaskFile` refuses a server-sent path outside both the
  jailed workdir and the local roots). Paths are `path.resolve`-normalized BEFORE the prefix
  check, so a server-sent `/jail/root/../../…` can't lexically pass while resolving outside
  (a review-caught bypass). With no local roots, behavior is unchanged (fully open default).
  **Child env is allowlisted everywhere** (`spawn.ts` `allowlistEnv`, base = PATH/HOME/locale/
  proxy/CA keys): `execEnv()` for the claude child grew `CLAUDE_CONFIG_DIR` + the `ANTHROPIC_*`
  prefix (proxy/gateway users; a relocated claude config keeps writing transcripts where
  `sessionTrace()` reads them), and the **workflow subprocess no longer inherits full
  `process.env`** - it gets the same base allowlist plus `LOOPANY_WORKFLOW_*` and the exact keys
  named in **`LOOPANY_WORKFLOW_ENV=KEY1,KEY2`** (the pass-through knob for MCP `${VAR}` credential
  expansion; documented in `docs/mcp-workflow-tools.md` + `evolve.md` §2b, and the
  workflow-fallback task text explains the knob so the agent can tell the user which key to name).
  **Bounded network + clean teardown:** poll/report/sync/blob-PUT fetches all route through the
  ONE `boundedFetch` helper (`src/http.ts` - per-call timeout budgets stay at the call sites, a
  caller signal composes via `AbortSignal.any`, and the undici ~5min-default rationale is
  documented once there; a hung connection can't stall the heartbeat or wedge a report); SIGTERM/
  `down` plumbs an AbortController into in-flight claude children (`runProcess` spawns detached
  into its own process group and kills the WHOLE tree, `kill(-pid)`, SIGTERM→SIGKILL, so a killed
  workflow's mcporter stdio grandchildren die too), with a bounded drain before exit; a timed-out
  run **keeps its `sessionId`** (parsed from the streamed events before the kill) so the transcript
  stays locatable. The local cron pre-check in `loopany new` accepts 5- and 6-field expressions
  plus `@`-shortcuts (`@daily` …) - the server stays the sole judge.
- **Run-log read endpoint + `loopany log` (daemon 0.6.0).** The on-machine agent can
  pull a loop's recent run **transcripts** so create/update/evolve aren't blind to how
  past runs went. The transcript used to be web-UI-only (`getTranscript` server fn).
  **Server:** `MachineGateway.loopLog(deviceToken, loopId, limit?)` (`gateway/index.ts`)
  is the device-facing twin of `getTranscript` — authed by the **same device token**
  the daemon already uses and scoped **strictly** to a loop bound to THAT machine
  (`loop.machineId === machineId`, exactly like `editLoop`/`sync`; a cross-loop or
  cross-device token gets a flat 404, existence never leaks). Read-only. Returns the
  newest N runs (default 8, max 20) newest-first with id/ts/role/phase/outcome/status/
  durationMs/error/message + **`sessionId`** (`r.sessionId ?? null` — the claude-code
  session id, so the evolve agent or a user can jump from the survey straight to the run's
  on-disk `<session>.jsonl` deep dive; already stored on the run row, just now returned) +
  the run's **reported metrics** (`state` = the metric object, `sample` = the single-metric
  sample, both `?? null`) so the survey surfaces the numbers a run reported alongside its
  transcript (matches what `buildEvolveTask` feeds the evolve agent) +
  the transcript flattened to text (`renderTranscript`,
  clipped to 8000 chars/run → `transcriptTruncated`). Mounted at `GET /api/machine/log?
  loopId&limit` (`routes/api.machine.log.ts`, Bearer device token). NO new auth scheme.
  **Daemon:** `loopany log [<loop>] [--limit N] [--transcript] [--json]` (`log.ts`, wired in `cli.ts`
  after `down`) — an owner-outside-a-run command like `loops`/`edit` reusing the stored
  device token. It resolves which loop via the **shared `resolveLoopDir`** (extracted
  from the watcher into `loopdir.ts`, no chokidar): an explicit `<loop>` id/name wins,
  else the current cwd is matched against each loop's resolved folder (most-specific
  wins; a subdir of the workdir still matches). `listLoops` now also returns
  `workdir`/`taskFile` so the daemon can do that match. The daemon's `RunRow` carries
  `sessionId` plus the reported metrics (`state`/`sample`). **The default human render is a
  CONCISE survey** — per run just the header + `session: <id>` line + (when present) a
  `metrics: sample=…, <k>=<v>` line + error + one-line message, but **NOT** the verbose
  transcript (up to 8KB × N runs buries the useful bits; the session id is the pointer to the
  full session JSONL). `--transcript` (alias `--full`, both in `BOOL_FLAGS` so a positional
  loop id isn't swallowed) inlines the clipped transcript; `--json` always returns the full
  structured runs (transcript + sessionId + metrics) for machine consumers. Every external touch (cwd/fetch/
  out/err/server/token) is an injectable seam (`log.test.ts`, no network). The skill's
  `references/update.md` tells the agent to run `loopany log` before reshaping a loop, and
  `references/evolve.md`'s two-lens log-reading uses the returned `session` id to locate the
  session JSONL. (The `sessionId` return was folded into the unpublished 0.6.0 — no bump.)
- **`loopany edit` partial-JSON + content fields (daemon 0.6.0, folded in — NO bump).**
  The owner can reshape/migrate an existing loop WITHOUT a run. **Server
  (`gateway/index.ts` `editLoop`):** the accepted patch now also carries the content
  fields — `workflow`, `ui`, `stateSchema` — on top of the envelope set
  (name/cron/timezone/notify/model/allowControl/taskFile/enabled/runAt). They reuse the
  **exact same validators the run-token `set-*` path uses**: the old `applySet{Ui,Workflow,Schema}`
  were refactored so their validation/normalization lives in pure `validate{Ui,Workflow,Schema}`
  helpers (return a normalized value or `{ok:false,detail}`); `applySet*` and `editLoop` both call
  them, so the two surfaces can't drift (schema stays **additive** — a key still bound by the UI or
  reported by recent runs can't be dropped; run-token `set-*` behavior is unchanged).
  `validateSchema` accepts EITHER a JSON string (run-token path) OR an already-parsed array (an
  `editLoop` JSON patch may carry `stateSchema` inline). **No `allowControl` gating** on this owner
  device-token path (consistent with the existing editLoop contract — the owner already controls
  their loops). **Whitelist:** `editLoop` rejects any patch key outside `EDITABLE_LOOP_FIELDS` (the
  12 allowed keys) with a 400 listing the allowed set — a `--json` typo fails loudly instead of a
  silent no-op, and identity/ownership columns (id/teamId/userId/machineId/createdAt/updatedAt) can
  never be patched. **Daemon (`interactive.ts` `buildPatch`, now exported for tests):** `loopany edit`
  gains `--json '<obj>'` / `--json-file <path>` (parse an object → merge into the patch; **explicit
  JSON keys win** over flag-derived values) plus convenience file flags `--workflow-file` /
  `--ui-file` / `--schema-file` that read a file's raw content into the patch field (schema parsed as
  JSON, mirroring the run-token `set-ui --file` shape). `--task-file` already worked (the discoverability
  bug was only that `USAGE` omitted it); the multi-line `USAGE` now documents the full set. The server
  is the sole validator. Tests: `gateway/index.test.ts` (editLoop accepts+validates workflow/ui/schema,
  rejects unknown keys, schema-as-string parity), `daemon/interactive.test.ts` (buildPatch flag→patch
  mapping + precedence). `references/update.md` documents repointing the task file and pushing
  workflow/ui/schema via `loopany edit`.
- **MCP tool calls inside loop workflows (`tools.call`, phase 1; daemon 0.7.0).** A loop's deterministic
  JS workflow can call the machine's OWN configured MCP servers via
  `await tools.call("server.tool", args)` — folding the mechanical fetch/list/dedup/filter/sort
  the agent used to re-invoke every run into cheap deterministic JS, leaving only judgment for
  the LLM. Backed by **`mcporter`** (pinned `0.12.3`, a daemon dependency) whose JS API is
  driven fully headless: `createRuntime().callTool(server, tool, { args, disableOAuth: true,
  timeoutMs })` — `disableOAuth: true` uses cached bearer tokens and NEVER launches an
  interactive OAuth/browser flow (verified early-gate against the real PostHog MCP: read-like
  call returns data ~3s; missing auth fails fast ~290ms with a 401 SseError, no hang; missing
  server throws `Unknown MCP server`; a missing/failed tool comes back as `{isError:true}`, NOT
  thrown). **`packages/daemon/src/mcp-bridge.mjs`** is the JS API behind `tools.call` — authored
  as PLAIN ESM (`.mjs`, no TS) ON PURPOSE because the workflow subprocess is spawned with a bare
  `node` (never tsx), so it must import a file bare-node runs in BOTH dev (`src/`) and prod
  (`dist/`); `scripts/copy-runtime-assets.mjs` copies the `.mjs` into `dist/` (chained ahead of
  `tsc` in build/prepublishOnly, since tsc neither compiles nor copies `.mjs`). `import("mcporter")`
  in the bridge resolves relative to the bridge's own location → the daemon package's
  node_modules in either tree. The bridge returns `{ text, data, truncated? }` (`data` =
  structuredContent, or JSON parsed from text, else null; dropped to null if it alone exceeds the
  cap), caps args (`LOOPANY_WORKFLOW_TOOL_ARGS_CAP`, 16KB) + results
  (`LOOPANY_WORKFLOW_TOOL_RESULT_CAP`, 256KB) + per-call timeout
  (`LOOPANY_WORKFLOW_TOOL_TIMEOUT_SECONDS`, 30s), and turns every failure (missing
  server/tool/auth/runtime, `isError:true`) into a clear THROWN error naming the server/tool.
  **`workflow.ts`** injects `tools.call` into the sandbox and passes the bridge file URL via
  `LOOPANY_MCP_BRIDGE` (read at call time via `mcpBridgeUrl()` so a test/override applies; the
  bridge is lazily imported on first `tools.call`, so a workflow that never uses it pays no MCP
  cost). **Fallback behavior change in `runner.ts`:** a failed workflow (thrown JS, a failed
  `tools.call`, a timeout) NO LONGER just reports a failed run — it FALLS BACK to the agent via
  `buildWorkflowFallbackTask(originalTask, {error, source}, dateStamp(), loopName)`: the agent
  first completes THIS run's original task (loop still delivers the tick), then diagnoses the
  workflow failure (task carries the original task + workflow error + workflow source); if fixing
  needs the user to change perms/env/auth the agent writes `workflow-setup-<YYYY-MM-DD>.md` in the
  workdir and surfaces a one-line copy-paste prompt (`fix workflow issue in loopany/<loop>/
  workflow-setup-<date>.md`). The cursor is NOT advanced on failure. **Read-like only in phase 1
  is a PROMPT posture** (create.md's one-line `tools.call` workflow-bullet mention, plus
  `evolve.md` §2b — the self-contained home for the surface + caps — with the
  worth/not-suitable/principles criteria + a worked PostHog example) — NOT a code blocklist. Tests
  (no network): `mcp-bridge.test.ts` (caps/shaping/clear-errors via injected fake runtime),
  `workflow.test.ts` (`tools.call` wiring via a fixture bridge pointed at by `LOOPANY_MCP_BRIDGE`),
  `runner.test.ts` (fallback path via a fake `claude` bin + failing bridge fixture). Live PostHog
  manual-acceptance steps: `packages/daemon/docs/mcp-workflow-tools.md`. Do NOT scope-creep into
  write-tool support / a tool registry UI / CLI unification (later phases).
- **Dashboard artifact primitives (`loop-embed`/`loop-calendar`) + Recharts charts.**
  The generative-UI primitive registry lives in `LoopView.tsx`, and registering a
  primitive means moving THREE things together: (1) `LOOP_TAGS`/`LOOP_ATTRS` + the
  DOMPurify config INCLUDING the `uponSanitizeAttribute` force-keep hook (data-bearing
  attrs like `series`/`match` carry colons/commas/globs DOMPurify otherwise strips,
  silently blanking the element); (2) the html-react-parser `replace` swap; (3) the
  skill authoring docs (`skill/references/evolve.md` §3 + `skill/run/edit.md`) - a tag
  in the sanitizer but not the skill is never authored, the reverse renders nothing.
  `<loop-embed file="…"|match="…" [full]>` embeds the NEWEST matching synced artifact
  (resolution + dating in the pure, tested `lib/productDate.ts`: filename date first -
  `YYYY-MM-DD`/`YYYY_MM_DD`/`YYYYMMDD` in the BASENAME, consistent separator, not
  embedded in longer digit runs - else sync time, and the UI marks the fallback
  visibly); collapse is 300px via a WRAPPER (`overflow-hidden`+max-height), never
  clipped text nodes. `<loop-calendar match="…">` is the Monday-start month grid of
  the loop's products (task file excluded from the default set via `isTaskPath`;
  chips collapse to dots under 620px of CONTAINER width, measured by ResizeObserver,
  not a viewport media query). Both primitives share ONE lazy `getArtifacts` fetch
  made only when the template mentions them, and render file content through the
  SHARED `components/artifactView.tsx` (ViewerHead/ArtifactBody/BinaryNotice - the
  same code the Files panel viewer uses, so copy and behavior can't drift).
  **Charts are Recharts v3 in the shadcn/ui-charts grammar** (`LoopChart.tsx`),
  themed only by the `--color-chart-1..5` ramp (app.css `@theme`, aliases of the
  semantic palette): fixed `HEIGHT=190` + `ResponsiveContainer` (container-driven
  width, constant height - the old fixed-viewBox SVG scaled like an image: ~4px
  strokes and a ~340px-tall chart at full dashboard width), single series = gradient
  area, multi-series = plain lines (translucent fills go muddy in monochrome), a
  single-point series = labeled dot (never a blank chart), `isAnimationActive` off.
  Testing gotchas: Recharts v3 mounts its SVG via effects, so `renderToStaticMarkup`
  yields an EMPTY wrapper - chart assertions need a client render under `act`, plus
  a jsdom ResizeObserver stub that FIRES a real contentRect on `observe` (jsdom
  measures 0×0 and Recharts then renders nothing; `initialDimension` only covers the
  pre-measure render). Bundle: recharts must stay OUT of the base client bundle -
  `LoopDetailView` lazy-loads the whole `LoopView` chunk (`React.lazy` + Suspense;
  verified in `.output/public/assets`: recharts appears only in `LoopView-*.js`).
  Width containment is guarded by `dashboardArtifacts.regression.test.ts`
  (calendar `grid-cols-7` = minmax(0,1fr) tracks + `min-w-0` cells + truncating
  chips; embed wrapper-clipping; chart fixed-height ResponsiveContainer, no
  `viewBox=`). **Tooltip motion gotcha: the `<Tooltip>` sets
  `isAnimationActive={false}`.** Recharts' default tooltip carries an inline
  `transition: transform 400ms`, so when the active point changes the box SLIDES
  from its old spot to the new (clamped, in-viewBox) one. On the loop detail page
  the chart's right edge coincides with the `min-w-0 overflow-x-auto` dashboard
  box's right edge, so mid-slide near the last data point the tooltip momentarily
  sits out of bounds and the browser flashes a horizontal scrollbar for the whole
  ~400ms tween (verified E2E: a real hover over the rightmost point measured
  `scrollWidth − clientWidth = 38px` during the slide, `0` after it settled). The
  settled tooltip already clamps inside the chart at every edge, so disabling the
  position tween (jump, don't slide - matching the series' own
  `isAnimationActive:false` and the Nothing "fade, don't slide" motion) fixes the
  flash without clipping the tooltip. Do NOT reach for `overflow:hidden` on the
  chart box - `overflow-x:hidden` forces `overflow-y:auto`, which would clip the
  tooltip vertically at the top/bottom edges. Guarded by the regression test
  (`isAnimationActive={false}` present on `<Tooltip>`).
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
- **Artifact storage retention / GC (`gateway/retention.ts`).** R2 blob bytes are
  content-addressed + deduped; before this, nothing reclaimed a blob once the path that
  referenced it was deleted/overwritten, so R2 grew monotonically. Three pieces, all
  server-side, all working on BOTH the R2 and in-memory `BlobStore` (tests run in-memory).
  **(1) Blob GC** — `BlobStore.delete(hash)` (idempotent; R2 `DeleteObjectCommand`, memory
  `map.delete`). `retention.gcBlobs(blobStore, graceMs)` computes the LIVE keep-set
  (`store.liveBlobRefs`: every non-null `artifact_files.hash` UNION every hash in every
  retained `run_snapshots` manifest — tombstones carry `hash=null` so they don't pin a
  blob) and reclaims only blobs NOT in it. CRITICAL invariant: a blob shared by multiple
  file rows AND/OR retained snapshots is never deleted. Concurrency-safe via three guards:
  a **grace window** (`blobGcGraceMs`, default **1h** — a blob whose `blobs.createdAt` is
  younger is never collected, so a blob a concurrent sync just wrote/referenced is
  untouchable); a per-candidate `store.blobIsReferenced` re-check right before the byte
  delete (skip ⇒ keep both bytes AND metadata); and a **bytes-before-metadata delete
  ordering** that closes a TOCTOU data-loss window. Per garbage hash the GC deletes the
  BYTES first, then drops the metadata row **unconditionally** (no post-delete re-scan —
  `deleteBlob` runs regardless, so re-checking referencedness afterward would only adjust a
  counter while paying a full snapshot manifest scan on the common genuine-garbage path; the
  pre-delete guard is the correctness gate): so even if a sync raced the byte delete (re-
  referencing the hash + recreating the `blobs` row mid-await), `blobExists()` still goes
  false and that file re-uploads its bytes on the next sync — the GC NEVER leaves a live
  `blobs` row pointing at deleted bytes. A failed byte-delete leaves both bytes and metadata
  intact, so a later pass retries (no dangling row). `store.blobIsReferenced` does the
  **indexed** artifact_files point query (`artifact_files_hash_idx`, migration `0014`) FIRST
  (the common re-reference path) and, only on a miss, a **bounded** `store.snapshotReferencesHash`
  scan of retained snapshots — so a blob that came to be referenced by a retained snapshot at
  GC-CHECK time (a sync re-references an old garbage hash → `report()` snapshots it → a later
  sync removes the file row) is never byte-deleted, closing the residual gap in the
  never-delete-a-snapshot's-blob invariant. The JSON-manifest scan is gated behind the file
  miss, so it touches only the few garbage candidates; the full snapshot scan in the bulk path
  stays solely in `liveBlobRefs` (the keep-set computed once at pass start). Bias: a
  leaked blob is a cost bug the next pass reclaims; a wrongly-deleted blob would be data
  loss, so when in doubt KEEP.
  **(2) Snapshot retention** — `store.pruneRunSnapshots(loopId, keep)` keeps the newest
  `keep` (by `createdAt`); `LOOPANY_SNAPSHOT_RETENTION` default **20** (the diff only needs
  the prior snapshot; 20 keeps ample "Changes" history while bounding blob retention).
  Pruned at `report()` time (prompt, cheap) AND in the periodic pass. Pruning is what
  unpins old blobs so the GC can collect them. The delete is by the `loopId AND runId NOT IN
  (survivors)` predicate (survivors bounded by `keep` ≤20), NOT an `inArray` of every victim
  runId, so a large pre-feature backlog prunes in one statement without tripping SQLite's
  bound-variable limit. **(3) Per-loop byte cap** — `store.loopStoredBytes`
  (sum of live, byte-backed file sizes, preferring the VERIFIED `blobs.size` via a
  `artifact_files→blobs` join and falling back to the client-reported `artifact_files.size`
  only for a not-yet-stored/pending row — so an under-reporting daemon can't keep the base
  artificially low and creep one blob at a time past the cap; `loopStoredBytesExcludingHash`
  does the same for the `putBlob` re-check base); `sync()` tracks a projected footprint
  and, when accepting a file's NEW bytes (a hash the server doesn't already have — dedup
  reuse adds none) would exceed `LOOPANY_LOOP_BYTES_CAP` (default **500MB**), rejects THAT
  file (skips its bytes + row, NOT tombstoned — prior version kept) and surfaces
  `{capExceeded, bytesUsed, bytesCap, rejected:[paths]}` on the sync response (mirrors the
  per-file 10MB oversize signal); existing files + deletions still reconcile so the loop
  never wedges. The cap counts only NET growth: when a manifest path overwrites an existing
  live, byte-backed row, that row's currently-counted size is subtracted (the upsert frees it)
  before the new bytes are added, so a loop regenerating one large file IN PLACE (the
  running-memory model) never falsely trips the cap — only new paths / genuine size increases
  count. The freed credit uses the **VERIFIED** stored length (`blobs.size`, the same basis
  `loopStoredBytes` counts; the client-reported size only for a pending row) - an over-reported
  prior size must not mint free headroom - and an inline file's row records the verified inline
  byte length over the client-reported size; `sync()` reads those prior sizes from ONE upfront
  `store.liveArtifactSizes(loopId)` map (the same `artifact_files ⋈ blobs` join), not per-file
  point queries. The cap is enforced in **two places** so a
  client-reported size can't bypass
  it: in `sync()` a non-inline file with a missing/invalid size is sized at `BLOB_CAP` (10MB,
  conservative — never `0`, which would slip past the projected-footprint check) instead of
  trusting the client; and authoritatively at **`putBlob`**, which
  re-checks a NEW blob's REAL byte length against every loop that already references the hash
  (`store.loopsReferencingHash` × `store.loopStoredBytesExcludingHash`) and, if storing would
  exceed a loop's cap, refuses the bytes (413 `capExceeded`) and drops that loop's dangling
  rows (`store.dropArtifactFilesForHash`) so nothing points at a blob never stored — a later
  sync re-reconciles (self-healing). `putBlob` is also **handshake-gated**
  (`store.machineReferencesBlob`): it accepts ONLY a hash the sync handshake actually asked THIS
  machine for - i.e. a hash a live `artifact_files` row on one of its loops points at (the row
  sync wrote when it returned the hash in `needHashes`); any other PUT gets a flat 403, so a
  device token can't be used as an uncapped R2 write channel (a re-PUT of a still-referenced hash
  stays accepted - daemon retries are idempotent). And `store.deleteLoop` **cascades** the loop's
  `runs`/`artifact_files`/`run_snapshots` rows - leftover rows would pin the loop's blob hashes in
  the GC keep-set forever; the bytes fall out on the next periodic GC pass once nothing references
  them. **When GC runs:** a dedicated `boot.ts` interval (`gcIntervalMs`, default
  **15min**, independent of the faster offline-sweep) calls `gateway.maintainStorage()`
  (prune snapshots → GC blobs; best-effort, never throws). `maintainStorage` holds an
  **in-flight latch** (`maintenanceRunning`, released in `finally`) so a first-backlog pass
  that overruns the interval makes the next tick skip rather than run a second pass
  concurrently (the GC awaits blob deletes sequentially; overlap is idempotent but wastes
  work and double-counts). All knobs are lazy env reads
  (`env.ts`) so tests set them per-case. Tests: `gateway/retention.test.ts`.
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
  no longer emits `agent:`; `bootstrap.md` (the first-capture doc, formerly `SKILL.md`'s
  pasted-values section) tells the agent to self-declare via `--agent`. The
  recorded agent is now driven purely by daemon self-detection, and the "Loop created"
  confirmation shows the **measured** `loops.agent` (threaded back via `ClaimResult.agent`
  → `claimStatus`), never a pre-selected value. **The paste snippet is one line** —
  `Fetch <origin>/api/skill and help me build a loop.` — plus the read-only config
  (`server-url`/`connect-key`/optional `loopany-cli`). The old pre-filled task + schedule
  inputs (`EditableChip`s baked into a multi-clause "build a loop for the thing you did
  above … each time" instruction) were removed: ALL loop-building intelligence lives in the
  skill (it asks what to build when the session is empty, and **proposes-then-confirms** a
  sensible cadence + per-run output format whenever the user left them loose — it never
  silently guesses; see `create.md` §0/§0.5), so the snippet is a dumb bootstrap with
  nothing to mis-prefill. The claim/
  connect-key binding stays so a created loop still resolves back to the dialog. Execution-path copy that
  truly means Claude (run-now, edit-via-Claude-Code in `LoopDetailView`) stays "Claude"
  on purpose — that IS what runs. Daemon now has vitest (`create.test.ts`) for the
  detector/precedence; server tests cover createLoop persistence + adapter mapping.
- **CI/CD (`.github/workflows/`).** Two GitHub Actions workflows, deliberately split by
  trigger/cadence/blast-radius (they share nothing but the repo). **`deploy.yml`** — server
  → Fly (`loopany-testing`): fires on **push to `main`** (with `paths-ignore` for
  `packages/daemon/**` plus the EXPLICIT doc paths `README.md`/`AGENTS.md`/`CLAUDE.md`/
  `CONTRIBUTING.md`/`docs/**` - deliberately NOT a wholesale `**/*.md`: the skill/prompt markdown
  under `packages/server/src/skill/` is compiled INTO the server bundle via `?raw` imports, so a
  prompt-only md edit MUST deploy; paths-ignore has no negation, hence the explicit list, and
  entries are OR'd - a push is skipped only when EVERY changed file matches one) **plus
  `workflow_dispatch`**; a `fly-deploy`
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
- **Machine-surface + loopApi hardening (`server/machineFns.ts`, `server/loopApi.ts`,
  `auth.ts`).** The unauthenticated **`/api/admin` route is DELETED** -
  `scripts/demo-cookie-unified.sh` now seeds through the AUTHENTICATED device-token surface the
  daemon itself uses (poll self-register → `POST /api/machine/loop` → read back via
  `GET /api/machine/log`) and sets `LOOPANY_HOME` to a temp dir so the demo daemon never clobbers
  the real `~/.loopany` identity. Machine server fns are scoped via the pure `machineInScope()`
  predicate (requester owns the machine, OR its owner shares the active team, OR admin "All
  teams"; open mode sees everything) - it lives in the framework-free `server/machineScope.ts`
  (re-exported by `machineFns.ts`; tested with plain imports, no DB) and takes the team-id set as
  a LAZY thunk, so the owner fast path (the ~2.5s connect-dialog `machineStatus` poll) never pays
  the `listMachinesForTeam` join. `machineStatus`/`finalizeMachine`/`deleteMachine` share the
  `scopedMachine(id)` guard (mirrors `ownedLoop`), and `createMachine` refuses a signed-out
  caller under the gate. The PLAINTEXT
  device token is serialized **OWNER-ONLY** under the gate (`tokenVisibleTo()`, used by both
  `listMachines` and `machineStatus`) - the token fully impersonates the machine (poll /
  create-loop / log), so a teammate/admin who may see or delete the row still gets `token: null`.
  `auth.ts` **THROWS at boot** when the GitHub gate is on (GITHUB_CLIENT_ID/SECRET present) but
  `LOOPANY_AUTH_SECRET` is unset - falling back to the public dev secret would let anyone forge
  sessions. **Deployment precondition: set the `LOOPANY_AUTH_SECRET` Fly secret before deploying
  with the gate on.** On the loopApi side: `createJob` refuses the admin All-teams view
  (`pick a specific team`, mirroring `mintClaim`'s fail-safe), `patchJob` validates a `channelId`
  against the LOOP's own team (`owned.loop.teamId`, not the requester's active team), and
  `getTranscript` calls `backend()` like every other server fn.
- **Loop detail is a PAGE, not a modal (`/loops/$loopId`).** The old dashboard
  modal (`JobDetailView` + `RunView` inside `Modal`) was retired for dedicated
  routes. `routes/loops.$loopId.tsx` → `components/LoopDetailView.tsx` (the loop
  page body: a header card with name/cron/next/agent/machine-status/id + the action
  toolbar [Run once / Edit / ··· menu], an optional agent-authored `LoopView`
  dashboard, then a 2-col grid of the **unified Files panel** and the **Runs**
  section). The dashboard (`routes/index.tsx`) + `LoopCard` now **navigate**
  (`useNavigate`) instead of `setView` — no more `Modal` for detail. The dashboard's
  in-page refresh is **fetch-then-set** (never `router.invalidate`, whose loader re-run
  throws on a transient blip - stale data is kept instead), with an `errorComponent`
  catching only the initial loader; `TeamSwitcher` refetches via an `onSwitch` prop
  instead of `router.invalidate`. The page owns
  its own `getJobDetail` fetch + self-poll (3s while a run is live, else 8s; ssr:false
  so the session cookie rides along), same cadence as the old modal; a poll SUCCESS
  clears a stale `err` and the fatal-error screen carries a **Retry** button, so a
  transient first-load failure no longer bricks the page. The edit paths
  (hand-to-Claude-Code via `requestEdit`; manual `LoopForm` fallback) survive as
  in-page mode takeovers; `traceFetched` resets per edit dispatch, so each fresh
  hand-to-Claude edit fetches its own settled transcript. Reconnect opens `MachinesModal` rendered on the page itself.
  **`loops.agent` is surfaced as a quiet chip** beside the title status pills (not the
  meta row). **Edit modes use a bare-page `EditHead`, NEVER `ModalHead`:** `ModalHead`
  renders Base UI `Dialog.Title`/`Dialog.Close`, which call `useDialogRootContext()`
  and throw (`Cannot destructure property 'store' of 'useDialogRootContext(...)'`)
  with no `Dialog.Root` ancestor — the original modal flow wrapped them in `<Modal>`,
  the page does not, so any `Dialog.*` part rendered directly on the page crashes the
  view on first click (`loopDetailEdit.regression.test.ts` guards this). **Layout: the
  content viewer is the star** — the main grid is `lg:grid-cols-[minmax(0,1fr)_minmax(
  300px,360px)]` (files panel bulk, runs a capped rail) inside a `max-w-[1360px]` shell
  (run page also `max-w-[1360px]`). The hard rule against page-level horizontal scroll:
  `min-w-0` on every grid/flex child + contain wide content in its own pane — the
  agent-authored dashboard (`LoopView`) is wrapped in `overflow-x-auto` (a too-wide
  card row scrolls inside the dashboard box, a responsive auto-fit grid wraps), and
  `.taskmd table` is a `display:block; width:max-content; max-width:100%; overflow-x:
  auto` block so a wide markdown table scrolls inside the viewer, never widening the
  page / shoving the runs rail off-screen. Same rule for the **runs timeline strip**
  (`components/Timeline.tsx`): its root flex row is `min-w-0 overflow-x-auto` because a
  full `WINDOW` of fixed-width (`shrink-0`) cube blocks + the next-run marker is wider
  than the ~320px runs rail — unbounded they painted past the card's right edge and
  forced a page-level horizontal scrollbar (`timelineWidth.regression.test.ts` guards
  this). Contain on the ROW, not the blocks (blocks stay `shrink-0`); tooltips/pagers
  are unaffected (popups portal out, the `+N` pagers still page the window).
- **Unified Files panel (`components/LoopFilesPanel.tsx`).** Merges the former
  separate task-file box + `FilesView` (both DELETED) into ONE master-detail: a file
  list (task file pinned first with a `TASK` chip, then synced artifacts path-sorted)
  drives a content viewer; the **task file is selected by default**. Reuses the Phase
  2 server fns — `getArtifacts` (self-polls by loopId) for the list, `getArtifact`
  for text bodies; markdown (task file + `*.md`) renders via `TaskFileView` (bare by
  design - no own inset/scroll, the host owns the surface; the interim `bare` prop is
  gone, bare is the only render mode), other text in a mono
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
  here. **The page mirrors the loop detail page's design language** (the modal-era
  chrome — `ModalSection`, raw `<pre>` blobs, `[ Loading ]`/`[ ERROR ]` brackets,
  the 1040px single column — was retired): the route shell is now `max-w-[1360px]`
  (was 1040) and the body is a header card (`rounded-2xl border-wire bg-surface`
  with name/timestamp + `StatusPill` + wire-outline mono chips + an action toolbar
  in a `border-t border-hairline` footer) over the same **two-column grid the loop
  page uses** (`lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]`): the meaty
  content (Report → Changes → Control → Execution) fills the wide `minmax(0,1fr)`
  column, run metadata sits in a capped right rail (`Card label="details"` stacked
  `Field`s). Sections are the loop page's `Card`/label style (local `Card` helper,
  NOT `ModalSection`). The no-page-scroll rule is enforced structurally: `min-w-0`
  on every grid/flex child and every `Card`, wide inner content scrolls inside its
  own pane (`runDetailWidth.regression.test.ts` guards the shell width + grid +
  card `min-w-0` + diff-pane containment + the absence of the bracket placeholders).
  **Two headline pieces are extracted as reusable presentational components fed by
  pure, unit-tested helpers:** (1) **`components/DiffView.tsx`** renders
  `RunDiffFile[]` as a COLORED diff — `lib/diff.ts` `parseUnifiedDiff()` classifies
  each physical line (add/del/hunk/meta/context; `+++`/`---` headers are NOT
  mis-read as add/del) and the view tints each line (add=green, del=red via the new
  `--color-diff-{add,del}-bg` + `--color-diff-hunk-bg` tokens in `app.css`,
  light/dark alphas) with a `+`/`-`/` ` gutter and a `+N −M` per-file stat; files
  are collapsible (`<details>`, small diffs `open` by default, `AUTO_OPEN_LINES=40`),
  and long lines DON'T wrap — the capped-height pane (`max-h-[420px] overflow-auto`,
  `whitespace-pre` inside a `min-w-max` track) scrolls them horizontally. Binary/
  oversize/too-large files render just the header row (reusing `STATUS_LABEL`/
  `STATUS_CLS`). NO external diff library. (2) **`components/TranscriptView.tsx`**
  renders `TranscriptStep[]` as a STRUCTURED timeline (left `border-l` rail +
  per-turn markers): **assistant text renders as markdown** (via the shared
  `lib/markdown.ts` `renderMarkdown` = the marked-GFM→DOMPurify pipeline +
  `MD_SANITIZE` allowlist EXTRACTED from `TaskFileView` so the two markdown
  surfaces can't drift; output styled with `.taskmd`), tool steps collapse to a
  **one-line summary** (name chip + the key argument surfaced by the pure, tested
  `summarizeTool(input)` — Read→`file_path`, Bash→`command`, … via `SUMMARY_KEYS`;
  the raw `input` JSON is `forceCollapse`d behind a `<details>` so trivial calls
  stay one line), and `result` steps attach under their owner (no redundant
  "RESULT" label; short/informative outputs inline, long ones collapse). Each
  turn's marker cycles the `--color-chart-1..5` ramp (the SAME `TURN_COLORS` as
  `LoopChart`'s STROKES) — color as a small icon accent for rhythm/scannability,
  never a filled block, and the run's error state still reads via the StatusPill,
  not these decorative markers. `lib/transcript.ts` `groupTranscript()` (pure,
  tested) folds the flat `result`-follows-owner stream into
  `{kind,text|name+input,results[]}` items (a leading orphan result is surfaced,
  never dropped); payloads over `COLLAPSE_OVER` chars collapse behind a
  `<details>`. Long tool args/paths truncate (`truncate`, full value in `title`)
  so there's no horizontal overflow at any width. Tests: `lib/transcript.test.ts`
  (summarizeTool), `lib/markdown.test.ts` (sanitize), `components/TranscriptView.test.ts`
  (markdown render + compact summary + no RESULT label + color ramp).
  `formatTranscript` (the old flat-text renderer in `lib/format.ts`) is retained —
  still used by `LoopDetailView`'s edit-watch panel — but the run page no longer calls it.

## Commands

- `pnpm dev` — server on :3000 (UI + scheduler + machine routes).
- `pnpm -r typecheck` · `pnpm --filter @loopany/server test`.
- `pnpm --filter @loopany/server db:generate` / `db:migrate`.
- `bash scripts/demo-cookie-unified.sh` — Cookie loop e2e through the unified server.

## Verified e2e

The **Cookie Daily Breakfast Report** loop runs end-to-end: scheduler → daemon poll → claude →
`loopany report` → run `done` (real breakfast report). Dashboard renders real data
(browser-verified, Geist style). 192 server tests + 147 daemon tests green; both packages typecheck.
