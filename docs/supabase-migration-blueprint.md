# Supabase Postgres Migration Blueprint

Authoritative, dependency-aware plan to migrate `packages/server` from synchronous
SQLite (better-sqlite3, `drizzle-orm/better-sqlite3`, `sqlite-core`) to Supabase
Postgres (async postgres-js, `drizzle-orm/postgres-js`, `pg-core`).

**Fixed decisions (from the human):** full Postgres conversion; new Fly app
`loopany-prod`; GitHub gate ON + allowlist; domain `loopany.ai`; blob BYTES stay on
R2 (only DB metadata rows move); the single-scheduler invariant (exactly one Fly
machine) is UNCHANGED.

---

## 1. Executive summary + pg dialect decisions

### What moves and what does not

- **DB engine:** SQLite file on a Fly volume → Supabase Postgres. New empty prod DB,
  so **no data migration / backfill** — the whole `packages/server/drizzle/` SQLite
  migration history (0000–0020) is retired and one squashed `0000` pg migration is
  generated from the final pg-core schema.
- **Storage bytes:** UNCHANGED. R2 keeps all blob bytes (`r2Config()` untouched); only
  the `blobs` / `artifact_files` **metadata rows** live in Postgres.
- **Container:** the HOSTED prod/staging container becomes STATELESS (external Supabase;
  Fly volume + `LOOPANY_DATA_DIR` disappear there). Local dev + light self-host stay
  file-backed via the embedded **pglite** default (see the tiering note below).
- **Blast radius:** driver/config swap is tiny and centralized (essentially
  `src/db/index.ts` + 3 one-liners), but making `store.ts` async ripples to **222 app
  call sites** (across 14 files) and **~462 test call sites** (across 9 files). The
  HTTP/server-fn boundary is ALREADY async everywhere, so the migration is INTERIOR.

### pg dialect decisions (the load-bearing choices)

| Decision | Choice | Why |
|---|---|---|
| Driver (hosted/scale) | `postgres` (postgres-js) via `drizzle-orm/postgres-js` | Pure-JS, no native build; matches Supabase guidance. Used when `DATABASE_URL` is set. |
| Driver (local/self-host default) | **pglite** (`@electric-sql/pglite`) via `drizzle-orm/pglite`, file-backed at `~/.loopany/pgdata` | **Confirmed decision.** Embedded, file-on-disk WASM Postgres — replaces better-sqlite3's "one file, zero external service" role. SAME pg-core schema + SAME migrations. `pnpm dev` + light self-host stay zero-config. Used when `DATABASE_URL` is UNSET. |
| Runtime connection (hosted) | **Transaction pooler `:6543`** (`DATABASE_URL`) with **`prepare: false`** | pgBouncer transaction mode reuses backends across statements; cached prepared statements break. `prepare:false` is NON-NEGOTIABLE. |
| Migration connection | **Direct `:5432` session mode** (`DIRECT_DATABASE_URL`), `max: 1` | The migrator takes an advisory lock and runs DDL — must NOT go through the transaction pooler. |
| SSL | `sslmode=require` (in the URL) or `{ ssl: 'require' }` | Supabase requires TLS. |
| Business timestamps | **Stay `text` (ISO strings)** | Already app-written ISO text; portable and dialect-neutral. NO `unixepoch`/`timestamp` conversion in `schema.ts`. |
| Auth timestamps | Regenerate as pg `timestamp` + `defaultNow()` | Only place with SQLite `unixepoch()` DB defaults (6 of them). Regenerate, do not hand-port. |
| Booleans | `integer({mode:'boolean'})` → `boolean()` | Direct mapping; `eq(col,true/false)` predicates keep working. |
| JSON columns | `text/integer({mode:'json'})` → `jsonb()` (keep `$type<>()`) | Canonical, indexable; drizzle (de)serializes identically, so `$inferSelect` types are unchanged. |
| Enum columns | Keep `text({enum})` — do NOT use `pgEnum` | TS-only in both dialects (no DB CHECK); preserves the "enum widening needs no migration" invariant. |
| `count(*)` / `sum(...)` | Wrap results in `Number(...)`, re-null-check | Postgres returns bigint/numeric which postgres-js surfaces as **string** (sum = `null` for zero rows). The `sql<number>` annotations are lies under pg. |
| `.run().changes` | `.returning({id})` then `.length` | better-sqlite3 `RunResult.changes` has no drizzle-postgres-js analog. |
| `insert().returning().get()` | `(await insert().returning())[0]` | RETURNING is native pg; `.get()` is a better-sqlite3 session method. |
| FKs | Keep business schema FK-free (convention-only); auth keeps its 2 cascade FKs | Under pg, FKs are always enforced (no PRAGMA gate) — auth cascades now fire at DB level. |

### DB deployment tiers (confirmed) — ONE dialect, three drivers

The codebase drops SQLite entirely, but keeps a **single pg-core schema + single migration
set** served by a driver picked at boot from env:

| Tier | Trigger | Driver | Store |
|---|---|---|---|
| Hosted prod/staging (`loopany-prod`, `loopany-testing`) | `DATABASE_URL` set | postgres-js (`:6543`, `prepare:false`) | Supabase |
| Local dev / light self-host | `DATABASE_URL` UNSET | **pglite**, file at `~/.loopany/pgdata` | on-disk |
| Unit tests | test env | pglite (in-process, per-file) | ephemeral |

- **`store.ts` is single-sourced** across all three — the drizzle query-builder API is
  identical; the generic `Db` type absorbs the driver. Only `db/index.ts` branches.
- **User-flow impact (confirmed scope):** BYOA end users (the `@crewlet/loopany` daemon)
  see **ZERO change** — the daemon never touches the server DB. Self-hosters/contributors
  keep a zero-config path via pglite (`pnpm dev` still "clone and run"); pointing at
  Supabase/any Postgres is opt-in via `DATABASE_URL`.
- **`loopany-testing` DB (confirmed): do NOT migrate the SQLite data.** It's disposable
  staging data, and starting `loopany-testing` on a FRESH empty Supabase project is the
  exact rehearsal for the prod cutover. Give testing its OWN Supabase project (separate
  from prod), deploy → migrations build empty tables, then detach/delete the old
  `loopany_data` Fly volume. Old R2 blobs go unreferenced (GC reclaims) or point testing
  at a fresh bucket/prefix; machines re-register, loops rebuild.

---

## 2. Ordered edit plan (independently-typecheckable batches)

The cascade order is: **schema + driver + config → `store.ts` async → callers by
module → tests + harness → deploy.** Because turning `store.ts` async breaks the type
of every caller at once, the intermediate batches will NOT fully typecheck until the
whole cascade lands; sequence them on ONE branch. Where a batch is self-contained and
touches a disjoint file set, it is tagged parallel-safe (a git worktree off the
schema/driver base).

> **Worktree rule of thumb:** anything downstream of `store.ts` going async cannot be
> merged independently (it won't typecheck against sync `store.ts`), so Batches 3–7
> are *authored* in parallel worktrees but must be *rebased/landed sequentially* on
> top of Batch 2. Batches 1–2 are the shared base and must land first.

### Batch 1 — Schema port (`pg-core`) + auth regeneration — SEQUENTIAL (foundation)
**Files:** `src/db/schema.ts`, `src/db/auth-schema.ts`
- `schema.ts`: swap imports to `drizzle-orm/pg-core` (`pgTable, text, integer,
  boolean, doublePrecision, jsonb, index, uniqueIndex`); rename every
  `sqliteTable(...)` → `pgTable(...)`; apply the type map in §3. Keep all indexes,
  especially `uniqueIndex artifact_files_loop_path_idx(loopId, path)`,
  `blobs.hash` PK, `run_snapshots.runId` PK (onConflict targets). Keep `text({enum})`.
- `auth-schema.ts`: **regenerate** via `npx @better-auth/cli generate` against the
  drizzle-**pg** provider (yields `timestamp` + `defaultNow()`, `boolean`, `text`,
  cascade FKs, uniques, 3 indexes); re-attach the hand-written `relations()` blocks.
- Must land first: everything else references these column types.

### Batch 2 — Driver + config + migration regeneration — SEQUENTIAL (foundation)
**Files:** `src/db/index.ts`, `drizzle.config.ts`, `src/env.ts`, `packages/server/package.json`, `packages/server/drizzle/**` (delete + regen)
- `index.ts`: **branch the driver on `DATABASE_URL` presence** (§1 tiering). Set →
  `postgres()` client (`prepare:false`, ssl) + `drizzle-orm/postgres-js`; unset →
  `PGlite(dataDir()/pgdata)` + `drizzle-orm/pglite` (the file-backed embedded default).
  Drop WAL/`foreign_keys` pragmas. `runMigrations()` becomes **async**: postgres-js path
  uses a SEPARATE direct-URL client (`max:1`, `.end()` after); pglite path migrates the
  in-process instance. Keep the singleton `globalThis` guard. Replace the raw `sqlite`
  export with the active client handle (rename to `sql`/`client`, test-only consumer).
- `drizzle.config.ts`: `dialect:'postgresql'`, `dbCredentials.url = DIRECT_DATABASE_URL`
  (config is for the drizzle-kit CLI = hosted migrations only; pglite migrates in-process).
- `env.ts`: add `databaseUrl()` (`:6543`, optional) + `directDatabaseUrl()` (`:5432`);
  KEEP `dataDir()` (now hosts `~/.loopany/pgdata` for the pglite tier); drop `dbPath()`
  after confirming no other file state uses it. `@electric-sql/pglite` is a dependency
  (not just devDependency) since it's the shipped local/self-host default.
- `package.json`: drop `better-sqlite3` + `@types/better-sqlite3`; add `postgres` +
  `@electric-sql/pglite` (dependency, not dev — it's the local/self-host default);
  keep `drizzle-orm ^0.45` / `drizzle-kit ^0.31`; commit regenerated `pnpm-lock.yaml`.
- Delete `drizzle/0000..0020*.sql` + `meta/`; regenerate ONE squashed pg `0000` via
  `db:generate` from the pg-core schema (post-0020 shape — no `task` column).
- Note: `runMigrations()` is now async → forces Batch 4 (boot) and the test harness.

### Batch 3 — `store.ts` async conversion — SEQUENTIAL (the cascade root)
**Files:** `src/db/store.ts` (1 file, 69 exports)
- Convert the ~64 DB-touching functions to `async` (see §4 for the exhaustive set +
  hard cases). Keep the 5 pure helpers sync. Apply the mechanical rewrites: `.get()`
  → `(await q)[0]`; `.all()` → `await q`; `.run()` → `await q`;
  `returning().get()` → `(await q.returning())[0]`; the 6 `.changes` sites →
  `.returning({id})` + `.length`; the 7 aggregate sites → `Number(...)` + null-recheck.
- Wrap multi-statement invariants (`deleteLoop` cascade, `ensureTeam`, `deleteChannel`,
  `updateLoop` read-modify-write) in `db.transaction(async tx => …)` (decision pending, §7).
- Single file → **can be authored in its own worktree**, but nothing downstream
  typechecks until it merges, so land it before Batches 4–5.

### Batch 4 — Boot + scheduler (async core) — SEQUENTIAL after Batch 3
**Files:** `src/server/boot.ts`, `src/scheduler/index.ts`
- `boot.ts`: `ensureServer()` becomes async; **cache the in-flight Promise** on
  `globalThis.__loopanyBooted` (NOT the resolved value) to preserve single-scheduler;
  `await runMigrations()`; timer `setInterval(sweep/maintainStorage)` stay
  `() => void gateway.X()`.
- `scheduler/index.ts` (24 store calls): all methods async; `runLoop` already async;
  keep timer callbacks `() => void this.runLoop(id)` / `() => void this.armNextRunAt(...)`;
  `finishEvolution`/`finishEdit`/`maybeFlagEvolve` (called unawaited from gateway.report
  today) must now be awaited.

### Batch 5 — Gateway + delivery + retention + notify — PARALLEL-CAPABLE (author in worktree; land after 4)
**Files:** `src/gateway/index.ts` (~124 store calls), `src/gateway/delivery.ts`, `src/gateway/retention.ts`, `src/gateway/notify.ts`
- Make all gateway methods async (`sweep`, `poll`, `report`, `createLoop`, `listLoops`,
  `editLoop`, `agentApi`, `cli`/`finalizeCli`, `describe`, `dispatch`, …); convert the
  `listLoops` inline `.map` (lastExecRun+countRuns) and `poll` delivery loop to
  `await Promise.all`/sequential awaits; `buildDelivery` async; retention for-loops gain
  awaits; `dispatchNotification` awaits `getChannel`. `report()` is the correctness-hot
  path — preserve ordering of the canceled-run / terminal-grace reconcile branches
  before any loop-level write.
- Disjoint from Batch 6 files → parallel worktree OK.

### Batch 6 — Server fns + adapters + routes + main + auth — PARALLEL-CAPABLE (author in worktree; land after 4)
**Files:** `src/server/adapters.ts`, `src/server/loopApi.ts`, `src/server/machineFns.ts`, `src/server/notifyFns.ts`, `src/server/runDiff.ts`, `src/server/artifactFiles.ts`, `src/routes/api.machine.*.ts`, `src/routes/agent-api.loop.ts`, `src/routes/machine.report.ts`, `src/routes/api.artifact.$loopId.$.ts`, `src/main.ts`, `src/auth.ts`
- `adapters.ts`: `toJobSummary`/`toJobDetail` async (keep the pure adapters sync).
- `loopApi.ts`: `backend()` → `await ensureServer()`; `listJobs` →
  `await Promise.all(...map(toJobSummary))`; await all store/scheduler calls.
- `machineFns.ts`: **hoist** the `teamMachineIds` await OUT of the `.filter` predicate
  into a pre-computed Set.
- `artifactFiles.ts`: flip `listLoopArtifacts` sync → async.
- routes: mechanical `const r = await getGateway().X(...)` + `await getGateway()`.
- `auth.ts`: `drizzleAdapter(db, { provider: 'pg' })`; await the store calls inside the
  already-async hooks; keep `teamIdForUser` sync (pure). (`loopInScope` was later
  renamed to the async `canAccessLoop`, which authorizes by team membership via a
  store lookup — no longer sync/pure.)
- `main.ts`: await all store calls; `listLoops().map(...lastRun)` → `Promise.all`.
- Depends on adapters + boot, so land after Batch 4; disjoint from Batch 5's files.

### Batch 7 — Test harness + tests — PARALLEL-CAPABLE (author in worktree; land last before deploy)
**Files:** `vitest.config.ts`, a NEW `test/dbHarness.ts` (recommended), the 9 DB-touching test files (see §5)
- Introduce pglite harness + async `reset()`; `await db.runMigrations()`; add `await`
  to all ~462 `store.*` sites; async `beforeEach`/`test` bodies; rewrite the 12 raw
  `db.sqlite.exec` sites (`INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, parameterized
  awaited statements); add ONE real-postgres-js smoke file as fidelity backstop.

### Batch 8 — Deploy / cutover — SEQUENTIAL (after all code + tests green)
**Files:** `fly.prod.toml` (new), `Dockerfile`, `.github/workflows/deploy.yml`, `README.md`, `.env.example`, Fly secrets, GitHub OAuth, certs/DNS. See §6.

### Landing summary

| # | Batch | Parallel? | Files |
|---|---|---|---|
| 1 | Schema port + auth regen | Sequential (base) | 2 |
| 2 | Driver + config + migration regen | Sequential (base) | ~5 (+ drizzle/ tree) |
| 3 | `store.ts` async | Sequential (root) | 1 |
| 4 | Boot + scheduler | Sequential after 3 | 2 |
| 5 | Gateway + delivery + retention + notify | Parallel worktree, land after 4 | 4 |
| 6 | Server fns + adapters + routes + main + auth | Parallel worktree, land after 4 | 12 |
| 7 | Test harness + tests | Parallel worktree, land last | ~11 |
| 8 | Deploy / cutover | Sequential final | ~6 |

**Total edit estimate:** ~30 non-test source files + ~11 test files; **~246 app call
sites (gateway/index.ts ~124) + ~462 test call sites (~708) gaining `await`**, plus 6
`.changes` ports, 7 aggregate coercions (5 truly string-returning — §4d), 12 raw-SQL
rewrites, 4 transaction wrappers, 21 migrations retired + 1 regenerated, and ~6 deploy
artifacts. Add `machineScope.ts` to the Batch-6 file set (§4e).

---

## 3. Column type-mapping table

### Business schema (`src/db/schema.ts`) — clean dialect swap, NO db-side defaults

| SQLite (sqlite-core) | Postgres (pg-core) | Applies to |
|---|---|---|
| `text` | `text` | all ids/names/ISO-timestamp text (lastSeen, createdAt, updatedAt, completedAt, nextRunAt, taskFileSyncedAt, runs.ts, cron, timezone, …) |
| `text(col,{enum})` | `text(col,{enum})` (NOT pgEnum) | loops.notify/agent, runs.phase/role/outcome/status, team_members.role, notification_channels.type |
| `integer({mode:'boolean'})` | `boolean()` | machines.online, loops.allowControl/enabled/evolveDue*, blobs.binary, artifact_files.binary/oversize/deleted |
| `text/integer({mode:'json'})` | `jsonb()` (keep `$type<>()`) | machines.roots, loops.stateSchema/state, runs.state/control/usage/artifacts/transcript/progress, notification_channels.config, blobs.meta, run_snapshots.manifest |
| `real` | `doublePrecision()` | runs.costUsd |
| `integer` (count) | `integer()` | runs.durationMs, blobs.size, artifact_files.size, loops.evolvedRunCount |

\* `loops.evolveDue` stays **NULLABLE** (`boolean()` with no `.notNull()`/`.default()`).
Boolean defaults port verbatim: `allowControl`/`enabled` default `true`;
`online`/`binary`/`oversize`/`deleted` default `false`. Enum defaults port verbatim
(`notify`='auto', `role`='member', `agent`='claude-code', …).

**Indexes/constraints that MUST survive verbatim:** `machines_user_idx`,
`machines_team_idx`, `loops_user_idx`, `loops_team_idx`, `loops_machine_idx`,
`runs_loop_idx`, `runs_phase_idx`, `runs_loop_ts_idx` (composite), `team_members_team_idx`,
`team_members_user_idx`, `notification_channels_team_idx`, `artifact_files_loop_idx`,
`artifact_files_hash_idx`, **`uniqueIndex artifact_files_loop_path_idx(loopId, path)`**
(onConflictDoUpdate target), `run_snapshots_loop_idx`, `blobs.hash` PK, `run_snapshots.runId` PK.

### Auth schema (`src/db/auth-schema.ts`) — REGENERATE, do not hand-port

| SQLite | Postgres (regenerated) | Applies to |
|---|---|---|
| `integer({mode:'timestamp_ms'})` + `sql\`(cast(unixepoch('subsecond')*1000 as integer))\`` default | `timestamp(...)` + `defaultNow()` (Date-typed either way) | user.createdAt/updatedAt, session.createdAt, account.createdAt, verification.createdAt/updatedAt (6 sites) |
| `integer({mode:'boolean'})` | `boolean('email_verified')` | user.emailVerified |
| `text` | `text` | ids/tokens/emails |

**Must survive regeneration:** `email` UNIQUE (user), `token` UNIQUE (session), the two
`onDelete:'cascade'` FKs (session.userId, account.userId → user.id), the 3 indexes
(`session_userId_idx`, `account_userId_idx`, `verification_identifier_idx`), the
asymmetry that session/account `updatedAt` have NO default (only `$onUpdate`).

---

## 4. Complete async-cascade set

### 4a. `store.ts` — the 5 that STAY sync (pure, DB-free)
`coerceStateSchema`, `coerceUi`, `canEvolve`, `newLoopId`, `teamIdForUser` (+ the
non-exported `nowIso`). `teamIdForUser` is a plain `team-${userId}` string on hot paths
(auth.requestScope, gateway.createLoop) — keeping it sync spares every caller an await.

### 4b. `store.ts` — the ~64 that BECOME async (grouped by rewrite pattern)

- **Single-row getters** (`.get()` → `(await q)[0]`): getLoop, getRun, lastRun,
  lastExecRun, getMachine, getTeam, getChannel, getRunSnapshot, getArtifactFile,
  prevRunSnapshot, lastEvolveAt (`?? null`).
- **Existence checks** (`!!(await q)[0]`): hasOpenRun, isTeamMember, blobExists,
  machineReferencesBlob, artifactFileReferencesHash.
- **List getters** (drop `.all()`, just `await`): listLoops, listEnabledLoops,
  loopsForMachine, openRuns, listMachines, listChannels, listArtifacts,
  listAllArtifactFiles; `.reverse()` moves after await → listRuns, listRunsBefore;
  `.map(r=>r.x)` after await → listMachinesForTeam, listTeamsForUser,
  loopIdsWithSnapshots, blobHashesOlderThan, loopsReferencingHash, listArtifactsWithMeta.
- **Insert-and-return** (`(await insert().returning())[0]`): createLoop, addRun,
  createMachine, createChannel.
- **Read-after-write** (await both): updateRun, updateMachine.
- **Void writers** (drop `.run()`): setMachineOnline, recordBlob (onConflictDoNothing),
  upsertArtifactFile (onConflictDoUpdate `[loopId,path]`), putRunSnapshot
  (onConflictDoUpdate `runId`), deleteBlob.
- **Set walkers** (await `.all()` before for-of): liveBlobRefs, snapshotBlobRefs.
- **Derived cross-callers** (await inner store call): defaultChannelId
  (`(await listChannels)[0]?.id`), buildLoopManifest (`for (const f of await listArtifacts)`).

### 4c. Hard case — `.run().changes` (6 sites, no drizzle-postgres-js analog)
Port each to `.returning({id:<pk>})` + `.length`:
- `deleteLoop` (142, 152) — plus 3-statement cascade → **wrap in transaction**.
- `deleteMachine` (325), `deleteChannel` (432, + detach-update first).
- `pruneRunSnapshots` (654), `dropArtifactFilesForHash` (781).
- NOTE `tombstoneMissingArtifacts` uses a MANUAL counter (not `.changes`) → safe, but
  issues N sequential awaited UPDATEs per ~1.5s sync flush — consider a single
  set-based `notInArray(path, keepPaths)` UPDATE.

### 4d. Hard case — count/sum string coercion (5 true string sites of 7 wrapped)
**(review gap, low — corrected)** postgres-js returns `bigint`/`numeric` as **string** but
`real`/`doublePrecision` and per-row `int4` as **number**. So the true string-returning
must-fix set is **5**: the three `count(*)` (countRuns, execFailureStreak,
countRunSnapshots) + the two `sum()`-over-INTEGER (loopStoredBytes, loopStoredBytesExcludingHash).
`sumRunCost` sums `costUsd` (doublePrecision) and `liveArtifactSizes` selects a per-row
int4 coalesce — both come back as numbers; the `Number(...)` wrap there is harmless but not
load-bearing. Still wrap all 7 with `Number(...)` + re-null-check for uniformity, but keep
`sumRunCost`'s real-null vs `'0'` distinction intact (empty-set sum is `null`).

### 4e. Hard case — `.map()`/`.filter()` callbacks embedding store reads
Each becomes `await Promise.all(arr.map(async …))` or a pre-hoisted await:
- `loopApi.listJobs` `.map(toJobSummary)`.
- `gateway.listLoops` inline `.map` (lastExecRun + countRuns).
- `gateway.poll` delivery for-loop (`await buildDelivery`).
- `main.ts:128` `.map(...lastRun)`.
- `machineFns` lazy team-id Set behind a `.filter` predicate → hoist the await out.
- **(review gap, medium) `gateway.putBlob` per-loop byte cap** `gateway/index.ts:1811-1813`:
  `store.loopsReferencingHash(hash).filter(l => store.loopStoredBytesExcludingHash(l,hash) + bytes.length > cap)`.
  Once `loopStoredBytesExcludingHash` is async the predicate does `Promise<number> + number`
  (TS2365 — typecheck catches it, but §4e was NOT exhaustive). This is the SECURITY-relevant
  R2-write-channel / per-loop cap guard → pre-compute:
  `const sizes = await Promise.all(loops.map(l => store.loopStoredBytesExcludingHash(l, hash)))`
  then filter on the resolved array.
- **(review gap, medium) `machineFns.toSummary` + `listMachines`** `machineFns.ts:57,70,85`:
  `toSummary` calls `store.loopsForMachine(m.id).length` → make it async; `listMachines`
  does `list.filter(...).map(m => toSummary(m, scope))` → `await Promise.all(...)`. Also
  `machineScope.ts` `machineInScope` consumes `teamMachineIds` as a SYNC
  `() => ReadonlySet` thunk — `scopedMachine` must PRE-await the Set and pass
  `() => resolvedSet` so `machineInScope` stays pure (this file was not in the Batch-6 list; add it).

### 4f. Hard case — `ensureServer()` Promise caching (single-scheduler)
`boot.ts` `ensureServer()` becomes async and MUST cache the in-flight **Promise** on
`globalThis.__loopanyBooted` (not the resolved `Booted`), else two concurrent
first-requests each run `runMigrations()` + `scheduler.start()` → double scheduler →
breaks the exactly-one-scheduler / no-double-fire invariant.
- **(review gap, medium) enumerate EVERY bare `ensureServer()` call site.**
  `getGateway()`/`getScheduler()` (`return ensureServer().gateway`) also become async.
  Bare unawaited callers on a cold process can run `requestScope()`/store queries BEFORE
  migrations+scheduler boot (dev/test hit an unmigrated DB): `machineFns.ts:77,91,108,117,134`,
  `notifyFns.ts:36,46,68,77`, and `main.ts:24` (module-scope destructure). All gain `await`;
  convert route `getGateway().X()` → `(await getGateway()).X()`; make `scheduler.start()`
  async (it iterates `store.listEnabledLoops()`) and await it in boot. The blueprint had
  only called out `loopApi.backend()`.

### 4g. Hard case — timer fire-and-forget callbacks
croner cron cb, `armNextRunAt` setTimeout re-arm, boot `setInterval` sweep/maintainStorage
keep the `() => void asyncFn()` shape, BUT the functions they call (`armNextRunAt`,
`sweep`, `maintainStorage`, `runLoop`) go async and internally await. Open question
(§7): does an `await store.getLoop` inside the setTimeout re-arm open a window where a
loop is briefly unscheduled? Re-read fresh loop state after the await if so.

### 4h. Async migrator ripple
`runMigrations()` async → `await` in `boot.ts:25` and 8 test `beforeAll` hooks. Silent
breakage (unmigrated DB) if any caller forgets `await`.

### 4i. NOT in the cascade (stay in-memory)
`tokens.ts` (`mintDeviceToken`/`registerRunLease`/`resolveLease`/`rememberClaimIntent`/
`newIdempotency`) and `gateway.claimStatus` are in-memory maps (leases are documented
in-memory v1) — they do not become async.

---

## 5. Test-harness migration plan

**Current state:** NO shared harness. Each of 9 DB-touching test files inlines the same
setup — `beforeAll` sets `LOOPANY_DB_PATH`/`LOOPANY_DATA_DIR` to a per-file `mkdtempSync`
tmp dir BEFORE `await import("../db/index.js")` (so the module-load singleton binds a
distinct file), then sync `db.runMigrations()`, sync `beforeEach(() => db.sqlite.exec("DELETE …"))`,
`afterAll` rms the tmp dir. Per-file isolation is IMPLICIT and load-bearing. The other
37 test files are pure/`import type` only → **zero changes**.

**Recommended local-postgres approach: pglite (`@electric-sql/pglite` +
`drizzle-orm/pglite`), with ONE real postgres-js smoke file as a fidelity backstop.**

Why pglite (single recommendation):
- It IS Postgres compiled to WASM: `ON CONFLICT`, `RETURNING`, `jsonb`, sequences,
  numeric/bigint-as-string all behave as prod — real pg SQL semantics.
- Preserves the current docker-free, `vitest run`-only, per-file-isolated model 1:1
  (in-process instance per file; no shared server, no schema/database juggling, no
  container boot). Default `forks` pool stays.
- testcontainers / docker-compose / Supabase-local are REJECTED: they force a shared
  server (per-file schema isolation), a docker daemon in CI, multi-second boot, and
  (Supabase-local) an entire auth/storage stack these DB-layer tests never touch.

Plan:
1. Extract `test/dbHarness.ts`: `await makeTestDb()` → `{ db, reset }`, reproducing the
   env-before-dynamic-import ordering (or exposing an explicit factory). Provide async
   `reset()`/truncate to replace `db.sqlite.exec(DELETE …)`.
2. `db/index.ts` branches driver by env: pglite in test, postgres-js in prod.
   `store.ts` stays single-sourced (query-builder API is identical; drizzle's generic
   `Db` type absorbs the driver difference).
3. Per file (call-site counts): `gateway/index.test.ts` (277 + 3 `INSERT OR IGNORE`
   seeds at 79/81/645 + `seedTeam` helper), `gateway/retention.test.ts` (67),
   `scheduler/scheduler.e2e.test.ts` (35 + raw UPDATE at 198), `gateway/sync.test.ts`
   (32), `gateway/sleep-reclaim.test.ts` (26), `server/adapters.test.ts` (10),
   `server/runDiff.test.ts` (7), `server/artifactFiles.test.ts` (4),
   `server/boot.test.ts` (4, implicit-migrate via async `ensureServer`). Add `await` to
   every `store.*`; async `beforeEach`/`test`; `await db.runMigrations()`; rewrite the
   12 raw-SQL sites (`INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING`;
   parameterized awaited statements via the postgres-js template-tag client).
4. Regenerate `drizzle/` to pg FIRST (Batch 1–2) or every DB test fails at migrate time.
   The 3 direct seed INSERTs must match post-migration pg column types.
5. `vitest.config.ts`: update the stale better-sqlite3 comment; optional shared bootstrap.
6. **Fidelity backstop — MANDATORY, not optional (review gap, low):** ONE dedicated smoke
   file running `store.ts` against a real postgres-js connection (testcontainers Postgres
   OR a Supabase branch DB in CI). pglite uses a DIFFERENT driver path (`drizzle-orm/pglite`)
   than prod (`drizzle-orm/postgres-js`); two real-pg semantics pglite may NOT exercise
   identically to prod postgres-js must be asserted here: (a) `jsonb` read path — postgres-js
   returns already-parsed objects (a historical drizzle double-parse footgun) — verify every
   `$type<>()` json column round-trips (write→read equal, no double-stringify); (b) default
   collation — SQLite BINARY vs Postgres default differ, so `orderBy(artifactFiles.path)` may
   shift Files-list / diff order (ISO-timestamp orderings are safe). Guard pooling /
   prepared-statement / real-network error behavior here too. (CI target is an open question, §7.)

---

## 6. Deploy / cutover checklist (loopany-prod, loopany.ai)

**Principle:** keep `loopany-testing` as staging (auto-deploy on `main`); add a SEPARATE
prod target + a manual/tagged promote gate — the single-scheduler invariant makes an
accidental double-target dangerous.

- [ ] **`fly.prod.toml` (new):** `app = "loopany-prod"`; keep the single-scheduler
      settings IDENTICAL (`min_machines_running=1`, `auto_stop_machines=false`, never
      scale >1); pick region near the Supabase region; DELETE the `[[mounts]]`
      `loopany_data → /data` block (stateless container); remove `LOOPANY_DATA_DIR` from
      `[env]` (keep `PORT=3000`); optionally bump VM to 1gb (512mb was sized for SQLite).
- [ ] **`Dockerfile`:** drop `python3 make g++` apt install (postgres-js is pure JS —
      verify no other dep needs a native build first); remove `ENV LOOPANY_DATA_DIR=/data`
      and the `/data` comment; keep `corepack enable`; keep `CMD ["pnpm","start"]`.
- [ ] **`package.json` start:** keep `drizzle-kit migrate && node .output/server/index.mjs`
      (migrate-on-boot invariant), but the migrate step targets the **DIRECT** URL
      (`:5432`) via `drizzle.config.ts` — DDL over the pooler fails. The app process uses
      the pooler URL. Commit the regenerated `pnpm-lock.yaml` (Docker cache key).
- [ ] **`.github/workflows/deploy.yml`:** keep the existing job as STAGING
      (loopany-testing). Add a SEPARATE prod deploy — `workflow_dispatch`/tag-gated or a
      GitHub Environment `production` with required reviewers — running
      `flyctl deploy --remote-only -c fly.prod.toml -a loopany-prod`. Use a DISTINCT
      `concurrency` group from staging's `fly-deploy` so a staging push can't cancel an
      in-flight prod deploy. Separate Fly org → add `FLY_API_TOKEN_PROD`. Do NOT add
      `fly.prod.toml` to `paths-ignore`.
- [ ] **Fly secrets (`fly secrets set -a loopany-prod`):** `DATABASE_URL` (Supabase
      transaction pooler `:6543`, runtime, prepare:false); `DIRECT_DATABASE_URL`
      (Supabase direct `:5432`, migrations); `LOOPANY_AUTH_SECRET=$(openssl rand -hex 32)`
      (NEW; set BEFORE first gated deploy — `auth.ts` THROWS at boot if the GitHub gate
      is on but this is unset → crash-loop); `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`
      (NEW prod OAuth app); `LOOPANY_BASE_URL=https://loopany.ai`; `LOOPANY_ALLOWED_LOGINS`
      (prod allowlist); R2 keys (`LOOPANY_R2_*` — bytes stay on R2;
      consider a separate prod bucket). **Do NOT set `LOOPANY_DATA_DIR`.**
- [ ] **GitHub prod OAuth app:** Homepage `https://loopany.ai`; callback exactly
      `https://loopany.ai/api/auth/callback/github` (Better Auth mounts under
      `LOOPANY_BASE_URL`; any mismatch = `redirect_uri` error).
- [ ] **Certs / DNS:** `fly certs add loopany.ai -a loopany-prod` (and optionally
      `www.loopany.ai`); add the A/AAAA (or ACME `_acme-challenge` CNAME) records Fly
      prints at the registrar; wait for validation. If serving apex + www, add both to
      certs AND the OAuth callback list.
- [ ] **Supabase:** create the prod project; confirm the transaction pooler `:6543`
      (Supavisor) is the runtime target; capture both URLs (pooler + direct).
- [ ] **`README.md` / `.env.example`:** document the DB tiering (§1) — local/self-host
      runs zero-config on embedded **pglite** (file at `~/.loopany/pgdata`); set
      `DATABASE_URL` (+ `DIRECT_DATABASE_URL` for migrations) to use Supabase/any Postgres.
      diagram line 68 → "Postgres (Drizzle; embedded pglite by default) · artifact bytes in
      object storage"; drop the `-v loopany-data:/data` SQLite example, show both the
      zero-config run and the `-e DATABASE_URL` hosted run. (README is in `paths-ignore`,
      so this alone won't deploy.) `.env.example`: add the DB URL vars (commented, optional),
      remove the `LOOPANY_DB_PATH` block, keep `LOOPANY_DATA_DIR` (now the pglite dir).
- [ ] **First deploy order:** secrets set → prod DB reachable via DIRECT URL → deploy
      (boot runs `drizzle-kit migrate` over DIRECT, then app connects via pooler) →
      verify OAuth round-trip on `loopany.ai`.

---

## 7. Risk register + open questions

### Risk register (top items)

| Risk | Impact | Mitigation |
|---|---|---|
| `prepare:false` omitted on runtime client | pgBouncer breaks cached prepared statements — production query errors | Hard-set `prepare:false` on the `:6543` client; the single most common Supabase+drizzle break. |
| Migration run over the pooler (`:6543`) | DDL + advisory lock fail | drizzle.config + in-process migrator use `DIRECT_DATABASE_URL` (`:5432`, `max:1`). |
| `ensureServer()` caches resolved value, not Promise | Concurrent first-requests double-boot the scheduler → double-fire every run | Cache the in-flight Promise on `globalThis.__loopanyBooted`. |
| A `.map`/`.filter` callback made `async` but not `Promise.all`-wrapped | Silently yields `Promise[]`, typechecks nowhere useful, wrong data | The 5 §4e sites: `await Promise.all(...)` or hoisted await. |
| `LOOPANY_AUTH_SECRET` unset with gate on | `auth.ts` THROWS at boot → crash-loop | Set the secret before the first gated prod deploy. |
| Aggregate `Number(...)` coercion missed | `count`/`sum` compared as strings → wrong streaks / cost / byte caps | Wrap all 7 sites; keep sumRunCost real-null vs `'0'` distinct. |
| `.changes` left as-is | Compile/runtime failure on 6 delete/prune sites | Port to `.returning({id}).length`. |
| Auth schema hand-ported instead of regenerated | Column-shape drift breaks Better Auth at QUERY time (not compile) | Regenerate via `@better-auth/cli` against the pg provider; re-attach relations. |
| `upsertArtifactFile` unique index dropped in regen | onConflictDoUpdate errors at runtime on every sync flush | Verify `uniqueIndex(loopId, path)` + `blobs.hash` PK + `run_snapshots.runId` PK survive. |
| Async migrator `await` forgotten in a test/boot | Tests run against unmigrated DB / boot races | `await` all 8 test hooks + `boot.ts:25`. |
| Native-build removal from Dockerfile premature | Build fails if a transitive dep needs node-gyp | Audit dep tree after dropping better-sqlite3 before deleting the apt line. |
| Prod auto-deploys on `main` accidentally | Two machines / wrong target against one shared DB | Separate `fly.prod.toml` + promote gate + distinct concurrency group + (maybe) separate token. |
| `tombstoneMissingArtifacts` N round-trips | Latency regression on the ~1.5s flush path | Consider a single set-based `notInArray` UPDATE. |

### Open questions needing the human

1. **Transactions:** wrap `deleteLoop` cascade / `ensureTeam` / `deleteChannel` /
   `updateLoop` read-modify-write in `db.transaction`, or accept eventual consistency
   given the single-scheduler invariant?
2. **`.changes` standardization:** `.returning({id}).length` (recommended) vs reading
   postgres-js RowList `.count` — pick one for all 6 sites.
3. **Aggregate coercion:** centralize a `numFrom(v)` helper vs inline `Number()` at the 7 sites?
4. **Business-schema FKs:** now that pg enforces cheaply, add DB-level FKs (referential
   integrity, needs insert-order care in store/tests/seeds) or keep convention-only?
5. **Auth timestamps:** native `timestamp` (regen default, recommended, Date-typed,
   app-transparent) vs `bigint` epoch-ms (minimal adapter churn)?
6. ~~Dev + test DB story~~ **RESOLVED:** embedded **pglite** (file-backed) is the
   local-dev + light-self-host default; Supabase (postgres-js) engages when `DATABASE_URL`
   is set. Zero-config `pnpm dev` preserved; BYOA end users unaffected. (§1 tiering.)
7. **Fidelity backstop CI target:** testcontainers Postgres (self-contained) vs a
   Supabase branch/preview DB (tests the actual managed target)?
8. **`main.ts`:** migrate the standalone dev server or retire it in favor of the unified
   server? (CLAUDE.md already forbids running both against one DB.)
9. **Fly org/token:** prod reuse `loopany-testing`'s org/`FLY_API_TOKEN` or a separate
   org + second CI secret?
10. **Serve apex only or apex + `www.loopany.ai`?** (affects certs + OAuth callback list.)
11. **R2:** separate prod bucket vs reuse the testing bucket (bytes stay on R2 either way)?
12. **Supabase pooler flavor:** confirm transaction pooler (`:6543`, prepare:false) is the
    runtime target vs session pooler.
13. **`dataDir()` liveness:** confirm no other server-side file state uses the Fly volume
    before deleting `dbPath()`/`dataDir()` and the mount.
14. **Scheduler re-arm window:** does `await store.getLoop` inside the setTimeout re-arm
    briefly unschedule a loop (sync code re-armed atomically)? Re-read fresh state post-await?
