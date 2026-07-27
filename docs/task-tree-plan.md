# Task tree — design + implementation plan

> Status: **implemented** (2026-07-03; rebased onto the Postgres/CliGateway main 2026-07-13).
> Unifies loopany's loops with a worknode-style task tree: every task is a folder;
> a loop is just a task with `cron` set. Five phases, each an independently
> shippable PR. Phase progress is tracked by checking off the phase headings below.

- [x] Phase 1 — Storage foundation (server) — done 2026-07-03: migration `0003` pg (cron nullable + jsonb task_meta; originally SQLite `0019`, regenerated for the Postgres tier on rebase), `taskMeta()` parser, updateLoop/createLoop derivation, scheduler cron-null guard, gateway createLoop/editLoop/sync/report changes + done-pauses invariant, cron-null sweep (adapters/types/cronText/LoopForm). 17 new tests.
- [x] Phase 2 — Server task API — done 2026-07-03: shared `server/taskTree.ts` builder (tree/flat/breadcrumbs/cycle-guard), gateway taskList/taskGet/taskSearch/runLoopNow + resolveTask (slug|id, 409 on collision), createLoop slug idempotency (`existing: true`), run-token `done` alias + task subset (get/search/list/create/update, delete teaches archived; create can't arm cron, update rejects work-state keys), routes `api.machine.task.ts` + `api.machine.loop.run.ts`. Also fixed a real parseFlags bug: `---`-fenced README content inlined via --file-content parsed as a flag and silently dropped. 23 new tests.
- [x] Phase 3 — Daemon CLI new grammar — done 2026-07-03: `taskfile.ts` (scaffold/patchFrontmatter/appendTimeline/slugify, byte-preserving), `tasks.ts` (create/get/list/search/update/mv/run with LogDeps-style seams; file-first create; review-needs-date + done-pauses enforced client-side; fractional-order mv; run --wait), `agent-context.ts`, `daemon-cli.ts` group, cli.ts rewired (canonical verbs + deprecated aliases + update disambiguation + delete teaching error), help.ts rewritten, watcher inlines `taskFile:{path,content}` per sync. Fixed demo-cookie-unified.sh (pre-existing break: still POSTed the removed `task` column) — e2e passes with a real claude run. 28 new tests.
- [x] Phase 4 — Web Tasks page — done 2026-07-03: `routes/tasks.tsx` (auth-gated, fetch-then-set poll), `components/TaskTree.tsx` (client-side tree via the SHARED builder; status/priority/type chips, ⟳/⏰ badges, untyped-loops trailing group; machine paths projected out of the team payload), `listTasks` server fn, Tasks↔Dashboard header links, width regression test. Smoke: /tasks 200 on dev server.
- [x] Phase 5 — Skill prose + deprecation copy — done 2026-07-03: SKILL.md reframed (task tree; loop = task with cron; three standing rules), create.md rewritten around `loopany create` + envelope (`claim`/`agent` ride the envelope on first capture), update.md rewritten around `update k=v`/`mv`/`run`/`get --runs`, evolve.md light touches, run prompts renamed `report`→`done` (server alias keeps `report` working) + task-tree §3 added to exec-loop.md, bootstrap.md → `daemon up`. Tests updated (prompt/bootstrap/references). REMINDER: this phase must DEPLOY (?raw-bundled md) and needs a daemon npm release to refresh the bundled public skill.

## Context

Loopany today is loop-first: a "loop" is a scheduled agent job with a folder (README task file + artifacts). An earlier private worknode prototype proved a complementary model: a tree of markdown task nodes (goal → strategy → experiment/task) with a status lifecycle, priorities, `parent:` hierarchy, timelines, and a review/follow-up discipline — maintained by agents.

The two systems independently converged on the same node structure (`## Spec` / `## Current understanding` / `## Timeline` in loopany; body + `## Timeline` in worknode). This plan unifies them: **every task is a folder; a loop is just a task with `cron` set.** The task tree becomes the primary UI; the scheduler becomes a property of a task.

Scope decided with the user:
- **Full stack in one plan**: folder convention + CLI + server indexing + machine API + web Tasks tab.
- **Verb renames now** (canonical grammar; old verbs = deprecated aliases for one release).
- **Tree home**: flat folders `~/loopany/<slug>/` — the SAME location loops use today (no `tasks/` intermediate level; user challenged it and it serves no purpose here — existing loop folders are already in place and just gain frontmatter). Works because loop folders are server-sent paths, not a hardcoded convention.

## Settled product design (agreed over the conversation)

1. **Task = folder** `~/loopany/<slug>/README.md` + artifacts beside it (same convention as today's loop folders — no separate `tasks/` level). Frontmatter: `id, title, type(goal|strategy|experiment|task|idea), status(idea|todo|in-progress|review|done|archived), priority(P0-P3), owner, parent, refs, follow_up_date, order`. Body keeps `## Spec` / `## Current understanding` / `## Timeline`. Hierarchy from `parent:` (folders flat on disk); ids are slugs, never paths.
2. **Recurrence is a field**: `cron` set → scheduled; null → inert data. One cron per task max.
3. **Storage**: every task gets a `loops` row (`cron` becomes nullable). File = source of truth for work-state; server parses frontmatter at the existing `taskFileContent` ingress into a new `loops.taskMeta` JSON column (mirror of `blobs.meta` pattern). Tree queries = rows + taskMeta. Scheduler skips cron-null rows.
4. **CLI grammar** (7 object verbs + machinery):
   - `create "<title>" --parent <id> [--type T] [-p Px] [--status] [--body] [--json '<envelope>']` — scaffolds the folder; idempotent on slug; fuzzy-dup warns unless `--force`.
   - `get <id> [--runs [--limit N]] [--transcript]` — full node + immediate children rows (cap 10 + hint).
   - `list [<id>] [--status|--priority|--due|--recurring] [--tree|--flat] [--depth N]` — no filters → tree depth 2; filtered → flat rows with breadcrumb paths.
   - `search <keywords>` — full-text over bodies/titles.
   - `update <id> k=v … [--note "<timeline line>"] [--workflow-file|--ui-file|--schema-file]` — fields incl. cron/goal/notify; `--note` appends dated Timeline line.
   - `mv <id> --before|--after <sib> | --top|--bottom | --priority Px`.
   - `run <id> [--wait]` — one-shot dispatch on any task (needs new device-token run-now route).
   - Machinery: `daemon up|down|status|update`, `skill …`, `agent-context`.
   - Aliases (one release): new→create, edit→update, loops→list --recurring, log→get --runs, up/down/status→daemon.
5. **Hard invariants** (errors, not prose): `status=review` requires `follow_up_date`; `status=done|archived` pauses a recurring task's schedule; no `delete` (error teaches `status=archived`); errors enumerate valid values; `--json` everywhere; `--dry-run` on writes; bounded output + truncation hints.
6. **Write channels**: in-run Timeline = agent edits README directly (existing exec-loop discipline — keep); out-of-run = `update --note`. `report --message` stays run-row/notification only (rename `report`→`done` in run prompts, keep alias). Run-token task subset: `create/update/get/search` — no `mv`, no cron-setting from exec runs.
7. **Web UI**: "Tasks" page — team task tree from rows+taskMeta (status/priority chips, ⟳ recurring, ⏰ due), linking into existing `/loops/$loopId` pages.
8. **Skill prose**: teach the grammar + worknode rules (capture-after-planning, update+timeline, hierarchy, review-needs-date) across the 8 skill files; respect sync-skill whitelist.

## Key codebase facts (explored, verified)

- Daemon: `cli.ts:39-85` verb dispatch (lazy imports, exit codes 0/1/2); device token `config.ts:15-17`; CLI verbs use injectable plain `fetch`; endpoints `POST/GET/PATCH /api/machine/loop`, `GET /api/machine/log`. Loop folder = server-sent (`loopdir.ts:26-36`); watcher per-loop from server watch list (`watcher.ts:370`); `LOOPANY_ROOTS` jail applies. Test pattern: deps-seam objects (`log.ts:54-78`, `log.test.ts`).
- Server: `frontmatter.ts` bounded never-throw parser (`artifactMeta` narrows to {type,title,date}); `blobs.meta` JSON column — widening needs no migration. `EDITABLE_LOOP_FIELDS` `gateway/index.ts:57-71`; createLoop `:414`, editLoop `:655`, shared validators `:1541+`. `loops.cron` notNull (`schema.ts:137`) → needs migration to nullable. `store.updateLoop` chokepoint `store.ts:123-138`. Scheduler `runNow` exists (`scheduler/index.ts:75`) but has NO machine route (only web `loopApi.ts:286`). Run-token verb dispatch `gateway/index.ts:1339-1430` + `MUTATION_VERBS :1678` + capability-gated `helpText :1435`.
- UI: file-based routes auto-register; no shared nav (headers inline, `index.tsx:136-166`); `LoopFilesPanel` + `lib/fileEntries.ts` handle README-special-treatment + meta chips.

## Design frictions found (and their resolutions, baked into phases)

- **A. Tree-data staleness**: `taskFileContent` only reaches the server at run `report()` time (gateway/index.ts:891-922); the chokidar sync path never touches it. A cron-null task never runs → its tree data would go permanently stale. **Fix**: derive `taskMeta` centrally in `store.updateLoop` whenever a patch carries `taskFileContent` (mirrors the goal/completedAt invariant handling at store.ts:123-138), and add an optional `taskFile: {path, content}` field to the daemon's sync POST that the server ingests via `updateLoop`. Old daemons simply don't send it — graceful skew.
- **B. Slug is NOT the primary key**: `loops.id` stays opaque (`loop-<ts>-<uuid8>`); the slug lives in README frontmatter `id:` (→ `taskMeta.id`) and is the folder name. Uniqueness enforced per-machine at create; every CLI verb resolves slug→loop within the machine's loops. Avoids cross-team collisions / cross-tenant "exists" leaks.
- **C. Cross-machine trees**: device-token surfaces are machine-scoped (existing security posture). v1 CLI tree = this machine's tasks; the web Tasks page = team-scoped read view. Cross-scope verbs → the same flat 404 the codebase already teaches.
- **D. `update` verb collision** with existing `loopany update` (daemon self-update): `update` with zero positional args = deprecated alias for `daemon update`; `update <id> …` = task update. Canonical machinery verb = `daemon update`.
- Minor: `loops.cron` going nullable ripples through typed consumers (scheduler, adapters.ts, loopApi, LoopCard/LoopDetailView/LoopForm, main.ts) — mechanical `?? null` sweep; `pnpm -r typecheck` is the canary.

## Implementation phases (each independently shippable, typecheck/test-green)

### Phase 1 — Storage foundation (server-only PR; zero behavior change for existing loops)

- `db/schema.ts`: drop `.notNull()` from `cron` (:137); add `taskMeta: text("task_meta", {mode:"json"}).$type<TaskMeta>()` (mirror of blobs.meta :309); export `TaskMeta` + enums (type/status/priority).
- Migration: `db:generate` + `db:migrate` immediately (CLAUDE.md rule). NOT-NULL drop = SQLite table rebuild — **rehearse on a copy of the dev/prod DB before merging**. No backfill (`taskMeta` starts null, like blobs.meta in 0018).
- `server/frontmatter.ts`: add `taskMeta(content)` beside `artifactMeta` (:101) — narrows to `{id,title,type,status,priority,owner,parent,refs,follow_up_date,order}`; forgiving (never throws, invalid enums dropped, order→finite number, refs split on commas). Enforcement lives on write surfaces, never in the parser.
- `db/store.ts` `updateLoop` (:123): when patch carries `taskFileContent`, derive `taskMeta` in the same write. Also derive at `createLoop`.
- `scheduler/index.ts` `schedule()` (:146): early-return when `!loop.cron` (still arm `nextRunAt` so run-now works on cron-null tasks).
- `gateway/index.ts`:
  - `createLoop` (:414): cron optional (validate only when present); require `taskFile` when cron absent; skip `runNow` (:565) when cron null; accept optional inline `taskFileContent` (clip WIRE_TEXT_CAP).
  - `editLoop`/`buildEditUpdate` (:765): `cron: null` explicitly allowed = disarm.
  - `sync()` (:1088): accept optional `taskFile: {path, content}`; verify path matches the loop's task file; `updateLoop({taskFileContent, taskFileSyncedAt})`.
  - Invariant hook: after any taskFileContent write, if derived `status ∈ {done, archived}` and loop is recurring+enabled → `enabled:false` + `scheduler.removeLoop` (gateway owns this; it holds the scheduler).
- Cron-nullability sweep: `server/adapters.ts` (:20/:71/:92), `server/loopApi.ts` (web createJob still requires cron), `main.ts`, `LoopCard/LoopDetailView/LoopForm` (render "manual" when null).
- Tests: frontmatter taskMeta narrowing; updateLoop derivation + done-pauses invariant; scheduler never schedules cron-null but runNow fires it; sync taskFile ingestion + path-mismatch rejection; createLoop no-cron+no-taskFile → 400 teaching message.

### Phase 2 — Server API surface (server-only PR)

- `gateway/index.ts` new device-token methods (auth template = `loopLog` :607, flat 404 cross-scope):
  - `taskList(deviceToken, {id?, status?, priority?, due?, recurring?, flat?, depth?})` — pure in-memory tree from `taskMeta.parent` slug refs; unfiltered → tree depth 2; filtered → flat rows with breadcrumb ancestor paths; **cycle-guard** (visited set — hand-edited parent cycles render as roots, never hang). Project rows — never return full taskFileContent per row.
  - `taskGet(deviceToken, idOrSlug, {runs?, limit?, transcript?})` — full node + immediate-children rows capped 10 (`childrenTruncated` hint); `runs` reuses loopLog internals.
  - `taskSearch(deviceToken, keywords)` — case-insensitive over title/slug/taskFileContent, bounded rows + snippet.
  - `runLoopNow(deviceToken, idOrSlug)` — scoping check → `scheduler.runNow`; refuse when an open run exists (message, not silent no-op). Fills the gap: no machine run-now route exists today.
  - `resolveTask(machineId, idOrSlug)` — exact loops.id, else unique `taskMeta.id` match; ambiguous → 409 listing candidates.
  - `createLoop` idempotency: body `slug` matching an existing machine task → return existing envelope with `existing: true` (200).
  - Run-token dispatch (:1339): `case "done"` alias → falls through to `report` (:1351) — server-side alias IS the whole rename (callback.ts forwards argv verbatim); keep `report` working. Add task-subset verbs (accept BOTH bare `create/update/get/search` and namespaced `task-*` spellings — agents will type the bare ones). Scope via `slot.machineId`. NO `mv`; task-update rejects `cron` (no cron-setting from exec runs). Update capability-gated `helpText` (:1435).
  - `validateTaskPatch` shared validator (device-token update + run-token task-update use the SAME one — the repo's two-surfaces-cannot-drift pattern): enums with enumerated-values errors; `review` requires `follow_up_date`; `done|archived` on recurring ⇒ also `enabled:false`.
- New routes: `routes/api.machine.task.ts` (GET list/get/search), `routes/api.machine.loop.run.ts` (POST run-now) — template = `api.machine.loop.ts`.
- Tests: tree assembly (depth/breadcrumbs/cycles/caps), slug resolution + ambiguity, idempotent create, run-token gating (`done` ≡ `report`; exec can task-create but not cron), runLoopNow scoping + open-run refusal.

### Phase 3 — Daemon CLI: new grammar + local scaffolding (daemon-only PR)

**Who writes the README scaffold: the CLI, locally** — `create` writes `~/loopany/<slug>/README.md` on the machine, THEN POSTs create with `taskFile` path + `slug` + inline initial `taskFileContent` (closes the ~3s sync gap). Rationale: file is source of truth; there is NO server→machine content channel (watcher is one-way up); the server-authoritative watch list picks the folder up on the next poll.

- New `src/tasks.ts` (+ tests): `runTaskCreate/Get/List/Search/Update/Mv/Run`, each with the `LogDeps`-style injectable seam (log.ts:54-78 pattern; log.test.ts/create.test.ts templates).
- New `src/taskfile.ts` (+ tests): pure README helpers — `scaffoldReadme` (frontmatter + `## Spec`/`## Current understanding`/`## Timeline`), `patchFrontmatter` (surgical, preserves unknown keys + body byte-for-byte), `appendTimeline` (dated + attributed), `slugify`. Parser paranoia = same fence-scan rules as server frontmatter.ts.
- New `src/agent-context.ts`: static CLI-versioned JSON of verbs/fields/enums/invariants (offline-correct).
- New `src/daemon-cli.ts`: `daemon up|down|status|update` group (thin re-exports of ensure/control/update).
- `src/cli.ts`: extend the if-chain (callback guard stays FIRST); add `create|get|list|search|mv|run|agent-context|daemon`; `update` disambiguation (friction D); deprecated aliases printing one stderr line then delegating: `new`→create, `edit`→update, `loops`→`list --recurring --flat`, `log`→`get --runs`, bare `up/down/status`→`daemon *`; `delete` matches only to print the teaching error (exit 2). Unknown-verb guard stays last.
- `src/watcher.ts`: include `taskFile: {path, content}` (clipped 512KB) in sync POST when the task file changed.
- `src/config.ts`: tasks root = `~/loopany` (same as today's loop folders — no `tasks/` level; `LOOPANY_TASKS_DIR` override). Docs note: `LOOPANY_ROOTS` must include it or the watcher refuses.
- Verb behaviors: `create` idempotent-if-identical, fuzzy-dup warn vs server taskList unless `--force`, on server failure leave folder + print retry (never orphan silently); `update` edits frontmatter LOCALLY, `--note` appends Timeline, envelope keys (cron/enabled/notify/…) split into a server PATCH, invariants enforced client-side with enumerated errors, content-file trio kept; `mv` = fractional `order` (midpoint insert, rewrite band only on gap collapse) so a move touches ONE file; `run --wait` polls run history bounded (~10min, heartbeat); every verb `--json`, writes `--dry-run`, bounded output + truncation hints.
- Version skew: new CLI vs old server → surface 404 as "server too old" (probe pattern in ensure.ts).
- Tests: per-verb seam tests; taskfile round-trips; cli dispatch test covering `update` disambiguation + every alias.

### Phase 4 — Web UI: Tasks page (server-only PR; needs only Phase 1)

- New `routes/tasks.tsx` — auto-registers at `/tasks`; header inline (copy index.tsx:136-166 pattern) + a `Dashboard ↔ Tasks` link pair added to BOTH pages (no new nav component this PR).
- New `components/TaskTree.tsx` (+ `taskTree.regression.test.ts`) — indented tree rows; breadcrumbs in flat mode; status/priority chips (reuse LoopFilesPanel chip styling); ⟳ when `cron != null`; ⏰ when `follow_up_date <= today`; row click → existing `/loops/$loopId`. `min-w-0` everywhere; titles truncate; regression test asserts no page-level horizontal scroll (repo hard rule).
- `server/loopApi.ts`: `listTasks` server fn (team-scoped via `requestScope`, like listJobs :100), projected rows. **Tree builder extracted to shared `server/taskTree.ts`** imported by both gateway and loopApi — CLI and web trees cannot drift.
- Read-only v1 (writes go through CLI/files — keeps file-as-source-of-truth honest). Legacy loops without taskMeta render in a trailing "Loops (untyped)" group — page useful day one, zero backfill. Refresh = fetch-then-set (never router.invalidate).

### Phase 5 — Skill prose + deprecation copy (server PR; MUST deploy; land after 2+3 are released)

- Edit sources under `packages/server/src/skill/` only (daemon/skill/ is generated):
  - `SKILL.md` + `references/create.md`: new grammar, folder-per-task, `parent:` hierarchy, capture-after-planning, review-needs-follow_up_date, "a loop is a task with cron", archived-not-deleted.
  - `references/update.md`: owner `update k=v` + `--note`; field/enum table mirroring agent-context.
  - `references/evolve.md`: task-tree awareness (doubles as evolve run prompt — keep self-consistent).
  - `run/exec-loop.md`: keep direct-README `## Timeline` discipline; introduce `done` (report stays alias); task-subset verbs; prohibitions (no mv, no cron from exec runs).
  - `run/edit.md`: run-token spellings only (stays separate from update.md per CLAUDE.md).
  - `bootstrap.md`: onboarding mentions tasks.
- Filenames unchanged → `sync-skill.mjs` whitelist needs NO edit (must never become recursive). `.md` compiles into the server bundle via `?raw` → this PR must deploy; also cut a daemon release to refresh the bundled public skill.
- Check `prompt.test.ts` for asserted `report` phrases.

## Sequencing

1 → 2 → 3 in order (schema → API → CLI). 4 needs only 1 and can run parallel to 2/3. 5 lands last, after 2+3 are deployed (old skill + `report`/old verbs keep working as aliases, so skew never breaks). A later release (not in this plan) removes the deprecated aliases. Follow-up candidates deliberately out of scope: bare-`.md` promotion form, profiles, `tasks/` path relocation (reversible — paths are server-sent, ids are slugs, blobs content-addressed), web-side task editing.

## Verification

- Per phase: `pnpm -r typecheck` + `pnpm --filter @loopany/server test` + `pnpm --filter @crewlet/loopany test` green; regression width tests green (Phase 4).
- Migration rehearsal (Phase 1): run the generated migration against a copy of the dev DB; confirm row preservation and that existing loops still schedule.
- End-to-end (after Phase 3): `bash scripts/demo-cookie-unified.sh` still passes (legacy path); then a manual E2E on a temp server — `loopany create "Test goal"` → folder scaffolded → appears in `list` as tree → `create` a child with `--parent` → `update <id> status=review follow_up_date=<date>` (verify the missing-date error first) → `update <id> cron="* * * * *"` → run fires → README Timeline entry appears → `update cron=null` disarms → `run <id> --wait` one-shot works → `/tasks` page renders the tree with ⟳/⏰ badges.

## v2 cloud-first — deferred doors

Recorded at the close of the v2 cloud-first plan
(`docs/plans/2026-07-24-001-feat-loopany-v2-cloud-first-plan.md`); each is a
deliberate non-goal of that plan, kept as a named door for follow-up work:

- Custom/persona agents: registry rows beyond auto-registration, per-agent
  `instructions` riding the delivery.
- Loop→agentId FK re-keying (the registry stays an addressing layer over the
  existing `(machineId, agent)` columns).
- Per-piece domain stage vocabulary (`scheduled`/`published` labels beyond the
  generic status enum).
- `loopany doc <ref>` $EDITOR sugar over the checkout/push cycle.
- Session-as-run tracking (`session start`); threaded comments/projection.
- Web write surfaces (the web stays read-only over fields/doc/events).
- CLI user login (device-code flow); cross-machine loop migration.
- `task_file_content` → `doc` column rename; front-matter → first-class field
  columns decoupling (the doc's front-matter block currently serializes the
  field plane — see the plan's U6 resolution note).
- Full server-side TOON rendering for the task verbs (list/get/search render
  daemon-side today; the AXI text-sink convergence is partial: fail-loud flags,
  truncation + --full, --fields, definitive empty states are in).
- Event retention/pruning policy; OpenCode session-hook target; SKILL.md
  generated from the home view with a CI staleness check.
