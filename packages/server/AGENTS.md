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
  notify, model, agent, allowControl, taskFile, enabled, runAt, goal, workflow, ui,
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
  ride the TOON path). Derived aggregates are NOT in the `--json` envelope (only the 14
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
  install per `HOOK_TARGET_AGENTS` (a SUPERSET of `SKILL_TARGET_AGENTS` - grok gets a hook
  but is NOT a skill-install target). Claude Code (`~/.claude/settings.json`), Codex
  (`~/.codex/hooks.json`), and Grok Build (`~/.grok/hooks/loopany.json`) all have a concrete
  installer sharing ONE merge routine
  (`installJsonSessionStartHook` — identical `{hooks:{SessionStart:[{type:"command",command:"loopany"}]}}`
  shape), whose stdout lands as ambient context; an agent with no installer is reported
  `skipped`. Grok's global hooks are ALWAYS TRUSTED (no config/trust gate). Codex additionally
  gates hooks behind `hooks = true` in `~/.codex/config.toml`
  and a per-hook TRUST prompt on first session; the installer writes ONLY the `hooks.json`
  entry (never the version-sensitive `trusted_hash`, never the TOML) and SURFACES that
  enable/trust step in the report (and on the automatic `up`/`update` path). Matches
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
- The poll response body is `{deliveries}` and NOTHING else. The watch set +
  `watchDigest` echo retired with the folder watcher; `gateway/index.test.ts` pins
  the exact key list so a re-add has to defeat a named test.

## Gateway layout (the MachineGateway decomposition)

- `gateway/index.ts` (`MachineGateway`) is the run-lifecycle core: poll/pollWait,
  report/reclaimRun/sweep, `finishLoop`, `maintainStorage` (retention/GC), the
  owner verbs (createLoop/listLoops/editLoop/loopLog/renderLoopLog), and the
  machine presence state.
- There is NO byte-ingress cluster: `gateway/sync.ts` (`ArtifactSync`) retired with
  the folder watcher. Artifact bytes are READ through `boot.ts` `getBlobStore()`
  (`server/artifactFiles.ts` is the only consumer) and reclaimed by the gateway's
  `maintainStorage`.
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
- **Boot constructs ONE `createBlobStore()`** (`boot.ts`; accessors `getGateway()` /
  `getBlobStore()` / `getCliGateway()`) and hands it to `MachineGateway` for
  retention/GC while the artifact readers resolve bytes through `getBlobStore()`.
  Still load-bearing with the in-memory store: a second instance would mean the GC
  deleting bytes the readers can see (and vice versa).
- Import direction: the generic wire plumbing (`HttpResult`, `WIRE_TEXT_CAP`,
  `clipText`/`stripNul`, `nowIso`) lives in the leaf module `gateway/http.ts`,
  imported by index and cli alike - one clipping/NUL-stripping discipline, no
  fork; domain helpers (caps, renders) still flow `index.ts` -> `cli.ts`, and
  `index.ts` never imports its satellite, so there is no cycle. The whole shape is
  pinned by `gateway/layout.test.ts` (which also pins that `sync.ts` stays gone).
- The legacy `/api/machine/loop` + `/api/machine/log` routes call the owner-verb
  methods on `MachineGateway` directly; `/api/machine/cli` + `/agent-api/loop`
  route through `getCliGateway()`.

## Team CRUD + membership management

- **Logic lives in `server/teamAdmin.ts`; `server/teamFns.ts` is a THIN RPC wrapper.**
  teamAdmin is framework-free (plain async fns over `store`, `(actorUserId, ...)` in),
  so every rule is directly testable against real pglite without mocking the Start
  runtime (`server/teamCrud.integration.test.ts`, 15 scenarios). teamFns resolves the
  signed-in user (`currentUserId`) and delegates; team management is GATED (open mode /
  signed-out ⇒ a uniform "sign-in required").
- **Every fn takes an EXPLICIT teamId and authorizes by membership+role, NEVER the
  active-team cookie** (the URL report's hard lesson — managing team B while browsing A
  must work). `assertOwner` is the single owner-gate chokepoint; a non-member gets the
  enumeration-safe generic not-found, never the owner-only message.
- **The six approved design decisions (`data/teamcrud-design/report.md` §7):**
  (1) delete is BLOCKED while the team owns loops (`store.countLoopsForTeam(teamId)`),
  never cascaded — `store.deleteTeamCascade` only removes channels/invites/members and
  reassigns machine home-team pointers (cosmetic, machines are user-owned) to each
  owner's personal team; (2) invites are BOTH direct-add-by-email (existing account
  fast path) AND a single-use, 7-day invite link (`team_invites` table, migration
  `0002`); (3) an invite never bypasses `LOOPANY_ALLOWED_LOGINS` (the redeemer already
  signed in through the gate); (4) team management is owner-only, loop creation stays
  any-member; (5) the personal team is renamable — **`store.ensureTeam` is now
  INSERT-ONLY for the name** (the old force-rename at every requestScope silently
  reverted manual renames); (6) multi-owner allowed, the ONLY invariant is the
  last-owner guard.
- **The last-owner guard is enforced TRANSACTIONALLY in the store**
  (`removeTeamMemberGuarded` / `setTeamMemberRoleGuarded` count owners + mutate in ONE
  txn → `'ok'|'last-owner'|'not-member'`), so two concurrent self-removals can't both
  win and strand a memberless team. `leaveTeam` reuses `removeTeamMemberGuarded` (self)
  and also blocks the personal team.
- **Invite redeem** (`/invite/$token` route → `redeemTeamInvite`): any signed-in user
  may redeem (the token is the authority). Outcomes: invalid / already-used (single-use,
  stamped `redeemedAt`) / expired / already-member (success, no double-add, still burns
  the link) / fresh join at the invite's role. The route forges nothing — a signed-out
  visitor hits the normal gated `SignIn` with `callbackURL` back to the invite.
- **UI**: `components/TeamsModal.tsx` (header "Teams" button in `DashboardView`, shown
  only when the user has teams). Master list + selected-team detail (rename, members
  with role select + remove, add-by-email, invite links + revoke, leave, delete with the
  blocked-by-loops disabled state). Owner-only controls hide for a plain member; the
  server re-authorizes regardless.
- **Verifying the gated flow in a browser without GitHub OAuth**: seed a `user` + a
  `session` row into a temp-`LOOPANY_DATA_DIR` pglite, then forge the cookie
  `better-auth.session_token=<token>.<makeSignature(token, secret)>` (`makeSignature`
  from `better-auth/crypto`) — Better Auth verifies the HMAC signature regardless of
  cookie domain. pglite is single-writer, so seed in a separate process that exits
  before the dev server opens the same dir.

## Notification webhook SSRF guard (`gateway/webhookGuard.ts`)

- The built-in Feishu/Lark notifier POSTs to a user-supplied `webhookUrl`, so it is
  guarded against SSRF by `gateway/webhookGuard.ts` (pure, unit-tested):
  `validateFeishuWebhookUrl` (require `https:` + an EXACT host allowlist
  `FEISHU_WEBHOOK_HOSTS` + the `/open-apis/bot/v2/hook/` path shape) and
  `classifyAddress` (blocks loopback/RFC1918/link-local incl. `169.254.169.254`/
  ULA/multicast/reserved; IPv4 + IPv6 + IPv4-mapped). `safeWebhookFetch` composes
  them: allowlist → DNS-resolve + IP-guard EVERY host → bounded timeout
  (`WEBHOOK_TIMEOUT_MS`) + bounded response read (`WEBHOOK_MAX_BYTES`); redirects
  NOT auto-followed (`redirect:"manual"`, each hop re-runs the full guard).
- Enforced at BOTH ends: `CHANNELS.feishu.validate` runs the pure allowlist check at
  create/edit time (called by `notifyFns.createChannel` via the new optional
  `ChannelKind.validate` hook); `CHANNELS.feishu.send` runs the FULL DNS/IP guard at
  every send/test (a stored URL is untrusted - re-checked, never trusted from create).
- **Test seam**: `setWebhookFetchDeps({lookup, fetchImpl})` in `notify.ts` injects DNS
  + fetch so `notify.test.ts` exercises the guard without network (restore with `{}` in
  `afterEach`). `webhookGuard.test.ts` covers the pure helpers directly.
- Residual: global `fetch` re-resolves DNS on connect (no stdlib socket-pinning without
  a custom undici dispatcher, deliberately not pulled in) - the exact-host allowlist
  bounds any rebind to an official Feishu/Lark domain. Adding a NEW outbound integration?
  Reuse this module; do NOT reintroduce a raw `fetch(userUrl)`.
- FOLLOW-UP (audit H-02): channel create/test is any-member (open mode may be
  unauthenticated). The destination restriction closes the SSRF regardless of creator;
  tightening create to team-owner-only is a separate change.

## The kernel (`src/kernel/` + `db/kernel-schema.ts`)

`objects` + `events` hold the workspace's own entities beside the shipping
machines/loops/runs schema. Convergence retired the `loop` kind: **the shipping
product's `loops` row is THE loop**, and `objects.watcher` / `created_by_loop`
are plain text references to one. Three kinds remain — **task, doc, mirror**.
Contracts: `data/loopany-rewrite-design/design.md` + `data/api-spec-s3/report.md`;
the convergence design is `data/rw-converge-s1/report.md`.

- **`kernel/applyTransition.ts` is THE single code exit for `objects.status`** —
  three entries (`createObject` / `applyUpdate` / `applyTransition`), each also
  exposed as `…In(tx, …)` so a caller can COMPOSE a bigger transaction. Rules it
  welds: the kernel NEVER reads a clock (`now` is a required input), the row is
  locked `FOR UPDATE` before any guard, every mutation writes its event with a
  `{old,new}` diff in the SAME transaction, and a no-op writes no event. Refusals
  are typed `{ok:false, code, message, issues, hint}` with the legal move in
  `hint` — never thrown, never retried in-seam.
- **There is exactly ONE transition: a task's `close`.** The four loop moves
  (`pause`/`auto-pause`/`resume`/`retire`) retired with the loop kind — a loop's
  operational lifecycle is the shipping product's (`enabled`, a closed loop's
  `completedAt`, hard delete), and two lifecycle vocabularies over one loop would
  be drift by construction. `kernel/types.ts` `TRANSITIONS` is the whole table.
- **The kind firewalls live at TWO altitudes and both are tested**:
  `kernel/types.ts` (pure, teaching refusal) and the DDL CHECKs
  (`objects_task_facets_only` / `_parent_task_only` / `_format_doc_only` /
  `_mirror_facets_only` / `_mirror_pointer` / `_mirror_stateless` /
  `_closed_pair`). Asserting only the verb would let the floor evaporate on a
  refactor. Drizzle wraps driver errors as a generic "Failed query: …", so assert
  the constraint NAME off `err.cause.constraint` (SQLSTATE 23514) —
  `kernel.integration.test.ts` `expectCheckViolation` is the helper.
- **Dedup is by identity, never by a window.** `kernel/ids.ts` derives a
  re-derivable row's id from its identity alone (no clock, no attempt counter, no
  nonce) and every such insert is `ON CONFLICT DO NOTHING`. Changing a seed shape
  FORKS identity and silently breaks dedup — treat the seeds in `ids.ts` as
  frozen.
- **Ids are SHORT and kind-prefixed** (`task-7f3a91`), and the two halves are
  DELIBERATELY different widths — `kernel/ids.ts`'s header owns the reasoning,
  read it before touching a width. In one line: an ORGANIC id is six hex because
  a collision is re-mintable (bounded retry with fresh randomness, inside the
  same transaction, widening after a run of misses), while a DERIVED id is twelve
  because it may NEVER be re-minted (that purity IS replay idempotency) and its
  collision would otherwise be SILENT. Both halves are pinned by `ids.test.ts` +
  `idCollision.integration.test.ts`. **Write an organic event through
  `applyTransition.ts`'s exported `appendOrganicEvent`, never a bare
  `organicEventId(...)` inline** — the ladder lives in that one helper. Two
  invariants ride on the widths and are pinned: no organic rung may equal
  `DERIVED_HEX`, and the `attempt` parameter is domain-checked to
  `[0, ORGANIC_MINT_ATTEMPTS)`.
- **Width is NOT the only remedy for a derived collision — NOTICING is.** Four
  guards check that the row a swallowed insert resolved to is the identity the
  seed named, and refuse loudly (`ID_COLLISION`, logged at ERROR via
  `failCollision`): `createObjectIn`'s explicit-id conflict path refuses a foreign
  `teamId`; `applyTransitionIn`'s derived-event latch AND its post-append swallow
  both refuse a prior event on a different object; `kernelStore.queueRun` reports
  a foreign-loop id hit as `id-taken`; and `runQueue.appendDerivedEvent` wraps
  every derived append so a fact can never land on a stranger's timeline. THE ONE
  RESIDUE, pinned by its own test: two seeds colliding inside ONE team on ONE
  object still resolve as a replay — telling those apart needs the seed persisted
  in a column, held as a separate schema decision.
- **No id is a clock.** `events.seq` is the log's only ordering authority.
  `listTasks` paginates `ORDER BY objects.id` with a `>` cursor (a total order, so
  the cursor is exact) but the row order is arbitrary; the composed views order by
  `createdAt`/`closedAt` explicitly.
- **`events.seq` IS sparse.** Postgres draws the identity value before detecting
  a conflict, so a swallowed `ON CONFLICT DO NOTHING` burns one. Harmless for
  `WHERE seq > :since ORDER BY seq`, but no consumer may read a gap as a dropped
  event or derive a count from a delta. Pinned by the integration test.

## Verb endpoints, the artifact seam, and the auth split (`src/kernel/objectApi.ts`)

- `kernel/artifactSeam.ts` is the single server-owned object-artifact seam: closed
  top-level keys per kind (`KIND_KEYS`, task + doc — a mirror is not authored as a
  file, and neither is a loop), BOM/CRLF normalization, date forms, projections,
  and the deterministic did-you-mean refusal. Keep kind knowledge out of
  `artifact-format`. A `cron:`/`workdir:` in front matter is an UNKNOWN_KEY whose
  teaching names the shipping surface (`loopany edit <loop-id>`).
- `kernel/apiAuth.ts` resolves invisible `X-Loopany-Run` context once into
  run→loop→team/provenance. **The human/agent split keys on RUN-CONTEXT presence,
  never on the credential** — a positive test for `X-Loopany-Run` (CLI spec §2.2).
  This is load-bearing: the ordinary human runs the CLI on the SAME machine the
  daemon is registered on, so keying on the token made `loopany inbox`/`answer`
  refuse `NOT_HUMAN` for exactly the person the endpoint serves. With no run
  context an enrolled device credential is the OWNER's terminal authority: it
  resolves to `mode: human` in that machine's home-team scope and may use every
  surface a signed-in owner can (objects, inbox/answer, run-now and governance).
  `kernel-cli.ts` and the composed kernel home attach it to every out-of-run
  request. Anonymous/foreign credentials still get `UNAUTHORIZED` when the login
  gate is enabled; a run context still makes human-only verbs refuse the run.
- **Every device surface authenticates through `gateway/enroll.ts`'s full-token
  resolver.** `machineIdFromToken` is only the row index; the full SHA-256 token
  hash is the authority. Poll, unified CLI, legacy owner verbs, kernel auth and
  long-poll waiter registration must agree on that resolver. A legacy row whose
  redundant hash drifted may self-repair only when its stored plaintext token is
  byte-for-byte equal; a hash mismatch without that proof stays a hard 401. This
  prevents the live failure where CLI accepted an id-derived row while poll
  rejected the same credential forever.
- **Run authority is the durable `run_leases` row**, the ONE run credential — the
  kernel's parallel queue/lease columns retired at S5. A terminal-grace lease
  serves READS only, so a woken machine can still read what it was working on
  while only its final report reconciles. `resolveApiContext` has its OWN
  integration test (`apiAuth.integration.test.ts`) driving real `Request`s against
  real machine/run/lease rows, one case per §2.6 cell; only the session half is
  injected.
- **A run's own lease ALSO authenticates it, and inside a delivery it is the only
  credential that reliably can.** The device token is a FILE under `LOOPANY_HOME`,
  and the daemon's allowlisted coding-agent env (`spawn.ts` `BASE_ALLOW`) carries
  neither that variable nor the token — so on any stack with a relocated home
  (every dev/demo stack) the in-run CLI read `~/.loopany`, posted some OTHER
  server's token, and EVERY kernel verb answered `UNAUTHORIZED: unknown device
  credential`. A run could not file its own products, and a real loop's charter
  drifted into routing them through its task file instead. Fix, both halves:
  `kernel-cli.ts` sends `LOOPANY_RUN_TOKEN` when in a run (device token still the
  fallback, so an old server keeps working), and `apiAuth.ts`'s
  `authenticateRunCaller` accepts a lease FOR THE RUN THE HEADER NAMES — a lease
  naming another run is a loud `UNAUTHORIZED`, and a lease with no run context is
  not an agent at all. Nothing else widened: run context is still the positive
  test, every downstream lease/state guard is unchanged, and owner-only verbs
  still refuse a run with their own teaching. **Do not "simplify" this by putting
  the device token or `LOOPANY_HOME` into the agent's child env** — that hands the
  coding agent a machine-wide credential to buy back a narrower one it already has.
- **A task or doc is addressed BY ID OR BY ITS CREATION KEY**, resolved in the ONE
  place `kernel/objectRefs.ts`, which every `$taskId`/`$docId` route runs its path
  segment through (pinned by a wiring guard in `objectRefs.integration.test.ts`).
  Id wins, then `(team, key)`; an unresolvable ref comes back verbatim so the
  caller's NOT_FOUND names what was typed. The key is the ONLY handle that
  survives across runs — an object id is organic randomness — so without this a
  run could file a product and never read it back. Mirrors are out of scope: their
  id and key both derive from `(team, kind, coords)`, so there is no handle to
  remember.
- `kernel/objectApi.ts` owns the transactional task/doc/inbox/verdict/directive
  verbs plus `runLoopNow` (the manual fire on a PRODUCTION loop). Loop CRUD,
  lifecycle and charter governance are GONE — a loop is created with `loopany new`
  and changed with `loopany edit`.
- Every refusal uses the flat `{code,message,issues,hint}` envelope from
  `kernel/refusals.ts`, a CATALOGUE rather than a code list: every `RefusalCode`
  has a first-class `{message, hint}` template, so a refusal can never reach an
  agent as a generic envelope. Adding a code without a template fails to
  typecheck; `refusals.test.ts` is the guard table and also pins that the retired
  loop-governance codes (`NOT_YOUR_LOOP`, `APPROVAL_*`, `RETIRED`, `BAD_CRON`)
  never come back — a code nothing can produce teaches a refusal nobody receives.
- **`refusalResponse` floors an unmapped code at 400.** A code with no
  `REFUSAL_STATUS` row resolved to `undefined`, which `Response.json` renders as
  **200** — a refusal reaching the CLI as a success at exit 0. Do not remove it.
- **The human-only question-clear is covered at THREE altitudes** and all three
  are tested: the route (`resolveApiContext(…, "human")`), the field surface
  (`patchTask`/`replaceFromArtifact`), and `applyUpdateIn` itself. The file path
  is a clear in disguise — dropping `needs_human` from a whole-file replacement
  discards a live question, so it is refused too.
- **A verdict JOINS only a not-yet-executing run, it never refuses the human.**
  An executing run has already consumed its delivery, so a new trigger gets a
  fresh pending row and the poll guard holds it until the sibling finishes.
- `routes/api.events.stream.ts` is a team-scoped DB-tail SSE invalidation stream;
  authoritative content is always refetched from object/view APIs.
- Two response fields are ADDITIVE to API spec §1.5 and both exist for the CLI:
  `total` (so a truncated page prints `count: N of T total`) and `viewerLoop`
  (the caller's own loop id from run context, so a hint can inline a real id).

## Trigger runs — the ONE run world (`src/kernel/runQueue.ts`)

A kernel fact (a due task, a human's answer, a human's directive, a manual fire)
queues an **ordinary production pending run**: `phase: pending`, `role: exec`, the
watcher loop's real `userId`/`machineId`, plus the provenance columns `reason` /
`scope` / `trigger_event_id`. The shipping poll claims it, the shipping lease
authorizes it, the shipping sweep guards it and the shipping report finalizes it.

- `queueKernelRun` is the ONE mint point. Derived-id idempotency is the whole
  safety of the level triggers: `dueRunId` / `answeredRunId` / `directiveRunId`
  are pure functions of the trigger's identity, so one due instant, one verdict
  and one directive each queue exactly ONE run however many passes see them.
  Those seeds are FROZEN. A manual fire is ORGANIC (pressing the button twice is
  two real facts) and re-mints on a taken id.
- **A derived id may never be re-minted, so a collision is NOTICED**: an id
  already held by ANOTHER loop is two identities truncated onto one id, not a
  replay — it fails loudly and rolls back rather than reporting a stranger's run.
- Queueing locks the authoritative `loops` row, then joins only a
  not-yet-executing run (`openRunForLoop`): a trigger arriving during execution
  queues separately, the production poll holds it while a sibling is running, and
  the sweep does not classify that guard-held row as never claimed.
  `runs.claimable_at` (migration `0009`) is what makes the hold safe — a row held
  behind a running sibling begins its never-claimed timeout at the first ELIGIBLE
  poll, not at creation. **The field measures ELIGIBLE time, so the guard CLEARS a
  stamp it holds** (`store.clearRunClaimable`, called from both poll and sweep):
  the stamp is write-once, and one taken while the row was still claimable would
  otherwise keep aging behind a sibling that started later and be reclaimed as
  "run never claimed" the moment the sibling reports.
- **The one-agent-per-loop guard lives INSIDE `store.claimPendingRun`, not in its
  caller.** Multiple pending rows per loop are legal now, so the poll's
  "no running sibling" read and its claim were two statements and two concurrent
  polls could claim two different rows of one loop. A `NOT EXISTS` in the WHERE
  does not close it (write skew under READ COMMITTED), so the claim takes the same
  `loops` row lock the trigger mint takes. Keep the caller's read as a cheap
  pre-filter; never move the guard back out.
- **The due scan filters ENABLED watchers in SQL**, not only in its per-task
  transaction: the scan is a bounded `follow_up asc` window (`DUE_SCAN_LIMIT`), so
  a task whose watcher can never act does not merely waste a round trip — it
  occupies a slot for as long as it stays due. The in-transaction re-check stays
  the authority.
- A due instant's failed/canceled row re-arms with the SAME frozen id once the
  loop's pending slot clears; an open or completed row remains the idempotency
  floor. Cron supersede coalesces only provenance-free cadence rows; trigger rows
  survive.
- **`DueTaskScheduler` is the kernel's ONE remaining clock** and is always armed
  at boot — a loop's cadence belongs to the production scheduler, but a task's
  follow-up date is a kernel fact nothing over there knows about.
- Every terminal shipping path appends the frozen derived `run-finished` event for
  a provenance-carrying row (`appendProductionRunFinished`, including sweep/reclaim
  and the 7-day skipped backstop), keeping workspace SSE/timelines live. Event
  append is best-effort-with-log and can never block lease retirement. Ordinary
  production cron/edit/evolve history stays event-silent.
- Delivery resolves scoped task/event context for a trigger row and includes the
  human's directive or answer VERBATIM as untrusted trigger data; the legacy
  daemon spawn path exports `LOOPANY_RUN_ID` alongside `LOOPANY_RUN_TOKEN`.
- The shipping run-now is immediate even for a disabled loop: it clears any
  deferred `nextRunAt`, queues one production run, and leaves `enabled` false. A
  second fire while that run is pending returns `alreadyQueued`. The retired
  deferred-fire-on-enable behavior must not return.
- **A loop may be created ARMED BUT PAUSED**: `createLoop` honors `enabled` from
  the create config (default `true`; a non-boolean is a 400, never coerced — an
  operational flag must not be silently dropped, which is exactly the bug F1
  found). `enabled: false` registers no cron and fires NO immediate first run —
  the create-time `runNow` is a feature of an enabled create only — and arms no
  deferred one-shot, so the first run is an explicit run-now or the cadence after
  a re-enable. This is what lets a staging/twin loop be expressed AT creation
  instead of racing a follow-up pause edit against the creation run. `--dry-run`
  echoes the state and previews no fires when paused, and `show`'s `nextFire`
  renders `—` for a paused loop (matching `loops`) rather than a time the clock
  will never honor. Pinned end to end by
  `gateway/createPaused.integration.test.ts`, which drives the REAL Scheduler.

## The product model is taught by the PLATFORM, not by each charter

Every loop learns the four nouns — loop / task / doc / mirror — from the run-time
instruction layer, so a charter never has to (and a charter that improvises its own
vocabulary is drift). The teaching lives in exactly three places, at three depths:

- `skill/run/exec-core.md` — the SIGNPOST, one bullet in the non-negotiable core:
  `report` is the immediate channel, durable content is a **doc** under a stable key,
  something to revisit is a **task**, an external artifact you produced gets a
  **mirror** attached to the object that owns it, the loop folder is dashboard/exports
  only. It stays ONE bullet: exec-core's whole point is a self-sufficient core plus a
  pointer, and every line here is paid for on every run of every loop.
- `skill/references/run.md` §4 "Products and the object model" — the BODY: the four
  nouns and their relations, the which-product-is-this decision table, the verb shapes,
  ownership/boundaries and lifecycle. Renumbering note: the schedule/front-matter/
  one-pass sections shifted to §5/§6/§7.
- `skill/references/create.md` — the `## Products` charter section: at create time,
  name the docs by stable key, the tasks and their closing bar, and what gets mirrored.
  STRONGLY RECOMMENDED, never a required field.

Two rules that came out of live validation and must not be softened: **another loop's
charter is never edited by a run** (an agent folded its learnings into a shared charter;
run.md §4 now forbids it by name and points at `task create --watcher <that-loop-id>`
as the way to tell another loop something), and a **doc is rewritten in place under one
key** — a dated product per run is a loop-FOLDER convention, never a new doc per day.

`kernel/refusals.ts` is the fourth surface and must not disagree with the skill: a
refusal's hint and the skill's teaching name the SAME commands. The pass that landed
with this change fixed the hints that still spoke the retired loop-kind vocabulary
(`UNSUPPORTED_FORMAT`, `WRONG_KIND`), the `UNAUTHORIZED` hint that predated a run
authenticating with its own lease, and `PAUSED`'s "resume it on the loop page" (the
resume surface is `loopany edit <loop-id> --json '{"enabled":true}'`). When you change
one side, change the other in the same commit.

## The rewrite CLI (`packages/daemon/src/kernel-{cli,render,help}.ts`)

- Three modules, split so the goldens are testable without a server:
  `kernel-render.ts` is the PURE axi/TOON grammar (quoting rule, typed lists, the
  five-part teaching envelope, status→slug, status→exit) with no I/O and no clock;
  `kernel-help.ts` is ONE table behind the `--help` screen, the `allowed[N]:` line
  and the local grammar check; `kernel-cli.ts` routes, validates flags, renders.
- **The CLI validates FLAGS, never front matter.** Unknown flags / contradictory
  flags / `self` where a loop id belongs / a signed `--since` / a flag-and-file
  conflict are refused locally at exit 2 before any side effect. Front-matter
  validation stays server-side at the one artifact seam.
- `wrote:`/`expected:` print VERBATIM (unquoted); only the `error:` sentence is
  quoted. Exit codes are a pure function of the HTTP status (`exitForStatus`):
  404→3, 401/429/5xx→1, other 4xx→2. **401/429 are exit 1, not 2** — neither is a
  mistake in the command and rewriting it cannot fix either.
- `route.ts` `KERNEL_VERBS` sends `task|doc|inbox|answer|mirror` down this path
  BEFORE the legacy run-token callback branch.
- **Every `loop *` command is a local `SURFACE_MOVED` teaching pointer**
  (`kernel-help.ts` `loopSurfacePointer`), answered before auth, network or I/O
  and performing no request. It names the production equivalent per verb
  (`loopany loops` / `show` / `new` / `edit`). Do not re-add a `loop *` request
  path: there is one loop surface and it is the shipping product's.

## The workspace UI (`src/kernel/views.ts` + `src/components/workspace/`)

Five screens over the kernel, mounted at the flagged `/dev/workspace`
(`lib/rewriteWorkspace.ts`: local dev always, a deployed build only under
`LOOPANY_REWRITE_UI`). The shipping dashboard is untouched — its own route, its
own stylesheet (`styles/workspace.css`, every rule scoped under
`.loopany-workspace`), no import from any shipping surface.

- **`kernel/views.ts` is the BFF layer**: one composed, READ-ONLY endpoint per
  screen (`/api/views/{inbox,tasks,task/:id,loops,loop/:id,run/:id,docs,doc/:id,system-graph}`),
  each gated `resolveApiContext(request, "human")`. Every payload carries
  `cursorSeq` (the `events.seq` it was assembled at); the client skips a refetch
  for any stream message at or below it, which is what keeps a refetch from racing
  the stream.
- **Loops are read from the production roster.** `kernel/loopRefs.ts` is the ONE
  loop-reference resolver and its rulings live in that file's header; the two a
  later change breaks by softening: loop ids are used AS-IS (no alias table — a
  converged loop kept its short id verbatim, and both shapes are opaque `loop-`
  text), and **a dangling reference resolves to a TOMBSTONE, never to `null`**
  (`null` means "no watcher", a state the watcher rule abolished; `source:
  "missing"` means "the loop is gone", which is a fact).
  `components/workspace/loopLabel.ts` is the one render.
  A converged loop's kernel EVENTS remain addressable by the same verbatim id, so
  its history still renders on the loop page — the object row itself is gone.
- **`runDisplayState` maps the ONE run lifecycle** (the shipping `phase`) to the
  words the screens show. A run's end is DERIVED (`ts` + `durationMs`), because
  production stores the start and the measured duration; a running or pending row
  has no end at all, which is the honest answer.
- **The workspace loop drawer is the owner-management surface, but it does not
  fork production semantics.** Basic edits and pause/resume route through
  `server/loopMutations.ts` `applyOwnerLoopPatch`, shared with `patchJob`; the
  u16 watched-task warning is returned after a successful pause and never becomes
  a client precondition. `components/workspace/LoopDashboard.tsx` reuses the
  shipping dashboard sanitizer, but renders `<loop-embed>`, `<loop-calendar>` and
  `<loop-kanban>` as retired-data placeholders until the held artifact-to-docs
  decision is made. Run transcript and usage live only on `/api/views/run/:id`,
  not on every loop-drawer payload.
- **Freshness** (`components/workspace/live.ts`): ONE team-scoped `EventSource`,
  explicit resume at `?since=<highest seq seen>`, `event: reset` → full refetch,
  two errors inside 60s → 30s polling while the stream keeps retrying. Every
  external is an injected seam, so the whole state machine is unit-tested with no
  network. **`start()` must stay restartable** — StrictMode mounts, tears down and
  remounts the provider.
- **Two render paths, and the wall between them** (`Render.tsx`): markdown →
  react-markdown with NO `rehype-raw` (raw inline HTML is simply not rendered —
  the XSS answer, no sanitizer to drift); `format: html` docs → an iframe with
  `srcDoc` + `sandbox="allow-scripts"` and deliberately NO `allow-same-origin`
  (the two together are equivalent to no sandbox). `render.guard.test.ts` pins it
  by reading the sources with comments stripped.
- **`ExecutionBlock` renders the task payload VERBATIM** next to the answer box —
  the execution-integrity invariant (design §7). The view echoes `payload` as a
  separate `execution` key precisely so the contract is visible at the wire. It is
  a native `<details>`, CLOSED by default (2026-08-05): the invariant is that a
  person CAN check the bytes, which is not the same as the bytes always being
  open. The labelled summary names the block and its field count, so it is never
  discoverable only by accident, and nothing inside is summarized or re-keyed.
- **The system graph is a projection** — `deriveGraphEdges` is pure (three kinds:
  `hands-off`, `asks`, `answers`) and `systemLayout.ts` is deterministic banded
  Dagre, so a refetch never reshuffles the canvas. `you` ALWAYS exists, even at
  count zero, so the graph's shape does not change as work moves through it.
  Parallel edges fan and their labels slide (`routeEdges` + `CountEdge`); the lane
  is assigned per unordered source→target BUNDLE and both the bow and the label
  offset are computed in the bundle's CANONICAL direction — measured from each
  edge's own source they cancel out between a forward and a reverse edge, which is
  the bug that made the first fix a no-op.
- **The design language is the graph line's, COPIED and never imported.** Both
  lines own a `components/workspace/` directory AND a `styles/workspace.css`, so
  sharing a module would only deepen the chain-merge conflict. **TEMPERATURE IS A
  RULE, not a palette**: amber = a decision you owe; rose = a consequence that did
  not happen; blue = a decision already made. `parts.tsx` `reasonTone` is the
  single place that mapping lives.
- **One shell, one detail surface.** Every screen is a centered `.document-view`
  with a `ViewHeader`, and ALL detail — task, loop, doc — opens in the shared
  slide-in `Drawer`.
- **SUBTRACTION AND ALIGNMENT (captain direction, 2026-08-05).** Four house rules,
  all four pinned by `components/workspace/rowGrid.guard.test.ts`, which reads
  `styles/workspace.css`. Break one and that test names it.
  1. **ONE COUNT PER FACT.** A page header owns the page-level count; a section
     counts only its own subset, and only when the page has more than one section
     to tell apart. The standalone `CountStrip` stat block is GONE from both Inbox
     and Tasks — the inbox total had four homes and now has two (the Inbox header
     and the rail badge/status line, one source, `inboxCounts`). Do not re-add a
     figure a neighbouring element already states.
  2. **ONE ROW GRID.** `--ws-row-grid` is the single definition of `ArtifactRow`'s
     five tracks, and the trailing three are FIXED widths — a grid is per-element,
     so `auto` tracks size to each row's own content and the pill/age/action land
     at a different x on every row. `.artifact-row` also carries `width: 100%`,
     which is load-bearing: it is a `<button>`, and a button in a column flex
     container is shrink-to-fit, which is what made the separators ragged. A
     breakpoint re-declares the VARIABLE, never `grid-template-columns`; and it
     drops cells BY POSITION (`> :nth-child(n)`), because `ArtifactRow` always
     emits five children and renders an empty `<span/>` for a cell it has no
     content for.
  3. **ONE MEASURE.** `--ws-column` (max width) + `--ws-gutter`, deliberately two
     values so a screen can hold the column with `width` (Inbox/Loops/Docs) or
     with padding plus a centred child (Tasks and System, whose board and canvas
     want the whole pane) and still land on the same left edge. `--ws-group-inset`
     is the matching rule one level down: a tinted section card and a plain group
     inset their contents equally, so rows align across them.
  4. **WHITESPACE SEPARATES, A HAIRLINE DOES NOT.** No rule under the view header,
     none under a group heading, none ending a list. A page header carries at most
     ONE short muted line saying which screen it is — the object model is taught by
     the skill (`skill/references/run.md` §4), never by a paragraph a person
     re-reads on every visit.
- **Local fixture**: `pnpm --filter @loopany/server workspace:seed` writes a full
  fixture THROUGH the kernel (real events, diffs, provenance) plus two PRODUCTION
  loops. pglite is single-writer, so seed BEFORE starting `pnpm dev` on the same
  `LOOPANY_DATA_DIR`. Violating that order does not merely fail the seed — it
  CORRUPTS the data dir (the seed appears to succeed, the running server never
  sees the rows, and the next boot aborts inside the pglite wasm). Recovery is
  `rm -rf "$LOOPANY_DATA_DIR"` and a re-seed.
- **NOT built** (design §9 names it among UI reads): a dedicated run
  history/detail screen and `/api/views/run(s)`. Runs surface as strips on the
  loop page (`recentRuns`) and the task page (runs that touched it).

## The Tasks screen: a grouped LIST by default, the kanban as an alternate view

Captain direction (2026-08-04) settled the shape on three points: **rows and cards
carry NO action** (every write moved into the task drawer), the **row list grouped
by loop is the DEFAULT** with the kanban behind a remembered toggle, and both
views show the same safety-floor counters. `/api/views/tasks` composes ONE payload
for both — a second shape for the same screen is the drift the BFF rule forbids.

- **`kernel/taskBoard.ts` is the ONE column mapping** — pure, clock-free, no
  imports: `BOARD_COLUMNS` (key + label + the one sentence explaining the column,
  which ships in the payload so the client never restates the lifecycle) and
  `columnFor(facts, stamp)`. Precedence is `closed → waiting → due → watched`, so
  the mapping is TOTAL and DISJOINT by construction — `taskBoard.test.ts` asserts
  both over the whole fact-table cross product, because a board that drops a card
  hides work.
- **`components/workspace/taskList.ts` is the ONE list mapping** — pure, no DOM.
  `groupTasks` puts every task in exactly one group (one per WATCHING loop,
  ordered by title, then `closed` last), and closedness is read FIRST so a closed
  task never sits on the desk of the loop that used to watch it. The module also
  owns the remembered view (`readTasksView`/`writeTasksView`, storage passed IN so
  it stays pure and SSR-safe). Grouping by loop is deliberate: the board answers
  "what is true about this task", the list answers "whose work is this".
- **`treeRows` is the ONE tree assembly** and is TOLERANT as defence in depth
  (ported from `feat/task-tree-v2`): a self-parent, an unknown parent and EVERY
  member of a cycle all surface as roots. **`TREE_MAX_DEPTH` bounds the ROOT
  CLASSIFICATION walk, never emission** — bounding emission silently dropped the
  row at exactly that depth (it had classified as a non-root, so it was neither a
  rescued root nor in any emitted subtree). The module's bar is totality: a layout
  that loses a task hides work, and the deep-chain test asserts row count, not
  just `not.toThrow()`.
- **`components/workspace/board.ts` says which ACTIONS a task offers** — pure,
  tested without a DOM. **There is NO drag-and-drop, by product decision**, and no
  on-row/on-card control: a row or card is one button that opens the drawer, and
  `TasksPane`'s `TaskActions` is the only write surface — and as of 2026-08-05 it
  offers exactly ONE act, `tell` (answer a pending question, else leave a
  directive). `cardActions`/`hasActions` are an AFFORDANCE layer, never authority.
  `board.test.ts` pins the absence of any drag wiring, of any action on a row or
  card, and of any watcher write helper at all.
- **Hierarchy is ORTHOGONAL to the watcher.** A child is indented under its parent
  only WITHIN its watcher's group; a child watched by another loop stays in ITS
  group and carries a `part of <title>` chip, never re-parented visually. **The
  BOARD nests nothing** — a column is a state predicate. The chip is TEXT on both
  surfaces; the navigable references live in the drawer, with **no progress count
  anywhere** — a roll-up would imply a coupling the two statuses forbid.

## A task's WATCHER is never empty, never changes, and a due task WAKES it

Captain rulings, 2026-08-04 and 2026-08-05. `watcher` named the loop that acts next but was
allowed to be absent, and the system carried a pile of machinery whose only job
was to notice that absence (an unclaimed pool, claim-from-pool, a 48h orphan
floor, a due-unwatched inbox arm). Forbidding the absence DELETED the machinery.
The reasoning lives in `kernel/types.ts` `WATCHER_HINT` — read that.

- **The rule is enforced at the KERNEL's two chokepoints**, `createObjectIn` and
  `applyUpdateIn`, so every caller inherits it: the HTTP verbs, the whole-file
  replace, the fixture seeder alike. A loop-created task DEFAULTS to
  `createdByLoop`; a create with no creating loop is refused
  (`WATCHER_REQUIRED`, 400). Deliberately NOT a DDL CHECK: the rule has a
  defaulting half a constraint cannot express.
- **NEITHER TRANSFER NOR RELEASE — the watcher is settled at CREATE and kept**
  (captain ruling 2026-08-05, `kernel/types.ts` `WATCHER_KEPT_HINT`). Assignment
  is untouched: a run's task defaults to its own loop, a human create still
  REQUIRES an explicit `--watcher`, and a run may name another loop at create
  (that is what draws the graph's `hands-off` edge). What went is the HAND-OFF —
  re-pointing a live task — because nobody could name a scenario for it. Three
  surfaces enforce it, and the removal is real rather than cosmetic:
  `objectApi.patchTask` refuses a CHANGED `watcher` with `WATCHER_IMMUTABLE`
  (409) — re-sending the SAME value passes, so `show --file` → edit → `update
  --file` stays a roundtrip; `replaceFromArtifact` refuses the same change from a
  front-matter `watcher:` line (the file is the object, so it is a second watcher
  surface); and `task update --watcher` is refused CLIENT-side by
  `kernel-cli.planTaskUpdate` before any round trip, teaching close-and-re-file.
  The flag is `VerbSpec.retired` in `kernel-help.ts` — RECOGNIZED by
  `firstUnknownFlag` so the verb's own plan answers it, never advertised in
  `--help` or an `allowed[N]:` line. Retiring any other flag goes through that
  same list, or a removal degrades into a "did you mean" typo suggestion.
  The workspace drawer's picker, the client `transferWatcher` helper, the tasks
  view's `loops` roster and `loopRefs.assignableLoops` were all deleted with it —
  do not re-add the data half without the ruling that asks for the feature.
- **R-DUE is the other half** (`runQueue.tickDueTasks`, reason `due`,
  `ids.dueRunId`): a watched task whose `follow_up` arrives wakes its watcher,
  scoped `task:<id>`, level-triggered, idempotent per (loop, task, THAT follow-up
  instant). **ENABLED production watchers only**: a disabled loop's due task fires
  on the first scan after re-enable (nothing lost), while a deleted/dangling
  watcher is logged and skipped without mutating the task.
- **Pause / finish / delete WARN, never block, never cascade.**
  `kernel/watchedTasks.ts` is the ONE author of both the count and the voice, and
  each of the three verbs phrases its own consequence over the shared repair hint:
  `editLoop` warns on the enabled true→false TRANSITION only (silent on a
  re-asserted pause or a resume; previewed by `--dry-run`), `finishLoop` warns on
  the completion that disables the loop, and DELETE warns BEFORE the choice
  (`JobDetail.watchedTasks` carries the count so the confirm dialog can name it,
  which a post-write warning cannot). **`store.deleteLoop` must never grow an
  `objects` cascade** (pinned by `watchedTasks.integration.test.ts`): a dangling
  watcher is legal, resolved as a tombstone, and skipped by the due scan. There
  is no repair-by-transfer any more: close those tasks with a note and re-file
  the ones that still matter at a live loop.
- **What retired with the unclaimed state, and why it is ABSENT rather than
  empty**: the `unclaimed` board column and list group, the `pool` graph node and
  its `produces`/`adopts` edges, the `orphan`/`due-unwatched` inbox arms and
  counters, and `task list --unwatched` / `watcher=none`. A permanently-zero
  counter is not a reassuring fact — it teaches a distinction the kernel stopped
  making. `inboxCounts` is now `{question, total}`; the union SHAPE (`reasons[]`,
  `reasonRank`) is kept because the inbox is where a future human-attention branch
  lands.

## Task hierarchy — `objects.parent_id`

- **By ID, never by slug**, through ONE write chokepoint — which is what
  `feat/task-tree-v2` could not have (its parent was a front-matter SLUG with
  files as the writers), so a write-time guard is possible at all and
  slug-collision ambiguity is gone. Nullable, task-only
  (`objects_parent_task_only`), partial index `objects_parent_idx`, and no FK: a
  parent may be closed and tasks are never hard-deleted, so a dangling value means
  bad input and is refused at the write chokepoint.
- **The write-time cycle guard** is `applyTransition.ts` `parentIssue`, called at
  BOTH chokepoints before any write, with the row locked FOR UPDATE first: the
  parent must exist, be a TASK, be same-team, and not be inside this task's
  subtree (bounded ancestor walk, `PARENT_MAX_HOPS` 64) — otherwise
  `PARENT_CYCLE`, and nothing is written. A CLOSED parent is deliberately NOT
  refused: there is **no roll-up in either direction**, so a parent is closed by
  its watcher and never by its last child.
- **The walk is a READ, so it takes ONE lock per team first**
  (`kernelStore.lockTeamHierarchy`, a `pg_advisory_xact_lock`). The child's row
  lock is not enough: on the multi-connection hosted tier two concurrent writes
  `A.parent=B` and `B.parent=A` each walk a chain without the other's uncommitted
  edge and both commit a cycle. Locking the walked rows instead would trade the
  cycle for a deadlock, so it is one team-wide lock, always taken before the first
  ancestor read.
- `parentId: null` is a legal move to root — the one place hierarchy and the
  watcher rule differ. The artifact key is `parent:`, EMITTED by
  `serializeKindArtifact` so `show --file` → re-upload preserves the hierarchy;
  an absent key is a root. `parentId` is on `CONTENT_KEYS` and `expressedDiffs`
  together, so a replay whose file names a different parent reports it.
- `task show` prints BOTH directions: a `parent:` row (`—` for a root, printed
  either way so "no parent" is never inferred from silence) and a
  `children[N]{id,title,status,watcher}` block, each child naming its OWN watcher.
  `task list` deliberately grew NO parent column. `views.ts` resolves a dangling
  parent to `{missing: true}` — the same tombstone-not-null ruling `loopRefs.ts`
  makes for a watcher — TEAM-SCOPED, so a foreign parent tombstones rather than
  leaking a title.

## Mirrors — the fourth kind, and why it is stateless

A mirror is a pure POINTER to something outside the system, so a run reading a
task can see which external items it must go and check. `kernel/mirrors.ts` owns
the pure half (vocabulary, normalization, coords validation, the law);
`kernel/mirrorApi.ts` owns the transactions. Read those headers.

- **STATELESSNESS IS ENFORCED BY SCHEMA.** A mirror row has no `payload` and no
  `body` — `objects_mirror_stateless` — so there is physically nowhere for
  `state: merged` to land. The "cache the status just this once" commit cannot be
  written, not merely discouraged. Welded at three altitudes and all three tested:
  the DDL CHECK (proven by raw SQL that bypasses every application guard),
  `types.ts` `statelessIssues`, and `patchMirror`'s by-name refusal of
  `state`/`status`/`merged`/… — by NAME, because "unknown key" reads as a spelling
  problem and this is a modelling one.
- **One external thing is ONE mirror.** Id and key both derive from
  `(team, kind, coords)`, so a second attach resolves to the existing row through
  ordinary key-idempotency — there is no find-or-create branch. `attachedTo` is a
  jsonb set on the MIRROR (GIN index); every `show` composes `mirrors[]` by
  reverse lookup. A task carries no pointer column and is FOUND BY its mirrors.
  Attachable kinds are task and doc.
- **Coords are IDENTITY**, on `IMMUTABLE_FIELDS`, refused with the two-step
  detach-and-attach teaching at the kernel, at `PATCH /api/mirrors/:id`, and
  locally in the CLI.
- **A mirror is NOT authored as a file** (`ARTIFACT_KINDS` excludes it), which is
  what keeps it from growing a body. Its two creation doors are the flag one-liner
  and an inline `mirrors:` block, which is a CONSTRUCTOR ARGUMENT and not a field:
  create-only, refused by name on the replace path, and never emitted by
  `serializeKindArtifact` — otherwise a whole-file update would silently detach
  every mirror the file happened not to mention.

## The directive, and why the UI has no direct close

- `objectApi.leaveDirective` (`POST /api/tasks/:id/directive`, CLI `task tell`)
  writes a human `directive-left` event on the task and queues one run for its
  watcher, scoped to it. **Its OWN run reason (`directive`), not a subtype of
  `answered`**: an answer replies to a question the agent framed, a directive
  arrives unframed and the run's first job is to work out what it implies. A run
  that could not tell them apart would read an order as a reply to a question it
  never asked.
- **`runs.trigger_event_id` is a pointer, never a copy**: delivery reads the note
  back through it and puts the person's words in the work order VERBATIM, labelled
  `directive:` or `answer:`. A pending question REFUSES a directive
  (`OPEN_QUESTION`, pointing at `answer`); a closed task refuses it too.
- **The UI drops direct close** (`board.ts` has no `canClose`, `api.ts` no
  `postClose`, and `board.test.ts` asserts both ABSENCES so a re-add has to defeat
  a named test): a human closing a task settles the kernel's record while the world
  it describes carries on unchanged — the PR still open, the branch still there,
  and the loop that would have cleaned them up now looking at a closed task it
  will never act on again. What replaces it is `TellBox`, ONE composer in two modes
  (`board.ts` `tellMode`): it ANSWERS while a question is pending and otherwise
  leaves a DIRECTIVE. `loopany task close` remains the emergency hatch for a broken
  watcher — "expect to reconcile external items yourself".

## The DEV entry surface — the converged local workspace

- `scripts/loopany-dev` selects `kernel-home.ts` with the presentation-only
  `LOOPANY_DEV_HOME=1` and refuses non-loopback servers. There is no runtime
  switch: server and daemon use the production poll path. Bare production
  `loopany` keeps the production home.
- The local home composes `/api/views/loops` (the production roster + shared run
  strip) and `/api/inbox`; it stays a human/no-device-token surface and degrades
  to a definitive exit-0 view. `dev-entry.test.ts` pins the boundary.
- Global help signposts production `loops`/`show`/`new`/`edit` for loop ownership
  and the event-sourced task/doc/mirror verbs for workspace work.
- `packages/daemon/skill-dev/` is a separate, non-npm skill distribution teaching
  this surface and the managed-stack contract: on-PATH `loopany-dev` only; never
  bare `loopany`, never source the platform env script, never operate the stack
  lifecycle; retry one unreachable read after ~30s, then stop.

### The isolated-stack recipe

Use a fresh non-3000 port, data directory and `LOOPANY_HOME`, set explicitly for
the shell you control. Never point work at the captain's demo stack and do not
source `scripts/rewrite-local-run.env.sh`.

```sh
(cd packages/server && LOOPANY_PORT=$LOOPANY_PORT pnpm dev)          # terminal 1
(cd packages/daemon && LOOPANY_ROOTS="$LOOPANY_RW_BASE" \
   ./node_modules/.bin/tsx src/cli.ts up --foreground)               # terminal 2
```

- **`up --foreground` is the ONLY safe daemon launch here.** Plain `up` runs
  `ensure`, which writes the REAL `~/.local/bin` shim and `~/.claude/settings.json`
  hooks regardless of `LOOPANY_HOME`. `--foreground` classifies straight to
  `runDaemon`.
- **`LOOPANY_ROOTS` must CONTAIN every workdir the stack's loops bind.** The list
  is COMMA-separated and read once at daemon start, so widening it means a
  restart. Keep the jail narrow.
- **Registration is automatic**: the first production poll enrolls the machine
  from its `dk_`-shaped token (open mode ⇒ `team-shared`, which is also
  `requestScope`'s open-mode team, so the human CLI and the daemon share a scope).
- Create a loop through production `loopany new --json`, fire it through the
  workspace Run-now action, and read the result through production `loopany show`
  plus the loop drawer/event timeline.
- State lives in exactly three places: the server's pglite dir
  (`LOOPANY_DATA_DIR`), the daemon's `LOOPANY_HOME` (device token, server URL,
  pidfile, callback bin, scratch dirs), and each loop's bound workdir. Stop the
  daemon with the CLI's own `down` (or by the pidfile) and then the dev server; a
  restart re-uses the same token, so machine identity is stable.
- **A paused loop is AUTONOMOUSLY inert, which is what makes staging safe**:
  `enabled=false` means the clock can never select it. Stage a risky loop by
  creating it with the daemon DOWN and pausing in the same breath.
- pglite is SINGLE-WRITER, so a raw schema probe against a stack's data dir must
  wait until its dev server is stopped; opening a second PGlite on a live dir is
  the corruption the fixture note above warns about.

## Convergence — what the shape is now, and the two rules it leaves behind

The rewrite line converged onto the shipping product in five stages (design:
`data/rw-converge-s1/report.md`). The result, in one paragraph: **production
`loops` are the only loops, the production poll/lease/sweep/report pipeline is the
only run world, and `objects` holds task/doc/mirror hanging off loop ids.** The
per-stage narration is gone with the code; what a future session needs is the
shape above plus these two rules.

- **MIGRATIONS MINT 0010+ ON THIS CHAIN, and 0003–0009 are never renumbered** —
  they are applied on the demo stack's pglite journal. The graph line and
  `feat/task-tree-v2` each mint their own colliding `0003+` sets; reconciling them
  is a deliberate chain-merge step, not something to pre-empt here.
- **Migration `0010` carries the two DATA steps S5 owed**, before any drop, and
  they are in SQL rather than application code because the code that used to do
  them went away in the same change: it terminalizes every stranded kernel
  queue-state row (`queued`/`claimed` → `phase: error`, keeping the historical
  `ts`, plus the frozen derived `run-finished` event for a provenance-carrying
  row), and it deletes the kernel loop OBJECT of every MIGRATED loop. An
  UNCONVERGED kernel loop is deliberately left in place: it is the only record of
  itself, and an inert row nothing reads beats silently destroying a loop nobody
  migrated.
- **A migration with DATA steps needs a journal-at-N fixture to be tested at all.**
  Every suite database is created FRESH, so a data step always runs over empty
  tables in CI and proves nothing. `db/migration0010.integration.test.ts` is the
  reusable recipe: copy `drizzle/` to a temp dir, delete the new `.sql` and
  truncate `meta/_journal.json` to the previous idx, `migrate()` a bare PGlite
  against that folder, seed the pre-migration shapes with RAW SQL (the TS schema
  no longer has the dropped columns), then `migrate()` against the real folder.
  Copy it when a future migration carries data steps.

## The folder watcher is RETIRED (2026-08-05)

There is no artifact sync. The daemon watches no directory and the server has no
byte-ingress route: a run's products travel as OBJECTS (`loopany doc|task|mirror`)
plus its `report()` payload. The full ruling, what retired, what was deliberately
KEPT as read-only history, and the open follow-up are in the root `AGENTS.md`
("Artifacts / storage — the folder watcher is RETIRED"); read that rather than
re-deriving it here. Three consequences that bite in this package:

- **`loops.taskFileContent` has exactly ONE writer: `report()`.** The sync-time
  mirror (`refreshTaskFileContent`) went with `gateway/sync.ts`, so a charter is
  fresh as of the loop's last FINISHED run — never mid-run, never on an idle-time
  human edit. `kernel/views.ts` and `LoopFilesPanel` both render that column.
- **`blobs` / `artifact_files` / `run_snapshots` are read-only history.** No
  migration dropped them (the ruling said keep stored history readable). The GC in
  `gateway/retention.ts` is still live — a deleted loop cascades its rows and frees
  its bytes — and it is the ONLY thing that writes to the blob store now.
- **Every machine route is rate-limited again.** The blob-PUT/sync-POST exemption
  retired with the routes; `gateway/rateLimit.test.ts` pins their absence.

## Maintaining this file

Keep entries durable and project-intrinsic (build/test/release, architecture, sharp
edges) — not task narration. Prefer a pointer to the authoritative file/command/test
over copying detail. Update or prune an entry when the code it describes changes; delete
what no longer holds rather than letting it drift. `CLAUDE.md` symlinks here, so one edit
serves both. English only, tight prose.
