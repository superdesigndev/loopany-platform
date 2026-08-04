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

## Rewrite kernel (`src/kernel/` + `db/kernel-schema.ts`) — landing unit 2

The rewrite's storage + kernel skeleton. The loop migration COPIES (`loops` is never
touched). Units 3-4 add the scheduler/claim path and object HTTP/CLI verbs while the
legacy runtime remains alongside them. Contracts:
`data/loopany-rewrite-design/design.md` + `data/api-spec-s3/report.md` (§4 kernel
transactions, §5 DDL, §6 scheduler); the harvest is the graph line's `src/graph/ids.ts`
(`fm/graph-clockshadow-c1`).

- **`kernel/applyTransition.ts` is THE single code exit for `objects.status`** — three
  entries (`createObject` / `applyUpdate` / `applyTransition`), each also exposed as
  `…In(tx, …)` so unit 4's verdict and §6.6's failure backoff can COMPOSE a bigger
  transaction. Rules it welds: the kernel NEVER reads a clock (`now` is a required
  input), the row is locked `FOR UPDATE` before any guard, every mutation writes its
  event with a `{old,new}` diff in the SAME transaction, and a no-op writes no event.
  Refusals are typed `{ok:false, code, message, issues, hint}` (spec §3.1) with the
  legal move in `hint` — never thrown, never retried in-seam.
- **The kind firewalls live at TWO altitudes and both are tested**: `kernel/types.ts`
  (pure, teaching refusal) and four DDL CHECKs (`objects_cron_loop_only` /
  `_workdir_loop_only` / `_task_facets_only` / `_format_doc_only`, plus
  `objects_closed_pair`). Asserting only
  the verb would let the floor evaporate on a refactor. Drizzle wraps driver errors as
  a generic "Failed query: …", so assert the constraint NAME off `err.cause.constraint`
  (SQLSTATE 23514) — `kernel.integration.test.ts` `expectCheckViolation` is the helper.
- **Dedup is by identity, never by a window.** `kernel/ids.ts` derives a re-derivable
  row's id from its identity alone (no clock, no attempt counter, no nonce) and every
  such insert is `ON CONFLICT DO NOTHING`. Changing a seed shape FORKS identity and
  silently breaks dedup — treat the seeds in `ids.ts` as frozen.
- **Ids are SHORT and kind-prefixed** (design §8 / CLI spec §5.1: `task-7f3a91`), and
  the two halves are DELIBERATELY different widths — `kernel/ids.ts`'s header owns the
  reasoning, read it before touching a width. In one line: an ORGANIC id is six hex
  because a collision is re-mintable (bounded retry with fresh randomness, inside the
  same transaction, widening after a run of misses — `createObjectIn`'s mint loop,
  `appendOrganicEvent`, `queueKernelRun`'s manual branch), while a DERIVED id is twelve
  because it may NEVER be re-minted (that purity IS replay idempotency) and its
  collision would otherwise be SILENT — swallowed by the same `ON CONFLICT DO NOTHING`
  that implements dedup, handing back a stranger's row. Both halves are pinned by
  `ids.test.ts` + `idCollision.integration.test.ts` (which scripts the mint through a
  partial mock of `ids.js` to stage a collision on demand). **Write an organic event
  through `applyTransition.ts`'s exported `appendOrganicEvent`, never a bare
  `organicEventId(...)` inline** — the ladder lives in that one helper, so an inline
  mint silently opts its fact out of the retry and a taken id is swallowed rather than
  redrawn (`objectApi.runLoopNow`'s manual `run-queued` event is the out-of-module
  caller this exists for). Two invariants ride on the
  widths and are pinned: no organic rung may equal `DERIVED_HEX` (equal widths would let
  the two families produce the same id STRING, reopening a cross-family silent merge),
  and the `attempt` parameter — which used to be a TIMESTAMP, same type — is
  domain-checked to `[0, ORGANIC_MINT_ATTEMPTS)`, so a stale `newObjectId(kind, nowMs)`
  call throws instead of quietly minting 16-hex ids forever.
- **Width is NOT the only remedy for a derived collision — NOTICING is.** Purity forbids
  re-minting a derived id; it does not forbid checking that the row a swallowed insert
  resolved to is the identity the seed named. Four guards do exactly that and refuse
  loudly (`ID_COLLISION`, logged at ERROR via `applyTransition.ts` `failCollision`;
  `runQueue.ts` throws, rolling its transaction back): `createObjectIn`'s explicit-id
  conflict path refuses a `found.teamId !== teamId` (this closed a cross-team data
  handoff); `applyTransitionIn`'s derived-event latch AND its post-append swallow both
  refuse a prior event on a different object (`objectId` is IN the seed, so a foreign
  holder is a certain collision, never a replay); `kernelStore.queueRun` reports a
  foreign-loop id hit as the new outcome `id-taken` rather than `replay` (organic manual
  fires re-mint on it, derived clock fires fail loud); and `runQueue.appendDerivedEvent`
  wraps every derived `store.appendEvent` so a fact can never land on a stranger's
  timeline. `tickRunClock` isolates the failure per loop (`TickResult.failed`) and
  deliberately does NOT advance that loop's cursor, so the fire stays due instead of
  being silently consumed. THE ONE RESIDUE, pinned by its own test: two seeds colliding
  inside ONE team on ONE object still resolve as a replay — telling those apart needs the
  seed (or its 64-hex hash) persisted in a column, held as a separate schema decision.
- **No id is a clock.** `events.seq` is the log's only ordering authority and every
  reader already uses it. `listTasks`/`listLoops` still paginate `ORDER BY objects.id`
  with a `>` cursor — a total order, so the cursor is exact — but the row order is now
  arbitrary rather than incidentally creation-ordered; the composed views that care
  (`kernel/views.ts`) order by `createdAt`/`closedAt` explicitly and are unaffected.
- **`events.seq` IS sparse — the spec is wrong about this.** §5.4 claims a swallowed
  insert consumes no identity value; Postgres draws it before detecting the conflict, so
  gaps exist. Harmless for `WHERE seq > :since ORDER BY seq`, but no consumer may read a
  gap as a dropped event or derive a count from a delta. Pinned by the integration test.
- **`runs.state` was already taken** (the per-run metrics jsonb), so spec §5.3's run
  lifecycle column ships as **`queue_state`**; every other queue/lease column keeps its
  spec name. All are nullable and NULL on legacy rows. The temporary
  `runs_one_queued_idx` retired in convergence S2; one-open-run discipline now comes
  from the transactional lookup described in the S2 note below.
- **`pnpm kernel:migrate-loops [--dry-run] [--team <id>]`** (`kernel/loopMigration.ts`)
  copies each loop into one `objects` row. Insert-only by design: it never UPDATES an
  already-migrated row, because that would overwrite whatever the kernel side has since
  done to it. Mapping is spec §5.5; the one judgment call is `charterFromTaskFile`
  (task file `## Spec` section, else the whole file), and `taskFileContent` is the one
  column deliberately not copied into `payload`.

## Rewrite verb endpoints + CLI (`src/kernel/objectApi.ts`) — landing unit 4

- `kernel/artifactSeam.ts` is the single server-owned object-artifact seam: closed
  top-level keys per kind, BOM/CRLF normalization, date forms, projections, and the
  deterministic did-you-mean refusal. Keep kind knowledge out of `artifact-format`.
- `kernel/apiAuth.ts` resolves invisible `X-Loopany-Run` context once into
  run→loop→team/provenance. `LOOPANY_RUN_ID` is attached by the daemon CLI, never an
  argument. Human-only verdict/inbox reject any run context.
- **The human/agent split keys on RUN-CONTEXT presence, never on the credential.** It is
  a positive test for `X-Loopany-Run` (CLI spec §2.2). This is load-bearing, not a
  style note: the ordinary human runs the CLI on the SAME machine the daemon is
  registered on, so a device token is present on every connected machine — keying on it
  made `loopany inbox`/`answer` refuse `NOT_HUMAN` for exactly the person the endpoint
  serves (review f3 B1). With no run context a device credential is the DAEMON class,
  and §2.6 gives it two answers: `NO_RUN_CONTEXT` on a dual endpoint, `UNAUTHORIZED` on
  a human-only one. The CLI belts-and-braces it by not attaching the token on
  `inbox`/`answer` at all (`HUMAN_COMMANDS` in `kernel-cli.ts`).
- **`resolveApiContext` has its OWN integration test** (`apiAuth.integration.test.ts`)
  driving real `Request`s against real machine/run/lease rows, one case per §2.6 cell.
  B1 survived 47 CLI goldens and 33 object-API tests because the goldens stub `fetch`
  and the API tests hand-construct `ApiContext` — neither touches this seam. Only the
  session half is injected (`SessionSeam`), since it is bound to the framework's
  request-scoped context; everything the seam actually decides is driven for real.
- `kernel/objectApi.ts` owns the transactional task/doc/evolve/governance/inbox/verdict
  verbs. Verdict clears the question, writes the human event, and queues R-answer in
  one transaction; approval verification is ownership-first, then event/team, human
  entrance, and approving-task ownership.
- Every refusal uses the flat `{code,message,issues,hint}` envelope from
  `kernel/refusals.ts`. `routes/api.events.stream.ts` is a team-scoped DB-tail SSE
  invalidation stream; authoritative content is always refetched from object/view APIs.
- **`kernel/refusals.ts` is a CATALOGUE, not a code list**: every `RefusalCode` has a
  first-class `{message, hint}` template, so a refusal can never reach an agent as a
  generic envelope. Adding a code without a template fails to typecheck;
  `refusals.test.ts` is the guard table (CLI spec §8) and asserts each entry renders a
  real sentence, a real hint, and a 4xx status. Call sites override with the offending
  value; they may never emit a bare code.
- **The human-only question-clear is covered at THREE altitudes** and all three are
  tested: the route (`resolveApiContext(…, "human")`), the field surface
  (`patchTask`/`replaceFromArtifact`), and `applyUpdateIn` itself. The unit-2 review's
  NB-1 asked for two; the third is free because the kernel guard is entrance-based.
  Note the file path is a clear in disguise — dropping `needs_human` from a whole-file
  replacement discards a live question, so it is refused too.
- **A verdict JOINS only a not-yet-claimed run, it never refuses the human.** The
  transactional lookup covers kernel `queued` / production `pending`; an executing
  run has already consumed its delivery, so a new trigger gets a fresh pending row
  and the poll guard holds it until the sibling finishes. This preserves the human's
  context without allowing two agents on one loop.
- Two response fields are ADDITIVE to API spec §1.5, and both exist for the CLI:
  `total` (so a truncated page prints `count: N of T total` instead of clipping
  silently) and `viewerLoop` (the caller's own loop id from run context, so a hint can
  inline a real id instead of a placeholder).

## The rewrite CLI (`packages/daemon/src/kernel-{cli,render,help}.ts`)

- Three modules, split so the goldens are testable without a server: `kernel-render.ts`
  is the PURE axi/TOON grammar (quoting rule, typed lists, the five-part teaching
  envelope, status→slug, status→exit) with no I/O and no clock; `kernel-help.ts` is ONE
  table behind the `--help` screen, the `allowed[N]:` line and the local grammar check,
  so those three cannot drift; `kernel-cli.ts` routes, validates flags, and renders.
- **The CLI validates FLAGS, never front matter.** A flag is the CLI's own surface, so
  unknown flags / contradictory flags / `self` where a loop id belongs / a signed
  `--since` / a flag-and-file conflict are refused locally at exit 2 before any side
  effect. Front-matter validation stays server-side at the one artifact seam — a
  client-side validator would be a second copy of the closed key set.
- `wrote:`/`expected:` print VERBATIM (unquoted); only the `error:` sentence is quoted.
  They are the literal "you wrote / expected" pair an agent diffs, not prose it parses.
- Exit codes are a pure function of the HTTP status (`exitForStatus`): 404→3,
  401/429/5xx→1, other 4xx→2. **401/429 are exit 1, not 2** — neither is a mistake in
  the command and rewriting it cannot fix either (adjudicated against the API spec's
  blanket "all 4xx exit 2", `decisions-2026-08-03.md` item 11).
- `route.ts` `KERNEL_VERBS` sends `task|doc|loop|inbox|answer` down this path BEFORE the
  legacy run-token callback branch: the rewrite verbs authenticate with the device
  credential plus an invisible `LOOPANY_RUN_ID` header, not the legacy run bearer.

**Known spec drift, deliberately unreconciled** (the two blueprints disagree; the API
spec owns the wire, so it wins):
- `loop evolve` takes a whole loop ARTIFACT (front matter + body) per API spec §1.12,
  not the bare charter body CLI spec §6.9/G24 describes. The cron-equal-is-a-no-op /
  cron-differs-is-`APPROVAL_REQUIRED` rule is unimplementable without front matter.
- Evolve therefore also writes `title`/`payload` (API spec §1.12 lists them as
  non-governance), where CLI spec §6.9 says "the body only".
- The CLI prints `event: ev-…` without CLI spec §6.5's `(seq N)`: mutation responses
  carry the event id only (API spec §1.7), and inventing a second lookup for a display
  parenthesis is not worth a round trip.

## Rewrite workspace UI (`src/kernel/views.ts` + `src/components/workspace/`) — landing unit 5

The five screens over the rewrite kernel, mounted at the flagged `/dev/workspace`
(`lib/rewriteWorkspace.ts`: local dev always, a deployed build only under
`LOOPANY_REWRITE_UI`). The shipping dashboard is untouched — its own route, its own
stylesheet (`styles/workspace.css`, loaded `?url`, every rule scoped under
`.loopany-workspace`), no import from any shipping surface.

- **`kernel/views.ts` is the BFF layer**: one composed, READ-ONLY endpoint per screen
  (`/api/views/{inbox,tasks,task/:id,loops,loop/:id,docs,doc/:id,system-graph}`), each
  gated `resolveApiContext(request, "human")` — a run carrying run context is refused, so
  a view can never become the composed worklist design §6 forbids. Every payload carries
  `cursorSeq` (the `events.seq` it was assembled at); the client skips a refetch for any
  stream message at or below it, which is what keeps a refetch from racing the stream.
- **The §6 inbox union is single-sourced**: `objectApi.inboxUnion`/`inboxCounts` back BOTH
  the raw `/api/inbox` (human CLI) and `/api/views/inbox` (the screen). Changing the
  safety floor in one place changes it everywhere; `views.integration.test.ts` pins the
  surviving branch AND the near misses the two retired arms used to catch (a due task,
  an old one with no follow-up, a closed one) — see the watcher-rule section below.
- **Freshness** (`components/workspace/live.ts`): ONE team-scoped `EventSource`, explicit
  resume at `?since=<highest seq seen>`, `event: reset` → full refetch, two errors inside
  60 s → 30 s polling while the stream keeps retrying. Every external is an injected seam
  (`LiveDeps`), so the whole state machine is unit-tested with no network. **`start()`
  must stay restartable** — StrictMode mounts, tears down and remounts the provider, and a
  bus that treated `stop()` as terminal was permanently stuck on "connecting".
- **Two render paths, and the wall between them** (`components/workspace/Render.tsx`):
  markdown → react-markdown with NO `rehype-raw` (raw inline HTML is simply not rendered —
  the XSS answer, no sanitizer to drift); `format: html` docs → an iframe with
  `srcDoc` + `sandbox="allow-scripts"` and deliberately NO `allow-same-origin` (the two
  together are equivalent to no sandbox). Verified in a browser: the frame reports
  `origin: null`, `document.cookie` throws `SecurityError`, `parent.location` is blocked.
  `render.guard.test.ts` pins all of it by reading the sources with comments stripped.
- **`ExecutionBlock` renders the task payload VERBATIM** next to the answer box — the
  execution-integrity invariant (design §7). The view echoes `payload` as a separate
  `execution` key precisely so that contract is visible at the wire and testable.
- **The system graph is a projection** — `deriveGraphEdges` is pure (one branch per API
  spec §8.3 row) and `components/workspace/systemLayout.ts` is deterministic banded Dagre
  (you / loops), ported from `data/graph-demo-r1/`. Same input ⇒ same coordinates,
  so a refetch never reshuffles the canvas; manual pins live in localStorage.
  (The spec §8.3 "adoption detection" deviation this section used to carry is GONE with
  the pool it described — see "A task's WATCHER is never empty" below.)
- **Local fixture**: `pnpm --filter @loopany/server workspace:seed` writes a full fixture
  THROUGH the kernel (real events, diffs, provenance). pglite is single-writer, so seed
  BEFORE starting `pnpm dev` on the same `LOOPANY_DATA_DIR`. Violating that order does
  not merely fail the seed — it CORRUPTS the data dir: the seed appears to succeed while
  the running server never sees the rows, and the next boot aborts inside the pglite wasm
  (every request 500s `HTTPError`). The recovery is `rm -rf "$LOOPANY_DATA_DIR"` and a
  re-seed, so do not try to salvage the directory.
- **NOT built** (design §9 names it among UI reads; unit 5's brief scoped it out): a
  dedicated run history/detail screen and `/api/views/run(s)`. Runs surface as strips on
  the loop page (`recentRuns`) and the task page (runs that touched it).

## Rewrite loop CRUD (`objectApi.listLoops`/`loopLifecycle` + 6 CLI verbs) — landing unit 6

Loop CRUD retained on the rewrite surface, so the rewrite CLI is not create-blind. The
CLI is now **18 verbs**; the added six are `loop create | list | show | pause | resume |
retire`. Contracts: API spec §1.16 (which specifies all of them) — note **CLI spec §1/§10
says "there is no `loop list`"**, an absence the captain has since overridden, so that
row of §10 is stale rather than a rule this unit broke.

- **The human/agent split is the whole design.** `loop create` and the three lifecycle
  verbs are HUMAN-ONLY: creating a loop mints a standing cadence and a new actor, and
  pausing/retiring is the operational call the owner keeps. Guarded at two altitudes —
  the route's `resolveApiContext(request, { human: "loop-governance" })` and a
  `mode !== "human"` check inside `createFromArtifact`/`loopLifecycle` — and the CLI
  belts-and-braces it by adding them to
  `HUMAN_COMMANDS`, so the device token is never attached. `loop list`/`loop show` are
  DUAL, like `task list`: a team-scoped read an agent legitimately needs to resolve the
  loop id it is about to name as a `--watcher`.
- **`loop create` binds no MACHINE, and that is the design answering, not an omission.**
  The kernel `objects` row has no machine column and `runQueue.claimOnce` selects queued
  runs by `objects.teamId`, so any machine of the team claims. A loop with `cron:` is
  armed at birth (`createObjectIn` sets `next_fire`); without one it never fires on its
  own, and the create render says which of the two was born. It DOES bind a
  **directory** — see the unit-10 note, which added `workdir:` to the loop key set.
- **`key` is on `KIND_KEYS.loop`** (`artifactSeam.ts`) even though API spec §1.16 writes
  the loop key set as `title, cron, payload`: the same paragraph promises "the same
  key-idempotency rule as tasks", which is unreachable without a key, and
  `serializeKindArtifact` emits `key:` for every kind — so without it `loop show --file`
  produced a file its own parser refused. The round trip is verified end to end.
- **An ABSENT payload serializes as an ABSENT key** (`serializeKindArtifact`, review F1):
  `payload: {}` re-parses to an empty mapping, which `expressedDiffs` reads as different
  from a null payload — so the canonical file the CLI itself emits reported a spurious
  `differs: payload` on create replay (and wrote a junk `null → {}` diff event on the
  task/doc `--file` update path). An explicitly empty `payload: {}` in the file is still
  a value and survives. Pinned by `artifactSeam.test.ts` + the loop round-trip case in
  `objectApi.integration.test.ts`.
- **A human-only refusal names the SURFACE it refused** (`apiAuth.ts` `HumanSurface` /
  `NOT_HUMAN_TEACHING`, review F2): the route guard answers before any kernel function
  runs, so the kernel's careful proposal-path hint in `createFromArtifact`/`loopLifecycle`
  was unreachable at the wire and every run got the inbox voice. `resolveApiContext` takes
  `{ human: <surface> }` where the teaching differs; plain `"human"` keeps the inbox
  default.
- **A replay's "not applied" hint may only name routes that EXIST** (review F3): with
  `PATCH /api/loops/:id` unbuilt and `loop evolve` agent-only, a human whose keyed loop
  file differs has NO CLI path today — so both the server notice
  (`applyDifferingHint`) and the CLI hint (`kernel-cli.ts` `renderCreate`) say the loop
  page, name evolve as the run's move, and flag that a differing `cron:` is
  `APPROVAL_REQUIRED` even then. Revisit both together when the human loop edit lands.
- **`retire` IS the D in CRUD, and the CLI says so.** No hard delete exists anywhere on
  this surface (the kernel is event-sourced). `NEAR_MISS` in `kernel-cli.ts` turns
  `loop delete|remove|rm|archive|close`, `task delete` and `doc delete` into a teaching
  refusal that names the property, not just the spelling. Retirement is terminal:
  `loopLifecycle` refuses a move out of `retired` by name (`RETIRED`, 409), and
  `replaceFromArtifact`/`governLoop` already froze the charter.
- **Repeating a lifecycle verb is a SUCCESS with `changed:false`**, the same ruling
  `task close` carries — a retry after a dropped connection must be free. Only the
  out-of-`retired` moves refuse.
- **`--status` takes a VALUE, unlike `task list`'s boolean pair**: a loop has three
  states, so no two-flag form spans them honestly. Absent ⇒ the whole roster, retired
  included.
- **`refusalResponse` now floors an unmapped code at 400.** Several call sites widen a
  kernel result code into the refusal envelope with `refusal(result.code as never)`; a
  code with no `REFUSAL_STATUS` row resolved to `undefined`, which `Response.json`
  renders as **200** — a refusal reaching the CLI as a success at exit 0. Pure hardening
  (no shipped code path reached it), but do not remove the floor.
- **Still NOT built, deliberately** (out of unit 6's enumerated scope, spec'd at API
  spec §1.16 if a later unit wants it): `PATCH /api/loops/:id`, the human's whole-file
  loop edit — so a person who typo'd a charter must fix it through a run's `loop evolve`
  or the web UI, since evolve is agent-only. `POST /api/loops/:id/run-now` WAS in this
  list; unit 10 built it (route only, still not a CLI verb).

## The Tasks screen: a grouped LIST by default, the kanban as an alternate view

Captain direction (2026-08-04) settled the shape on three points: **rows and cards carry
NO action** (every write moved into the task drawer), the **row list grouped by loop is
the DEFAULT** with the kanban behind a remembered toggle, and both views show the same
safety-floor counters. `/api/views/tasks` composes ONE payload for both — there is no
list endpoint beside the board one, because a second shape for the same screen is exactly
the drift the BFF rule forbids. The raw `/api/tasks` (`objectApi.listTasks`, the human
CLI) is untouched.

- **`kernel/taskBoard.ts` is the ONE column mapping** — pure, clock-free, no imports:
  `BOARD_COLUMNS` (key + label + the one sentence that explains the column, which ships
  in the payload so the client never restates the lifecycle) and `columnFor(facts,
  stamp)`. A column is not a new state: the kernel has two (`open → closed`) plus three
  facets (`pendingQuestion`, `watcher`, `followUpAt`), and a column names one cell of
  that fact table. Precedence is `closed → waiting → due → watched`, so the
  mapping is TOTAL and DISJOINT by construction — `taskBoard.test.ts` asserts both over
  the whole fact-table cross product, because a board that drops a card hides work.
  The §6 safety-floor counters ride the board payload (`counts`, single-sourced from
  `inboxCounts`). NB the fifth column `unclaimed` and the facet `watcher` both left this
  mapping with the watcher rule — see "A task's WATCHER is never empty" below.
- **`components/workspace/taskList.ts` is the ONE list mapping** — pure, no DOM:
  `groupTasks` puts every task in exactly one group (one group per WATCHING loop,
  ordered by title, then `closed` last — the `unclaimed` pool group left with the
  watcher rule, below), and
  closedness is read FIRST so a closed task never sits on the desk of the loop that used
  to watch it. `taskList.test.ts` asserts totality + disjointness over the whole fact
  table, for the same reason `taskBoard.test.ts` does. The module also owns the remembered
  view (`readTasksView`/`writeTasksView`, localStorage `loopany-workspace-tasks-view-v1`,
  storage passed IN so it stays pure and SSR-safe — same pattern as the System canvas's
  manual pins). Grouping by loop is deliberate: the board answers "what is true about this
  task", the list answers "whose work is this". Question + overdue stay as row BADGES;
  turning them into groups would just be the board again.
- **`components/workspace/board.ts` says which ACTIONS a task offers** — pure, tested
  without a DOM, and unchanged by the move: it always answered *which* acts exist, never
  *where* they render. **There is NO drag-and-drop, by product decision**, and now no
  on-row/on-card control either — a row or card is one button that opens the drawer, and
  `TasksPane`'s `TaskActions` (inside the drawer) is the only write surface: `close…`
  (note collected BEFORE the write, since the kernel requires it), the `watcher` PATCH
  (TRANSFER only, a picker because a loop must be named; `release` went with the
  unclaimed state), and the verdict box for a task that is asking. Answering IS the move
  there, since the kernel refuses a close while a question is pending, and a person
  should not have to leave for the Inbox to make it. `cardActions`/`hasActions` stay an AFFORDANCE layer,
  never authority: the kernel re-decides every write and its refusal renders verbatim.
  Two details worth keeping: the drawer restores focus to the ROW that opened it (the
  opener element is captured from the click, not guessed from `document.activeElement`),
  and the answer confirmation lives in `TaskActions`, NOT in the answer box — a successful
  answer clears the question, which unmounts the box, and the line saying what the answer
  did has to outlive it. `board.test.ts` pins the absence of any drag wiring AND of any
  action on a row or card; `TasksPane.test.ts` drives the screen in jsdom (default view,
  grouping, toggle persistence across a remount, each drawer write, focus restore).
- Verified against the seeded pglite stack (`workspace:seed` then `LOOPANY_PORT=… pnpm
  dev` on the same `LOOPANY_DATA_DIR`, own port + own data dir): both views, no card
  draggable and no column a drop target, hand-off / close-with-note / answer all
  driven FROM THE DRAWER only, the toggle surviving a reload, an out-of-band `PATCH`
  moving a card over SSE with no user action, zero console errors, and no page-level
  horizontal scroll at 760px or 700px (the board still scrolls inside its own pane).

## The workspace wears the GRAPH line's design language — landing unit 8

Captain direction: the rewrite workspace should look and feel like the graph workspace
(branch `fm/graph-testing-deploy-t2`, deployed at `/dev/workspace` on loopany-testing).
This is an adoption of that design system, not a recolor — the shell, the layout grid,
the type scale, the tokens, the row/card/section shapes and the drawer all come across.
Functional contracts were untouched: execution renders verbatim, the doc sandbox stays
opaque-origin, SSE still drives every screen, and every write still goes through the
existing button → `/api/*` paths.

- **COPIED, never imported.** Both lines own a `components/workspace/` directory AND a
  `styles/workspace.css`, so they already conflict at the chain merge; sharing a module
  would only deepen it. Lifted into the rewrite's own tree: the whole token block + the
  Instrument Sans `@import` (the rewrite named the face but never loaded it, which is why
  it used to render in a system font), `.sidebar`/`.loop-mark`/`.sidebar-status`,
  `.document-view` + `.view-header`, the tinted section cards, the `.artifact-row` grid,
  `.state-label`, the three button weights (`.verdict-button` / `.attn-button` /
  `.attn-button.is-quiet`), the `.preview-scrim` drawer, `.system-view` + `.graph-panel` +
  `.canvas-key` + `.system-node`, and the reduced-motion + breakpoint blocks. If you are
  diffing the two sheets, expect them to agree down to the hex values.
- **TEMPERATURE IS A RULE, not a palette.** Amber = a decision you owe; rose = a
  consequence that did not happen; blue = a decision already made, on its way out. The
  rewrite's inbox reason maps onto it: `question` is amber (the other two, `due-unwatched`
  and `orphan`, retired with the unclaimed state — see below; anything that is not a
  decision you owe stays rose). `parts.tsx` `reasonTone` is
  the single place that mapping lives — do not re-decide it per screen.
- **One shell, one detail surface.** Every screen is now a centered `.document-view` with
  a `ViewHeader` (breadcrumb → large tight title → sentence → right-aligned meta), and
  ALL detail — task, loop, doc — opens in the shared slide-in `Drawer` (`parts.tsx`).
  The old `ws-split` two-track layouts on Loops and Docs are gone; a drawer keeps the list
  full-width whether or not something is open, and it owns the keyboard while up.
- **The counters have three homes and one source.** `CountStrip` on Inbox and Tasks, the
  rail's Inbox badge, and the rail's bottom status line all read `counts` from the view
  payloads (`inboxCounts`), so they cannot disagree. The rail fetches `/api/views/inbox`
  itself on the same live bus — that is what makes the safety floor legible from the
  System tab, not just from the Inbox.
- **`ExecutionBlock` was reframed, never re-rendered.** Keys stay monospaced, values stay
  in a `<pre>` fed by `scalar`, entries stay `Object.entries` in payload order. A design
  language may decorate that block; it may never render its contents. Checked at the wire
  in the browser: rendered keys/values are byte-identical to the view's `execution`.
- **Parallel graph edges fan and their labels slide** (`SystemGraph.tsx` `routeEdges` +
  `CountEdge`). A pair of loops routinely has more than one relation (asks AND answers),
  and drawn on one axis their two counts printed through each other. The lane is assigned
  per unordered source→target BUNDLE and both the bow and the label offset are computed in
  the bundle's CANONICAL direction — measured from each edge's own source they cancel out
  between a forward and a reverse edge, which is the bug that made the first fix a no-op.
- Verified in a browser on a seeded pglite stack at its own port: all five screens, the
  inbox answer (lands a `question-answered` human event, counters drop across all three
  homes), hand-off / close-with-note, the html doc's in-frame self-probe still
  printing `origin: null · app cookies: threw: SecurityError · parent.location: blocked`,
  the System canvas, zero console errors, and no page-level horizontal scroll at 760px
  (the board still scrolls inside its own pane). NB the deployed graph reference is
  allowlist-gated, so signed out it renders `SignIn` — to compare against it, render the
  branch's own `styles/workspace.css` with its `WorkspaceView.tsx` markup instead.

## Real local execution on the rewrite line — landing unit 10

The rewrite stopped being display-only: a local daemon claims kernel runs and a real
agent executes them in the loop's own directory. Two captain rulings shape it
(2026-08-04, amending design §8 / API spec §1.16, which predate them): **a loop BINDS a
workdir like the shipping product does**, and **reuse the original daemon mechanics**
rather than forking a second execution stack.

- **`objects.workdir` is a loop facet** — a real column with a `objects_workdir_loop_only`
  CHECK (migration `0005`), on `LOOP_ONLY_FIELDS`, and a first-class `workdir:` key in
  `KIND_KEYS.loop`. Deliberately NOT `payload.workdir`: the free zone is writable by a
  charter, and WHERE a loop executes must sit behind the same governance gate as WHEN.
  Absolute paths only — the claiming machine is unknown at write time, so "relative to
  what?" has no answer the server could give.
- **Moving it is governance, exactly like moving the cron.** `loop evolve` refuses a
  differing `workdir:` with `APPROVAL_REQUIRED`; `governLoop` (`POST /api/loops/:id`)
  now takes `cron` and/or `workdir` under the one approval gate, so that refusal names a
  route that exists (the unit-6 F3 rule).
- **No MACHINE is bound, and a machine that lacks the directory FAILS the run.** Prod
  `mkdir -p`s a declared workdir, which is right when the loop was bound to one machine
  at birth; here any machine of the team claims, so creating it would run the charter
  against an empty lookalike of the repo it names. `runner.ts` `resolveWorkdir` takes
  `requireExisting` (set from the claim's `execution.requireWorkdir`) and reports a
  teaching failure naming the path, the host and "nothing was created". The legacy path
  is byte-for-byte unchanged; the daemon's own scratch dir (no bound workdir at all) is
  still created on demand.
- **`gateway/enroll.ts` is the ONE machine-enrollment gate**, shared by production
  `poll` and the dormant rewrite claim (`enrollDeviceForClaim`). The latter fixed the
  S2 dual-transport stage; S3 daemons use production poll exclusively, while the old
  claim symbol remains until S5 cleanup. The frozen machine-id derivation is shared.
- **`routeSupport.ensureBooted()` is the rewrite line's boot entrance**, called first in
  every rewrite route. `ensureServer()` used to be reachable only from a legacy server
  fn, so a rewrite-only stack never migrated (a fresh pglite dir 500'd with `relation
  "teams" does not exist`) and — worse — never started `RunQueueScheduler`, so no loop
  ever fired.
- **The kernel CLI attaches the device token only WITH run context** (`kernel-cli.ts`).
  §2.6 answers a device credential and no run context with `NO_RUN_CONTEXT` on a DUAL
  endpoint, so `loop show`/`loop list`/`task list` refused the owner on every machine the
  daemon is registered on — the unit-4 review's B1, one layer out. `HUMAN_COMMANDS` stays
  for the other direction (a human verb typed inside a run).
- **`POST /api/loops/:id/run-now`** (`objectApi.runLoopNow`) is the manual fire, human
  only like the lifecycle verbs. It reuses `queueKernelRun`'s `manual` reason and joins
  the transactional open-run lookup (a second call reports `alreadyQueued`), then wakes
  the matching claim transport so a parked poll does not wait out its ~20s hold.
- **PAUSE GOVERNS THE CADENCE, NOT THE BUTTON** (captain ruling 2026-08-04, amending the
  original unit-10/11 behaviour). A PAUSED loop accepts `run-now` exactly like an active
  one: pause clears `next_fire` so the CLOCK can never select it, and a manual fire is an
  explicit human act, not the clock. The old refusal conflated the two and made a parked
  loop runnable only through a resume/fire/pause dance that leaves a real window in which
  the cadence is live. **Firing does not resume** — status stays `paused`, `next_fire`
  stays null, no `loop-resumed` event — so it is one run, then quiet again. RETIRED still
  refuses (`RETIRED`, terminal, charter frozen). The claim path had to move with it:
  `claimOnce` selects `inArray(objects.status, ["active","paused"])`, because an accepted
  fire that no machine may claim is worse than an honest refusal; `tickRunClock` and
  `armUnarmedLoops` still select `active` only, which is the whole of what pause means.
  Pinned by `objectApi.integration.test.ts` (fires paused, does not resume, retired
  refused) + `runQueue.integration.test.ts` ("a paused loop's manual run is claimable")
  + `runNow.test.ts` (the UI path).
- **A RUN LEASE is renewed only by ATTESTATION, and reclaim is the SCHEDULER's job**
  (review F1, fixed 2026-08-04). The claim body carries `inFlight` — the run ids the
  daemon says it is still executing (`daemon.ts` `buildClaimBody`, sent always, empty
  included, so "I am running nothing" is sayable) — and `renewMachineLeasesIn` renews
  only those. Renewing every lease of a live MACHINE substituted machine liveness for
  run liveness, and a daemon that crashed mid-run defeated the substitution: it restarted
  with an empty in-flight set and its own polls kept the orphan "running" forever. The
  legacy line keys its sweep on per-run progress freshness for exactly this reason.
  A daemon too old to attest therefore renews nothing and its runs are reclaimed after
  the lease — the cure, not a regression (reclaim RE-QUEUES; only exhausted attempts
  fail). The other half: `RunQueueScheduler.tick` now runs `reclaimExpired` after
  `tickRunClock`, so reclaim no longer depends on some daemon happening to poll — before
  this, `reclaimExpired` had NO production caller and a team whose only machine died
  reclaimed nothing, ever. Both halves are pinned by `runQueue.integration.test.ts`
  ("F1: only an ATTESTED run keeps its lease"), which fails on the pre-fix code.

## `Run now` on the Loops screen — landing unit 11

The workspace's Loops drawer gained the manual fire (`postRunNow` → the unit-10 route),
so the rewrite matches the shipping dashboard's one UI-triggered run. Three rules, each
the kind a later change breaks by being helpful:

- **The button is NEVER pre-hidden or disabled by status.** It fires a PAUSED loop for
  real (the captain ruling above — one run, and the loop stays paused); a RETIRED loop is
  refused by `runLoopNow` with a sentence AND a hint saying retirement is terminal.
  Gating the button client-side would replace that teaching with silence and put a second
  copy of the lifecycle rule where it can drift. The refusal renders through the shared
  `Refusal` exactly as the CLI prints one. `runNow.test.ts` pins both halves — a paused
  loop queues with no refusal on screen, and a retired one shows code/sentence/hint.
- **It lives on the DRAWER, not the list row.** `ArtifactRow` IS a `<button>` (that is
  what makes the whole row one keyboard target), so a control in its action slot would
  be a button inside a button. Adding a row-level action means restructuring that shared
  primitive for every screen, not just this one.
- **Nothing waits for the run.** Queuing is the act; the run reaches `Recent runs`
  because `run-queued` carries the loop's own object id, so the drawer's existing
  `affectsLoop` refetch already covers it. The post-write `refresh()` only removes the
  round trip's wait.

Verified in a browser on an isolated seeded stack (own port + `LOOPANY_DATA_DIR`, no
daemon — a queued run is the proof): a fresh fire renders `Queued. Run run-…` and the
run appears in the strip; a second fire on a loop that already had one queued reports
that run instead of minting a twin; and an out-of-band `POST …/pause` moves the drawer to
`PAUSED LOOP` over SSE with no user action. (The last leg of that walkthrough — firing a
paused loop rendering a `PAUSED` refusal — is superseded by the captain ruling above:
the fire now succeeds and the loop stays paused.)

### The isolated-stack recipe

Use a fresh non-3000 port, data directory and `LOOPANY_HOME`; set them explicitly for
the shell you control. Never point convergence work at the captain's demo stack and do
not source `scripts/rewrite-local-run.env.sh`. S3 needs no runtime flag: server and
daemon use the production poll path.

```sh
(cd packages/server && LOOPANY_PORT=$LOOPANY_PORT pnpm dev)          # terminal 1
(cd packages/daemon && LOOPANY_ROOTS="$LOOPANY_RW_BASE" \
   ./node_modules/.bin/tsx src/cli.ts up --foreground)               # terminal 2
```

- **`up --foreground` is the ONLY safe daemon launch here.** Plain `up` runs `ensure`,
  which writes the REAL `~/.local/bin` shim and `~/.claude/settings.json` hooks
  regardless of `LOOPANY_HOME`. `--foreground` classifies straight to `runDaemon`.
- **`LOOPANY_ROOTS` must CONTAIN every workdir the stack's loops bind** (review F3). The
  line above jails the daemon to `$LOOPANY_RW_BASE`, which covers the smoke loop and
  nothing else — a loop bound to a real checkout (both twins are) fails every run with
  `workdir <path> is outside this machine's allowed roots` until the checkout is named
  too. The list is COMMA-separated (`daemon.ts` splits on `,`) and read once at daemon
  start, so widening it means a restart. `scripts/rewrite-twins/README.md` carries the
  release-time form; keep the jail narrow the rest of the time.
- **A BOUND workdir is never created for you** — that is the whole point of
  `requireWorkdir` — so the env script `mkdir -p`s the smoke loop's scratch dir
  (`$LOOPANY_RW_SCRATCH`, review F4). `scripts/rewrite-smoke-loop.md` hard-codes the
  DEFAULT base's path in its `workdir:`, so edit that key if you override
  `LOOPANY_RW_BASE`.
- **Registration is automatic and needs no separate step**: the first production poll enrolls the
  machine from its `dk_`-shaped token (open mode ⇒ `team-shared`, which is also
  `requestScope`'s open-mode team, so the human CLI and the daemon share a scope).
- Create a loop through production `loopany new --json`, or converge a seeded kernel
  loop with `kernel:converge-loops`; fire it through the workspace Run-now action and
  read the result through production `loopany show` plus the loop drawer/event timeline.
- State lives in exactly three places: the server's pglite dir (`LOOPANY_DATA_DIR`), the
  daemon's `LOOPANY_HOME` (device token, server URL, pidfile, callback bin, scratch
  dirs), and each loop's bound workdir. Stop with `pkill -f "up --foreground"` then the
  dev server; a restart re-uses the same token, so the machine identity is stable.
- `scripts/rewrite-smoke-loop.md` is the harmless read-only smoke loop that proves the
  path end to end. `scripts/rewrite-twins/` holds the two Housekeeper twins — local dual
  runs of the production loops, binding the SAME workdirs and the same `0 7 * * *`
  cadence. Both carry outward effects (branch push + `gh pr create`; the superdesign one
  also closes PRs and installs from the registry), so by captain decision they are
  **created but held PAUSED**: a paused production loop has `enabled=false`, so it never fires on its
  own and every run it ever does is one somebody asked for. That README carries the full
  side-effect inventory and the fire/pause commands.
- **A paused loop is AUTONOMOUSLY inert, which is what makes staging safe**: `pause`
  clears `next_fire`, so the clock can never select it — nothing runs unless a human
  presses `run-now`, and that fire leaves it paused (captain ruling above). Stage a risky
  loop by creating it with the daemon DOWN and pausing in the same breath — that leaves
  no window in which its birth-armed cadence could be claimed.

## The DEV entry surface — converged local workspace

- `scripts/loopany-dev` selects `kernel-home.ts` with presentation-only
  `LOOPANY_DEV_HOME=1` and refuses non-loopback servers. `LOOPANY_RUNS_V2` no longer
  selects any runtime path. Bare production `loopany` keeps the production home.
- The local home composes `/api/views/loops` (now the production roster + shared run
  strip) and `/api/inbox`; it stays a human/no-device-token surface and degrades to a
  definitive exit-0 view. `dev-entry.test.ts` pins the boundary.
- Global help signposts production `loops`/`show`/`new`/`edit` for loop ownership and
  the event-sourced task/doc/mirror verbs for workspace work. Old kernel `loop *`
  commands return local `SURFACE_MOVED` teaching and perform no request.
- `packages/daemon/skill-dev/` remains a separate, non-npm skill distribution. It
  teaches this converged surface and the managed-stack contract: on-PATH
  `loopany-dev` only; never bare `loopany`, never source the platform env script,
  never operate the stack lifecycle; retry one unreachable read after ~30s, then stop.

## A task's WATCHER is never empty, and a due task WAKES it

Captain rulings, 2026-08-04. `watcher` named the loop that acts next but was allowed to
be absent, and the system carried a pile of machinery whose only job was to notice that
absence (an unclaimed pool, claim-from-pool, a 48h orphan floor, a due-unwatched inbox
arm). Forbidding the absence DELETED the machinery. The reasoning lives in
`kernel/types.ts` `WATCHER_HINT` — read that, not a summary here.

- **The rule is enforced at the KERNEL's two chokepoints**, `createObjectIn` and
  `applyUpdateIn`, so every caller inherits it: the HTTP verbs, the whole-file replace,
  the circuit breaker's auto-pause question and `workspace:seed` alike. A loop-created
  task DEFAULTS to `createdByLoop`; a create with no creating loop is refused
  (`WATCHER_REQUIRED`, 400). Deliberately NOT a DDL CHECK: the rule has a defaulting
  half a constraint cannot express, and the migration would break any stack holding
  pre-rule rows. The teaching altitude is the floor here.
- **Transfer stays, release is gone.** `watcher: null` is refused everywhere — API,
  CLI (locally, before the round trip, `loopIdRefusal`), and the UI cannot even express
  it (`transferWatcher` takes a plain `string`). The drawer's picker also excludes the
  loop already watching, since that write changes nothing.
- **R-DUE is the other half** (`runQueue.tickDueTasks`, run reason `due`, `ids.dueRunId`):
  a watched task whose `follow_up` arrives wakes its watcher, scoped `task:<id>`. Same
  level-triggered clock as the cadence, so nothing is consumed and the fire is idempotent
  per (loop, task, THAT follow-up instant) — one due instant queues exactly one run
  however many passes see it, and a re-armed `follow_up` queues a fresh one. **Enabled
  production watchers only** after S3: a paused loop's due task fires on the first scan
  after re-enable (level trigger, nothing lost), while a deleted/dangling watcher is
  logged and skipped without mutating the task. `runs.reason` is a TS-only drizzle enum,
  so widening it needed no migration.
- **Retire WARNS, never blocks.** `loopLifecycle` counts the open tasks the loop still
  watches and returns a `warning` (`retirementWarning`); the CLI prints it as its own
  `warning:` line above the detail block (a fact about what happened, not a hint about
  what to do next — the repair goes in `help[]`), and the loop drawer confirms BEFORE
  with the count it can see and renders the server's warning verbatim AFTER. Blocking,
  force-transferring and cascading were all explicitly declined.
- **What retired with the state, and why it is ABSENT rather than empty**: the
  `unclaimed` board column and list group, the `pool` graph node and its
  `produces`/`adopts` edges (which retired the old §8.3 adoption-detection deviation
  with them), the `orphan`/`due-unwatched` inbox arms and counters, and
  `task list --unwatched` / `watcher=none`. A permanently-zero counter or column is not
  a reassuring fact — it teaches a distinction the kernel stopped making, and invites
  someone to "fix" the emptiness by reintroducing the state. `inboxCounts` is now
  `{question, total}`; the union SHAPE (`reasons[]`, `reasonRank`) is kept because the
  inbox is where a future human-attention branch lands.
- The loop drawer gained the operational lifecycle (pause/resume/retire) so the warning
  has a UI home. Nothing there is pre-hidden or disabled by status — the same discipline
  `Run now` keeps, pinned by `runNow.test.ts`: repeating a landed verb is a success with
  `changed:false`, and a move out of `retired` is refused BY NAME, so a client-side gate
  would only replace that teaching with silence.
- Verified end to end on an isolated stack (own port/data dir/`LOOPANY_HOME`) with a real
  daemon: a due task queued exactly one run, held at one across ~6 further ticks, was
  claimed and EXECUTED to `success`, and a re-armed `follow_up` queued a second; paused
  and retired watchers queued none, and the paused one fired after `resume`; retire warned
  with the count and proceeded, leaving its tasks untouched; the workspace showed no
  pool/orphan/unclaimed surface on any screen and every card named its watcher; zero
  console errors, no page-level horizontal scroll.

## Intent, reality, state — landing unit 17 (mirrors, directives, no UI close)

Captain-designed, 2026-08-04. Three changes over one principle: **the human
expresses intent, agents reconcile reality, state follows.** Each is a rule that
a later "helpful" commit breaks by softening it, so each is welded rather than
documented.

### `mirror` — the fourth object kind

A pure POINTER to something outside the system, so a run reading a task can see
which external items it must go and check. `kernel/mirrors.ts` owns the pure half
(vocabulary, normalization, coords validation, the law); `kernel/mirrorApi.ts`
owns the transactions. Read those headers, not a summary here.

- **STATELESSNESS IS ENFORCED BY SCHEMA.** A mirror row has no `payload` (the
  declared free zone) and no `body` — `objects_mirror_stateless` — so there is
  physically nowhere for `state: merged` to land. The "cache the status just this
  once" commit cannot be written, not merely discouraged. Welded at three
  altitudes and all three are tested: the DDL CHECK (proven by raw SQL that
  bypasses every application guard), `types.ts` `statelessIssues` (the teaching
  refusal), and `patchMirror`'s by-name refusal of `state`/`status`/`merged`/… —
  by NAME, because "unknown key" reads as a spelling problem and this is a
  modelling one. The mirror's single status `current` is deliberately a
  singleton for the same reason.
- **One external thing is ONE mirror.** Id and key both derive from
  `(team, kind, coords)` (`ids.mirrorObjectId`, `mirrors.mirrorKey`), so a second
  attach resolves to the existing row through the kernel's ordinary
  key-idempotency — there is no find-or-create branch. `attachedTo` is a jsonb
  set on the MIRROR (`objects_mirror_attached_idx`, GIN); attach/detach are
  ordinary `applyUpdateIn` writes of it, so their events land on the mirror's
  timeline, and every `show` composes `mirrors[]` by reverse lookup
  (`mirrorsFor`). A task carries no pointer column and is FOUND BY its mirrors.
- **Coords are IDENTITY**, on `IMMUTABLE_FIELDS`, refused with the two-step
  detach-and-attach teaching at the kernel, at `PATCH /api/mirrors/:id`, and
  locally in the CLI's `unknownFlagRefusal` near-miss branch (a bare "unknown
  flag --coords" would be true and teach nothing).
- **A mirror is NOT authored as a file.** `types.ts` `ARTIFACT_KINDS` excludes it
  and `KIND_KEYS` is keyed on `ArtifactKind`, which is also what keeps it from
  growing a body. Its two creation doors are the flag one-liner and an inline
  `mirrors:` block, which is a CONSTRUCTOR ARGUMENT and not a field:
  create-only, refused by name on the replace path, and never emitted by
  `serializeKindArtifact` — otherwise a whole-file update would silently detach
  every mirror the file happened not to mention, and `show --file` would emit a
  file its own re-upload duplicated.

### Directive — the human speaks without a pending question

`objectApi.leaveDirective` (`POST /api/tasks/:id/directive`, CLI `task tell`)
writes a human `directive-left` event on the task and queues one run for its
watcher, scoped to it. Same wire as the answer path, opposite entrance.

- **Its OWN run reason (`directive`), not a subtype of `answered`.** An answer
  replies to a question the agent framed; a directive arrives unframed and the
  run's first job is to work out what it implies. A run that could not tell them
  apart would read an order as a reply to a question it never asked.
  `runs.reason` is a TS-only drizzle enum, so widening it needed no migration.
- **`runs.trigger_event_id` is the new column, and it fixed the answered path
  too.** Both reasons already DERIVED their run id from the human's event, so the
  pointer existed but was unreadable; storing it lets `claimRun` read the note
  back and put the person's words in the work order VERBATIM, labelled
  `directive` or `answer` so an agent can never confuse the two. It is a
  pointer, never a copy.
- **A pending question REFUSES it** (`OPEN_QUESTION`, pointing at `answer`): the
  person already has the floor, an answer is free text so any instruction fits in
  one, and the run this would queue could not clear the question anyway.
- It obeys the transactional open-run lookup like the verdict does — reports the open
  run rather than stacking. Nothing is lost: the directive is on the task's timeline,
  which that run reads when it claims.

### The UI drops direct close

The close action left the task drawer entirely (`board.ts` has no `canClose`,
`api.ts` has no `postClose`, and `board.test.ts` asserts both ABSENCES so a
re-add has to defeat a named test). The reasoning, which the code comments carry
in full: a human closing a task settles the kernel's record while the world it
describes carries on unchanged — the PR still open, the branch still there, and
the loop that would have cleaned them up now looking at a closed task it will
never act on again.

- What replaces it is `TellBox`, ONE composer in two modes (`board.ts`
  `tellMode`): it ANSWERS while a question is pending and otherwise leaves a
  DIRECTIVE. One affordance, because from the person's side it is one write —
  free text that queues one run for the watcher. The mode lives in `board.ts` so
  the rule is testable without a DOM.
- The drawer's surfaces are now the verbatim execution block, **External items**
  (the attached mirrors: kind, coords as a link when `href` resolves, note — and
  NO status, because there is none), the timeline, and the composer. `.task-actions`
  owns its own top margin because two different things can precede it now.
- `loopany task close` remains, documented in the skill as the emergency hatch
  for a broken watcher: "when the watcher cannot act, this is the manual exit;
  expect to reconcile external items yourself."

### Verified end to end on an isolated stack (own port 3177, own data dir/HOME)

Mirror lifecycle through the real CLI: inline front-matter create (two mirrors,
one transaction), one-liner attach mid-run, `GitHub PR` → `github-pr`
normalization collapsing onto one row, a second object SHARING that row with the
note-kept notice, an unknown kind accepted, a known kind's coords refused,
coords immutability taught, detach + free-retry detach, the three list filters,
and `mirror kinds`. Directive with a real daemon: the run was claimed, and the
claim body carried `reason: directive` plus the words verbatim. Both composer
modes drove from the browser, the answer flipping the composer to directive mode
with the confirmation outliving the form; zero console errors and no page-level
horizontal scroll at 1440 or 760.

**Two hazards worth not repeating.** (1) A live daemon EXECUTES what you tell it:
a directive naming a real PR had a real agent claim it within seconds. Use
harmless coords for a live directive drill, or read the claim body directly
(`POST /api/agent/runs/claim`) — that IS the agent-side context, and it proves
the same thing without spawning anything. (2) pglite is single-writer, so a raw
schema probe against a stack's data dir must wait until its dev server is
stopped; opening a second PGlite on a live dir is the corruption the workspace
fixture note already warns about.

## Convergence S1 — the watcher speaks prod (`kernel/loopRefs.ts` + `objects.parent_id`)

Stage S1 of the convergence design (`data/rw-converge-s1/report.md` — read it, not a
summary here) made the SHIPPING product's `loops` row THE loop that a kernel object can
point at. It repointed references first; S2 repointed triggers and S3 made production
loops authoritative. Hierarchy UI/CLI (S4) and cleanup (S5) remain later stages.

- **`kernel/loopRefs.ts` is the ONE loop-reference resolver.** `objects.watcher` /
  `created_by_loop` name production `loops` rows after S3, and every surface that turns
  one into a NAME reads through here. Its four rulings live in that file's header; the two that a later
  change breaks by softening: **production ids are used AS-IS** (no alias table — both
  worlds are opaque `loop-` prefixed text, so every existing prefix check already passes),
  and **resolution is not validation** — there is no FK and no existence check at the write
  seam, because a prod loop can be hard-deleted while tasks still name it and the ruling is
  warn-never-block-never-cascade.
- **A dangling reference resolves to a TOMBSTONE, never to `null`.** `null` means "no
  watcher", a state the watcher rule abolished; `source: "missing"` means "the loop is
  gone", which is a fact. `components/workspace/loopLabel.ts` is the one render
  (`deleted loop loop-…`, and not clickable) and every screen reads through it.
- **Production wins an id collision, and `assignable` (not `status`) is the hand-off filter.**
  The stack migration creates prod rows KEEPING the kernel loop id verbatim, so one id
  names a row in both tables through S5; the kernel twin is history-only after S3.
  A prod loop resolves ENABLED OR NOT (the `enabled` gate belongs to the due scan,
  not to reading) — only a kernel `retired` loop and a COMPLETED prod loop are un-assignable.
- **`views.ts` is production-authoritative after S3:** card/grouping refs, the hand-off
  picker, system-graph nodes, Loops pane and loop page all read `loops`; the page renders
  `taskFileContent`, while same-id kernel events remain its history.
- **`tickDueTasks` resolves production watchers only.** It queues enabled watchers through
  the shared run seam; disabled production watchers stay quiet and the level trigger fires
  after re-enable.
- **`objects.parent_id` + the write-time cycle guard landed here** (migration `0007`,
  task-only CHECK + partial index; `applyTransition.ts` `parentIssue` at both chokepoints,
  `PARENT_CYCLE`). Referencing by ID through one write chokepoint is what `feat/task-tree-v2`
  could not have (its parent was a front-matter SLUG with files as the writers), so the guard
  is possible at all and slug-collision ambiguity is gone. `parentId: null` is a legal move
  to root — unlike `watcher: null`. A CLOSED parent is deliberately NOT refused: there is no
  roll-up in either direction. The artifact key, the `--parent` flag and the tree rendering
  are S4, so `parentId` is NOT on `CONTENT_KEYS`/`expressedDiffs` yet — add it to both
  together.
- Migrations mint as **0007+ on the rewrite chain**; 0003–0006 are applied on the captain's
  pglite journal and are never renumbered (the cross-line renumber stays a chain-merge step).
- Verified end to end on an isolated stack (own port/data dir/`LOOPANY_HOME`, seeded before
  boot — pglite is single-writer): grouping headers reading prod loop names, a tombstone
  group for a deleted watcher, the picker offering a DISABLED prod loop, a real watcher
  transfer onto it through the drawer, the prod loop page serving cadence/health/watched
  tasks off the shared `runs` table, the graph drawing the hand-off edge, a live
  `PARENT_CYCLE` refusal, kernel-watched tasks unchanged, zero console errors and no
  page-level horizontal scroll at 1440 or 760.

## Convergence S2 — one run world

Stage S2 repointed every trigger to the shared `queueKernelRun` mint seam before S3 moved
the roster and claim transport. The durable
contract is pinned end to end by `src/kernel/convergenceS2.integration.test.ts` and the
legacy runner environment case in `packages/daemon/src/runner.test.ts`.

- `queueKernelRun` accepts either loop representation. Production rows use the real
  loop `userId`/`machineId`, `phase: pending`, `role: exec`, and NULL `queueState`; kernel
  rows retain their old lifecycle. Due tasks, verdict answers, directives, and both
  run-now paths reuse the frozen derived-id seeds verbatim. Organic events still enter
  through `appendOrganicEvent`; derived events still pass the collision-checked append
  seam.
- Migration `0008` drops `runs_one_queued_idx`. Queueing locks the authoritative loop
  row and joins only a not-yet-executing run: kernel `queued`, production `pending`
  with NULL `queueState`. A trigger arriving during execution queues separately; the
  production poll holds it while a sibling is running, and sweep does not classify
  that guard-held row as never claimed.
- Cron supersede coalesces only provenance-free cadence rows; trigger rows survive.
  A due instant's failed/canceled row re-arms with the SAME frozen id after the loop's
  pending slot clears, while an open or completed row remains the idempotency floor.
- The shipping scheduler's run-now is immediate even for a disabled loop: it clears any
  deferred `nextRunAt`, queues one production run, and leaves `enabled` false. A second
  fire while that run is still pending returns `alreadyQueued`; if it is already
  executing, the new fire queues behind it. The retired deferred-fire-on-enable behavior
  must not return.
- Delivery resolves scoped task/event context for production rows, includes the human's
  directive or answer verbatim as untrusted trigger data, and exports `LOOPANY_RUN_ID` on
  the legacy daemon path. Rewrite API run context can authorize either kernel leases or
  durable production run leases during the dual-transport stage.
- Every terminal shipping path appends the frozen derived `run-finished` event for a
  provenance-carrying row (including sweep/reclaim and the 7-day skipped backstop),
  keeping workspace SSE/timelines live. Event append is best-effort-with-log and can
  never block lease retirement. Ordinary production cron/edit/evolve history remains
  event-silent.

## Convergence S3 — the loops converge

Stage S3 makes production loops and the production poll/report pipeline authoritative,
while retaining kernel loop objects and dormant queue code until S5.

- `kernel:converge-loops` (`kernel/convergeLoops.ts`) is the insert-only operator. It
  requires exactly one stack machine, creates same-id production twins, maps title,
  cadence/timezone, enablement and machine/team ownership, and exclusively materializes
  `<workdir>/loopany-task.md` with the charter under `## Spec`. It never overwrites
  different bytes. Tasks/docs/mirrors and existing events stay untouched; provenance is
  appended only through `appendOrganicEvent`'s attempt rung. Dry-run first.
- The daemon always polls `/api/machine/poll`; `LOOPANY_RUNS_V2` remains only as dormant
  compatibility code until S5 and no longer selects runtime behavior. The local wrapper
  uses `LOOPANY_DEV_HOME=1` only to select the converged home presentation.
- Boot always starts `DueTaskScheduler`, independent of the retired flag. Kernel cadence,
  claim and attestation/reclaim have no runtime producer after S3; prod scheduler +
  progress-freshness sweep cover the live run world.
- Trigger rows carry `runs.claimable_at` (migration `0009`): rows held behind a running
  sibling begin their never-claimed timeout at the first eligible poll/sweep, not creation.
  This closes the sibling-finished-to-next-poll reclaim race.
- `kernel/views.ts`, `loopRefs.ts`, the workspace Loops pane and kernel home read production
  loops. Every old kernel `loop *` CLI command is a local `SURFACE_MOVED` teaching pointer
  to `loops`/`show`/`new`/`edit`; it performs no network call or mutation. The separate
  `loopany-dev` skill teaches the same converged surface.
- **The u16 watched-task warning moved to the PRODUCTION lifecycle**, since the kernel
  loop's terminal `retired` state retires with the loop kind. `kernel/watchedTasks.ts` is
  the ONE author of both the count and the voice — `objectApi`'s `retirementWarning` is now
  a call into it — and the four verbs (`retire`, `pause`, `finish`, `delete`) each phrase
  their own consequence over the shared repair hint. It **warns, never blocks, never
  cascades**: `editLoop` warns on the enabled true→false TRANSITION only (silent on a
  re-asserted pause or a resume; previewed by `--dry-run`), `finishLoop` warns on the
  completion that disables the loop, and DELETE warns BEFORE the choice — `JobDetail.
  watchedTasks` carries the count so the confirm dialog can name it, which a post-write
  warning cannot. **`store.deleteLoop` must never grow an `objects` cascade** (pinned by
  `watchedTasks.integration.test.ts`): a dangling watcher is legal, resolved as a tombstone
  by `loopRefs.ts`, skipped by the due scan, and repaired by a transfer.
- Regression anchors: `convergeLoops.integration.test.ts`, the shipped 17-case
  `convergenceS2.verify.test.ts`, `watchedTasks.integration.test.ts`,
  `runQueue.integration.test.ts`, `views.integration.test.ts`
  and daemon `dev-entry`/`kernel-cli`/`skill-dev` tests. S4 hierarchy and S5 deletion of
  kernel loop objects, queue/claim code and flag symbols are deliberately not part of S3.

## Maintaining this file

Keep entries durable and project-intrinsic (build/test/release, architecture, sharp
edges) — not task narration. Prefer a pointer to the authoritative file/command/test
over copying detail. Update or prune an entry when the code it describes changes; delete
what no longer holds rather than letting it drift. `CLAUDE.md` symlinks here, so one edit
serves both. English only, tight prose.
