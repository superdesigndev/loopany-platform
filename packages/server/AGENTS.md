# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## axi-conformance CLI (`gateway/toon.ts` — the TOON spine, batch 1)

- `gateway/toon.ts` is a PURE, dependency-free TOON serializer (no I/O, no clock):
  `scalar`/`quote`/`needsQuote`, `detailBlock`, `countLine`, `listBlock`,
  `emptyList`, `inlineArray`, `helpBlock`, `errorBlock`/`codeForStatus`, `truncate`,
  `doc`. Unit-tested in isolation (`toon.test.ts`). Quoting rule mirrors gh-axi:
  a value is bare unless empty or it carries whitespace/comma/colon/quote. The
  absent-value placeholder is a bare em-dash `—` (`ABSENT`); truncation hints and
  `classification:`/`finished:` lines DELIBERATELY use `—` to match the axi reference
  shapes verbatim (the one place em-dashes are intentional in this repo).
- **Superset body (batch 1, RETIRED in batch 7)**: batch 1 had every `/api/machine/cli`
  verb return its axi TOON in a `text` field (+ `exitCode`) ALONGSIDE its structured JSON
  fields, so the 0.11 daemon could keep rendering structured while `text` shipped
  server-first with no daemon release. `renderLoopLog`/`listLoops`/`createLoop`/`editLoop`
  add `text` at the source (so the legacy routes benefit too); `finalizeCli` (wraps
  `cli()`) fills `text` from a structured `{error}` and ensures `exitCode`. **Batch 7
  retired the superset**: `finalizeCli` now STRIPS the cli body to `{text, exitCode,
  loops, runs}` (the daemon is a pure text sink) — see the batch-7 section below. The
  legacy endpoints skip `finalizeCli`, so their full structured bodies are unchanged.
- **F2** (in-run `loopany log` printed nothing): fixed for free by `renderLoopLog`
  gaining `text` — the in-run callback already prints `body.text`. Proven at the
  callback boundary by `daemon/src/callback.test.ts` (a stub server returning the new
  body, asserting non-empty stdout — that test changes NO daemon source).
- **F5** (fail-loud): `dispatch` `report`/`finish` reject an invalid `--status` with a
  400 `VALIDATION_ERROR` (`status must be new|resolved|nothing-new (got "x")`) instead
  of the old silent `isStatus(...) ? {status} : {}` drop.
- All dispatch errors render via `derr(code, message, slug?)` → `errorBlock` (slug
  defaults from HTTP status; `finishLoop`'s already-finished rejection pins CONFLICT).

## axi-conformance CLI (batch 4 — per-verb `--help`, in-run help TOON, F4)

- **F4 naming**: `applyMutation` reschedule reads `str("run-at") ?? str("next")` —
  `--run-at` is canonical (matches the `runAt` edit key + all help text), `--next`
  stays a working back-compat alias. This closed the shipped drift where the help
  documented `--run-at` but the code only read `--next` (following the help failed).
- **In-run `help`** (`helpText`) renders the §4.9 TOON: a `verbs:` top key with
  grouped typed lists (`always[3]`, `schedule[4]`) + `finish:`/`dashboard/gate:`
  lines, each carrying an availability TAG that flips with the lease caps (exec vs
  evolve/edit: `evolve/edit pass only — this run is "exec"` ↔ `available to this run`;
  schedule tag gates on `allowControl`), then a trailing `help[]`. The schedule list
  header carries its tag AFTER the `{…}:` (a list-header-with-tag, hand-built since
  `listBlock` emits a bare header); groups are nested under `verbs:` via `indent()`.
- **Per-verb `--help`** (P10): `<verb> --help` returns `verb:`/`syntax:`/`summary:`
  (+ role-aware `availability:` for a run) + a short `help[]`, via `verbHelpText(verb,
  lease?)` over two spec maps — `RUN_VERB_HELP` (lease present ⇒ role-aware) and
  `DEVICE_VERB_HELP` (owner surface, no availability line; `new`/`edit` summaries list
  `EDITABLE_LOOP_FIELDS` so schemas are discoverable without failing). `complete`
  aliases `finish`. Intercepted in THREE places: `deviceCli` + `runCli` (unified CLI,
  after the DEVICE_ONLY/loop-fence checks so an owner-only verb still 403s on a run
  credential, never leaks help) and at the top of `dispatch` (the legacy
  `/agent-api/loop` transport). An unknown verb has no spec → `verbHelpText` returns
  undefined and the caller falls through to its unknown-command 400 (device) / 400
  (run dispatch). Availability values are multi-word ⇒ TOON-quoted (`availability:
  "available to this run"`); inner `"exec"` quotes escape inside the quoted value.

## axi-conformance CLI — `show` full editable envelope (batch 2)

- **`show` emits the FULL editable envelope** keyed EXACTLY as `edit --json` accepts
  (`loopEnvelope(loop)`: id + every `EDITABLE_LOOP_FIELDS` key — name, cron, timezone,
  notify, model, allowControl, taskFile, enabled, runAt, goal, workflow, ui,
  stateSchema) PLUS the derived read-only aggregates `nextFire`/`classification`/`runs`.
  `renderShowText` is the pure TOON renderer; `describe(loopId, {allowControl, canFinish,
  full})` wraps it with the loop lookup + runs tally. Large fields (`ui`/`workflow`)
  render as `present, N bytes — use --full to see` (or `absent`); `stateSchema` renders
  STRUCTURALLY (`[N]{key,label,unit}:` rows); `--full` inlines complete bodies (scalar-
  quoted, newlines escaped). A RUN credential adds the effective `selfSchedule`/
  `selfFinish` lines (camelCase — these REPLACED the old kebab `self-schedule`/
  `self-finish` display keys) + run help; a DEVICE credential gets owner help (edit/log).
- **Naming (F4):** the writable pinned override is `runAt` (the edit key; the DB column
  stays `nextRunAt`); the derived cron fire is the read-only `nextFire` (formatted in the
  loop's own tz via Intl, `nextFireDisplay`). The old wire display name `nextRunAt`
  retired. Both `runAt` and `nextFire` appear in `show`, distinct.
- **`show --json`** emits the envelope with COMPLETE bodies (no truncation) — body
  `{ok, loop: <env>, text: JSON.stringify(env)}`, served by the device `show` handler
  and a runCli `show --json` special-case (dispatch returns text-only, so `--json` can't
  ride the TOON path). Derived aggregates are NOT in the `--json` envelope (only the 13
  editable keys + id), so dropping `id` yields a clean no-op `edit` patch.
- **Read/write identity is REAL, pinned by the roundtrip test:** `show --json` minus
  `id` fed to `edit --dry-run` reports zero changes. Two `buildEditUpdate` changes make
  this hold: (1) `set()` still writes to `update` but only RECORDS a change when the
  value actually differs (`sameLoopValue`, structural, null≡undefined) — so an all-no-op
  patch is a harmless idempotent re-apply (still 200, not "nothing to change"), while the
  dry-run preview shows zero changes; (2) `runAt`/`workflow`/`ui`/`stateSchema` accept
  `null` as an explicit clear (symmetric with `goal:null`), which is what `show --json`
  re-feeds for an unset field — a no-op when already null.

## axi-conformance CLI (batch 3 — list/create aggregates, edit no-op, `new` idempotency)

- **`loops` `--fields`**: default columns are the minimal `{id,name,cron,enabled,nextFire}`
  (`LIST_DEFAULT_FIELDS`); `--fields` EXTENDS them from the optional set
  `LIST_OPTIONAL_FIELDS` = `{timezone,notify,model,goal,taskFile,runs,lastOutcome}`
  (request order, deduped, never re-listing a default). An unknown field — including
  a DEFAULT column requested as an extra — fails loud: 400 `VALIDATION_ERROR`,
  `unknown field(s): … — available: <optional set>`, exit 1. `listLoops(deviceToken,
  fieldsFlag?)` computes per-loop `nextFire` (derived cron fire in the loop's tz, `—`
  when paused), `runs` (`countRuns`), and `lastOutcome` (`runOutcomeToken` of the
  newest run). The structured `loops` body carries the WHOLE `LoopListRecord` — a
  RETAINED data channel (`CLI_RETAINED_KEYS`, batch 7) the daemon reads to resolve
  cwd→loop client-side, not for rendering; `renderLoopsText(records, fields)` picks
  columns via `loopCell` into the `text` the daemon prints.
- **`new` idempotency (F8, OQ3)**: the daemon (`create.ts`) computes
  `idempotencyKey = sha256(machineId + canonicalJson(resolvedBody))` over the ENTIRE
  outgoing request body (config + `timezone` + `claim`/connect-key + `agent`) MINUS the
  `idempotencyKey` nonce itself — `machineId` derived from the device token by the SAME
  frozen `m-sha256(tok)[:16]` scheme. Hashing the full resolved body (not a cherry-picked
  subset) closes the whole envelope-collision class: a genuine retry has identical
  argv+env ⇒ identical body ⇒ same key (still dedupes), while ANY envelope difference —
  a different `--tz`, `--connect-key`/team, `--agent`, or config field — yields a DISTINCT
  key so genuinely-different creates never collide. Deliberate, documented deviation from
  the literal §8.1 "config-without-nonce" wording (intent: collapse exactly the retry
  case). Sent on REAL creates only (a dry-run creates nothing). Server keeps an in-memory `newIdempotency` map
  (`tokens.ts`, 15-min TTL `NEW_IDEMPOTENCY_TTL_MS`, pruned on write like
  `claimIntents`); `readNewIdempotency(key, machineId)` also rechecks the record's
  machineId (a cross-machine key never replays another machine's loop) and
  `createLoop` rechecks the loop still exists + belongs to the machine before
  replaying. A live-key hit returns the existing loop with `idempotent:true` + the
  §4.5 replay TOON (`renderReplayText`), never a twin; an absent key ⇒ no dedupe (old
  daemons keep working). The replay body ALSO echoes `ui: existing.ui != null` (like the
  real-create + dry-run branches) so the daemon's `dashboard ui: applied|not applied`
  line stays factually accurate on a timed-out retry of a create that DID apply a
  dashboard. The check sits AFTER validation and the dry-run branch, and
  the create is recorded only on success. Additive body field: old servers ignore it.
- **`edit --json '{}'`** is now a VALID no-op (feedback #3): status 200, exit 0,
  `nothing to change:` + the editable-key list (`renderEditNoopText`), not the old
  bare-usage 400. **`edit --dry-run`** with a rejection now signals **exit 1** via an
  explicit `body.exitCode` (HTTP stays 200 with the rich changes/rejections tables —
  `finalizeCli` leaves a pre-set `exitCode` alone).

## axi-conformance CLI (batch 5 — skill/prose alignment)

- Batch 5 is PROSE/markdown + the demo script ONLY (no gateway/daemon source): it
  aligns the `?raw`-bundled public skill (`skill/references/{run,evolve}.md`) with the
  TOON surface batches 1-4 shipped. `run.md` already carried the camelCase
  `selfFinish`/`selfSchedule` show keys (batch 2 #75 did that); batch 5 only adds the
  "`--run-at` is canonical; `--next` is a back-compat alias" note to the reschedule
  lever (F4). `evolve.md`'s "reading the log" survey now names the shipped
  `renderLogText` header verbatim — `runs[N]{ts,role,outcome,cost,metrics,session,message}`
  + the `summary:` tally — and clarifies that `loopany log`'s `metrics` column shows
  `key=value` while the task-message inline table is metric-KEYS-only. `exec-core.md`
  and `run/edit.md` were verified conformant and left untouched.
- **When you change the `loopany log` TOON columns (`renderLogText`) you MUST update
  `evolve.md`'s survey prose** — the pair is pinned by `-api.skill.references.test.ts`
  ("evolve.md log survey names the shipped TOON columns"), which substring-matches the
  exact header + `summary:` + the `key=value` phrasing. That serving test is the
  lightweight guard for this batch (it also pins run.md's `--run-at`/`--next` note and
  that the retired kebab `self-schedule:`/`self-finish:` display keys never reappear).
- `scripts/demo-cookie-unified.sh` create body used a stale `task:` field; `createLoop`
  dropped the `task` column (batch 2) and 400s without `taskFile`/`workflow`, so the
  demo was actually broken — batch 5 renames it to `taskFile` (review F7).
- These `.md` edits compile into the server bundle via `?raw`, so this batch DEPLOYS
  server-side AND rides the next `@crewlet/loopany` npm tarball for the installed skill
  (`sync-skill.mjs` whitelist is untouched — still SKILL.md + the 4 references).

## axi-conformance CLI (batch 6 — daemon text sink + content-first home)

- **Server `home` verb** (`gateway/cli.ts`): bare `loopany` posts `["home", …ctx]`.
  DEVICE branch (`homeDevice`) is handled in `deviceCli` BEFORE the unknown-machine 401
  guard, so an unregistered machine renders the DEFINITIVE `machine: not connected — run
  \`loopany up\`` state (never a 401/empty, P5/P8). A registered machine → `machinePresence`
  (`lib/machinePresence.ts`) line + cwd-scoped loop list + `recentMachineRuns` across the
  machine + help. RUN branch (`homeRun`, in `runCli` before the read branch) → the lease's
  OWN loop context (`renderRunHomeText`: identity + role + goal + recent), scoped to
  `lease.loopId`. Both render via pure helpers (`renderHomeText`/`renderRunHomeText`).
- **Text-sink render is server-side; local facts ride as flags.** The daemon can't have
  the server render `bin:`/`daemon pid`/cwd-scoping, so it passes them as `home` argv
  flags: `--bin`/`--pid`/`--server` (header) + `--cwd`/`--home` (scoping). `scopeLoopsByCwd`
  replicates the daemon's `resolveLoopDir` (dirname(taskFile)→workdir, tilde-expanded
  against the passed `--home` since the SERVER's home is irrelevant) to split loops into
  "here" vs an `elsewhere` count; no cwd (or none matching) ⇒ ALL loops are "here". This
  is the one place `gateway/cli.ts` imports `node:path` (pure, no I/O).
- **Daemon is a text sink** (`packages/daemon/src`): every server-verb path PRINTS
  `body.text`+`body.exitCode` via the shared `cli-client.ts`. Batch 6 had `printText`
  return null on a text-less OLD server for a one-release structured fallback; **batch 7
  retired that fallback** — `printTextOrTooOld` now prints a definitive `SERVER_TOO_OLD`
  error instead (the render-only `printLoops`/`printEditDryRun`/`printCreateDryRun`/
  `formatRun`-fallback were deleted; `home` prints a definitive `tooOldHome` exit 0). See
  the batch-7 section below. `--json` (log/show) stays the escape hatch; `loopany log
  --transcript` keeps its client render from the RETAINED `runs` channel (the server
  survey is concise, no `--full` inline yet). Converged on
  `callback`/`interactive`/`log`/`create`/`show`/`home`.
- **Routing lives in the pure `route.ts` `classify(argv, env)`** (unit-tested; `cli.ts`
  maps a `Route` to its lazily-imported handler). The Batch-6 behavior change (OQ1): bare
  `loopany` = the content-first HOME (device out-of-run; in-run bare posts `home` on the
  run cred — fixes the old `argv.length > 0` guard). The foreground poll loop moved to
  `loopany up --foreground`; the `--server-url`/`--api-key` detached re-exec path is
  PRESERVED (still `{kind:"daemon"}`). `report`/`finish`/`complete` OUT of a run are
  FORWARDED to the server (device cred → the crafted run-only 403, F3), never a generic
  unknown-command. `loopany show` out-of-run (F1) resolves the loop client-side (like
  `log`, reusing `log.ts` `resolveLoopId`) then forwards.
- **`loopany setup hooks [--remove]`** (`setup.ts`, P7): idempotent SessionStart hook
  install per `SKILL_TARGET_AGENTS` (only Claude Code has a concrete installer today —
  `~/.claude/settings.json`, a `{hooks:[{type:"command",command:"loopany"}]}` SessionStart
  entry whose stdout lands as ambient context; other agents reported `skipped`). Matches
  gh-axi UX (integrations report + restart hint). `loopany up`/`update` call the
  best-effort `refreshHooks` (one line, never blocks — like the skill install). The
  ambient hook ONLY installs with a DURABLE on-PATH `loopany` (`resolveDurableCommand`:
  our shim OR a PATH-resolvable global install): the automatic `refreshHooks` path SKIPS
  it with one line of `npm i -g` guidance when only a bare, non-PATH `loopany` would
  result (the common npx-without-global flow — a hook pointing at a missing binary would
  fail every session); the explicit `setup hooks` verb still installs but warns before
  the bare fallback. The `home` view fetch is BOUNDED (`http.ts` `boundedFetch`,
  `HOME_TIMEOUT_MS`) so the SessionStart hot path degrades fast — a hung server renders a
  DEFINITIVE degraded home (`server unreachable`, exit 0), never stalling session start.
- **PATH shim** (`bin-shim.ts`, feedback #4): `loopany up`/`update` write a `loopany`
  re-exec wrapper (same launcher-replay as `callback-bin.ts`) to the npm global bin
  (`npm_config_prefix`) else `~/.local/bin`, with one-line PATH guidance when the dir
  isn't on PATH. `home` reports the shim as `bin:` via `existingBinShim`. HARDENED so
  the durable shim is never fragile/destructive: it lands ONLY from a durable install
  (`isEphemeralEntry` skips an npx/npm-cache `/_npx/`,`/_cacache/` re-exec entry, with
  `npm i -g` guidance) and NEVER clobbers a foreign `loopany` (only refreshes our own
  shim, detected by the `SHIM_MARKER` prefix); `ensureBinShim` returns
  `{path,onPath,written}` so callers/tests can assert skipped-vs-written.
- **TEST HAZARD**: the `up`/`update` integration refreshers (`ensureBinShim`,
  `refreshHooks`) write the REAL `~/.claude/settings.json` + `~/.local/bin` if not
  injected. `ensure.test.ts`'s `seams()` MUST no-op both (it does); every setup/bin-shim
  test injects fs/env seams and NEVER touches the real home. Batch 6 is the one
  behavior-changing daemon batch — ships in the next `@crewlet/loopany` npm release
  (release note: bare `loopany` = home, foreground → `up --foreground`).

## axi-conformance CLI (prod-E2E fixes — gate for batch 7)

Conformance/polish fixes from the 0.12.0 production E2E (`e2e-axi-prod-v1`). Split
server (deploys) vs daemon (rides the NEXT `@crewlet/loopany` npm release):
- **`loops` flag cluster (F1–F4), ONE root cause: the daemon `interactive.ts` loops
  path HARDCODED `postCli(["loops"])`, dropping every user flag** — the server never
  saw `--fields`/`--json`/unknown flags. Fix is BOTH sides: the daemon now forwards
  `--fields`/`--json` (+ `--help`), rejects an unknown loops flag CLIENT-side (exit 2,
  same as an unknown VERB — exit 2 is a client concern, `route.ts`), and `parseFlags`
  learned the `--k=v` form; the server `listLoops(token, fields?, json?)` gained
  `--json` → `text = JSON.stringify(records)` (real JSON, mirroring `show --json`;
  `--fields` validation was already correct). **`log`/`show` had the lesser variant**
  (they honored known flags but silently IGNORED unknown ones) — now they reject an
  unknown flag client-side too (uniform exit 2). `new`/`edit` already rejected unknowns.
- **NOT_FOUND (F5)**: `log`/`show` resolve the loop id CLIENT-side (`resolveLoopId`,
  `log.ts`), so a nonexistent explicit id never reaches the server. It used to print a
  prose `loopany:` line at exit 2 (a usage failure). Now `resolveLoopId` tags the
  explicit-not-found case `code: "NOT_FOUND"` and the shared `renderResolveError`
  emits `error:`/`code: NOT_FOUND` to STDOUT at exit 1 (message quoted via
  `JSON.stringify`, keeping the actionable "run `loopany loops`" guidance). Other
  resolve failures (no-folder-match, ambiguous) STAY prose/exit-2 usage errors.
- **Hook gating (F6)**: the automatic `up`/`update` refresh (`refreshHooks`) and the
  explicit `setup hooks` BOTH derive from `resolveDurableCommand` — but `npx …`
  PREPENDS a throwaway `…/_npx/…/.bin` onto PATH, so the durability probe counted that
  transient `loopany` as durable and installed a bin-dependent SessionStart hook while
  the bin shim was (correctly) skipped as ephemeral. Fix: `resolveDurableCommand`'s
  PATH scan (`loopanyPathBin`) now SKIPS ephemeral dirs (`isEphemeralEntry`), so the
  npx-only case resolves to null → the automatic path skips the hook, parity with the
  skipped shim. `resolveDurableCommand` now returns the ABSOLUTE path (not bare
  `loopany`) for a PATH global — a more robust hook command; `isOurHookCommand` still
  matches it (`endsWith("/loopany")`).
- **`bin:` line always (F7, P8)**: the home MUST lead with `bin:`. The daemon `home.ts`
  now resolves the durable bin via `resolveDurableBinPath` (shim OR non-ephemeral PATH
  global, real path) and passes `--bin` when known; the server `renderHomeText` renders
  the honest `bin: (not on PATH — run \`npm i -g @crewlet/loopany\`)` fallback when
  `--bin` is absent (both the connected and not-connected branches). The daemon-local
  homes (`notConnectedHome`/`degradedHome`/`fallbackHome`) lead with the same
  `binLine(bin)`.
- **`edit --json '{}'` no-op (F8)**: the SERVER already renders the `nothing to change:`
  + editable-key list (batch 3). The daemon short-circuited an empty patch to the usage
  screen (exit 2) BEFORE the server. Fix: only show usage when NO input flag was given
  (`--json`/`--*-file` absent); an explicit `--json '{}'` forwards → the server no-op.
- **`nextRuns` tz (F9)**: `new`'s `nextRuns` rendered raw unlabeled UTC while `show`'s
  `nextFire` renders loop-tz. New shared `fmtTimeZoned(iso, tz, {seconds?})` (Intl, zone
  label) backs BOTH — `nextFireDisplay` (seconds) and the create/dry-run `nextRuns`
  (minute granularity + zone label).
- **home header (F11)**: the cwd-scoped list block is `loops here[N]` (design §5.1) only
  when there IS an elsewhere count (`elsewhere > 0`); an unscoped full-machine view stays
  the plain `loops[N]`.

## axi-conformance CLI (batch 7 — retire the superset scaffolding)

The final axi batch: the daemon is a PURE text sink, so the transitional "superset" render
fields are retired. Ships server-first (deploys); the daemon changes ride the next
`@crewlet/loopany` npm release (0.13.0) with PR #80's daemon fixes.
- **Server strips at the cli boundary.** `finalizeCli` (wraps `cli()` ONLY) now reduces
  every `/api/machine/cli` body to `CLI_RETAINED_KEYS` = `{text, exitCode, loops, runs}`
  after filling `text`/`exitCode` — dropping the render-only `ok`/`id`/`name`/`loop`/
  `loopId`/`changes`/`rejections`/`applied`/`config`/`nextRuns`/`classification`/`ui`/
  `warning`/`idempotent`/`dryRun`. `loops` (client-side cwd→loop resolution) and `runs`
  (`log --json` + `--transcript` escape hatch) are RETAINED data channels, not scaffolding
  — the daemon reads them as data, and the server's `log`/`show` dispatch needs an explicit
  id (design §3), so resolution must stay client-side. The verb HANDLERS still construct the
  full structured bodies (createLoop/editLoop/listLoops/renderLoopLog) because the LEGACY
  endpoints (`/api/machine/loop|log`, `/agent-api/loop`) call the methods DIRECTLY (not
  through `finalizeCli`) and their bodies are UNCHANGED — a pre-0.12 daemon on the postCli
  404-fallback still renders. `--json` is unaffected: it renders JSON into `text`
  (`show`/`loops`) which the daemon prints verbatim.
- **Daemon has no structured-render fallback.** `cli-client.ts` `printTextOrTooOld` replaces
  the per-verb `printText`-null → `printLoops`/`printEditDryRun`/`printCreateDryRun`/
  `formatRun` fallback: when `text` is ABSENT (a pre-0.12 server) it prints a definitive
  `error:`/`code: SERVER_TOO_OLD` to stdout, exit 1, never blank. `home` is the ONE
  exception — it stays never-empty/never-alarm on the SessionStart hot path, rendering a
  definitive `tooOldHome` (exit 0). `log --transcript` KEEPS its client render from the
  retained `runs` (+ the loop name from `resolveLoopId`, now `{id,name}`); `log --json`
  keeps `JSON.stringify(runs)`.
- **Compat:** the 0.12 daemon (already a text sink) keeps working — it reads `text`/
  `exitCode` + the retained `loops`/`runs`. Daemons **≤ 0.11** (which render the structured
  fields) get EMPTY device-verb output against the new server; mitigation: `npx @latest`
  users auto-upgrade, global installs run `loopany update`. The in-run path keeps working on
  ≤ 0.11 (it prints `text`, which stays). The postCli 404-fallback + legacy endpoint aliases
  are OUT of scope here (separate `rexp-b7`, its own upgrade-window gate).

## Poll transport (long-poll + hot-path budget)

- `/api/machine/poll` is `gateway.pollWait()` wrapping the sync-shaped `poll()`:
  an idle daemon sends `wait:true` and the request PARKS on a per-machine waiter
  (`armPollWaiter`, held <= `LONG_POLL_WAIT_MS` 20s - under the daemon's 30s fetch
  timeout AND `ONLINE_TTL_MS` 30s; an empty timeout re-stamps lastSeen before
  returning so a parked poll never looks offline). The Scheduler's Dispatcher is
  no longer a no-op: `dispatch(loop)` -> `wakeMachine(loop.machineId)` resolves the
  parked waiter, so a new pending run is claimed near-instantly. The waiter is
  armed BEFORE the first claim pass (no slip-past race); waiters are IN-MEMORY
  (unlike run leases, which are durable rows) - a deploy drops them and the
  daemon just re-polls. Old daemons
  never send `wait` and keep the classic instant response; `main.ts` still calls
  bare `poll()`.
- Daemon side (`daemon.ts`): `buildPollBody` opts into `wait:true` ONLY while
  `inFlight` is empty (a running run needs the ~3s progress-heartbeat cadence);
  the sleep is `nextPollDelayMs(elapsed)` - a response that consumed the interval
  was a server hold => re-poll after a 250ms breather, a fast answer sleeps out
  POLL_MS. Zero protocol coupling: against an old server this degrades to the
  classic 3s cadence by construction. Both helpers are exported + unit-tested.
- Poll hot-path DB budget: `machines.lastSeen` re-stamps only when the flag must
  flip or the stamp is older than `LAST_SEEN_REFRESH_MS` (10s) - an idle poll is
  read-only. The claim scan is `store.pendingRunsForMachine(machineId)` (targeted,
  `runs_phase_idx`), never the all-open `openRuns()` scan (that stays sweep-only).
- Watch set: served from a per-machine cache (`WATCH_CACHE_TTL_MS` 15s), response
  always carries `watchDigest`; when the daemon echoes a matching digest the
  `watch` array is OMITTED. Omission requires the echo (proof the client speaks
  the protocol) - an old daemon always gets the full list, and an ABSENT `watch`
  means "unchanged", never "empty" (`daemon.ts` only reconciles on `Array.isArray`).
  Any delivery forces a recompute (the run may belong to a brand-new loop whose
  folder must be watched before it writes); gateway `createLoop`/`editLoop` call
  `invalidateWatch`; store-direct write paths (web loopApi) are covered by the TTL.

## Gateway layout (the MachineGateway decomposition)

- `gateway/index.ts` (`MachineGateway`) is the run-lifecycle core: poll/pollWait,
  report/reclaimRun/sweep, `finishLoop`, `maintainStorage` (retention/GC), the
  owner verbs (createLoop/listLoops/editLoop/loopLog/renderLoopLog), and the
  presence/watch state.
- The artifact byte-ingress cluster lives in `gateway/sync.ts` as `ArtifactSync`:
  `sync()` (POST /api/machine/sync manifest reconcile), `putBlob()` (PUT
  /api/machine/blob/:hash), `readBlob()` (the download seam `artifactFiles.ts` /
  `runDiff.ts` resolve bytes through), plus the private task-file mirror
  `refreshTaskFileContent`.
- The CLI dispatch cluster lives in `gateway/cli.ts` as `CliGateway`
  (constructor-injected with the `MachineGateway`): `cli()` (the unified
  /api/machine/cli credential router + `finalizeCli`), `agentApi()`
  (/agent-api/loop), the per-run `dispatch()` verb switch, and the CLI-only
  renders/help/home. It reuses the core's methods through the injected gateway -
  `finishLoop`, `renderLoopLog` (the flat-404 scoping body), the owner verbs, and
  the scheduler are public on `MachineGateway` for exactly that second consumer -
  so floors/allowControl/canFinish and the credential-type-first routing flow
  through unchanged. `gateway/toon.ts` stays the shared render spine.
- `gateway/validate.ts` holds the ui/workflow/schema validators. ANTI-DRIFT
  INVARIANT: the owner edit surface (`createLoop`/`editLoop` in index.ts) and the
  run-token `set-*` surface (`applySet*` in cli.ts) import this ONE module, so the
  two write paths cannot validate differently.
- **Boot constructs ONE `createBlobStore()` and hands the SAME instance to
  `MachineGateway` and `ArtifactSync`** (`boot.ts`; accessors `getGateway()` /
  `getArtifactSync()` / `getCliGateway()`). This is load-bearing with the
  in-memory store: two instances would mean retention/GC deleting bytes
  ArtifactSync never wrote (and vice versa). Tests mirror the sharing
  (`retention.test.ts` `gatewayWithStore`).
- Import direction: the generic wire plumbing (`HttpResult`, `WIRE_TEXT_CAP`,
  `clipText`/`stripNul`, `nowIso`) lives in the leaf module `gateway/http.ts`,
  imported by index/cli/sync alike - one clipping/NUL-stripping discipline, no
  fork; domain helpers (caps, renders) still flow `index.ts` -> `cli.ts`/`sync.ts`,
  and `index.ts` never imports its satellites, so there is no cycle. The whole
  shape is pinned by `gateway/layout.test.ts`.
- The legacy `/api/machine/loop` + `/api/machine/log` routes call the owner-verb
  methods on `MachineGateway` directly; `/api/machine/cli` + `/agent-api/loop`
  route through `getCliGateway()`.

## Maintaining this file

Keep entries durable and project-intrinsic (build/test/release, architecture, sharp
edges) — not task narration. Prefer a pointer to the authoritative file/command/test
over copying detail. Update or prune an entry when the code it describes changes; delete
what no longer holds rather than letting it drift. `CLAUDE.md` symlinks here, so one edit
serves both. English only, tight prose.
