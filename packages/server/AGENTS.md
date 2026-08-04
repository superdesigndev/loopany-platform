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
  (pure, teaching refusal) and three DDL CHECKs (`objects_cron_loop_only` /
  `_task_facets_only` / `_format_doc_only`, plus `objects_closed_pair`). Asserting only
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
  collision would be SILENT — swallowed by the same `ON CONFLICT DO NOTHING` that
  implements dedup, handing back a stranger's row. Both halves are pinned by
  `ids.test.ts` + `idCollision.integration.test.ts` (which scripts the mint through a
  partial mock of `ids.js` to stage a collision on demand).
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
  spec name. All are nullable and NULL on legacy rows, so `runs_one_queued_idx` (the
  one-queued-run-per-loop partial unique index) is invisible to shipping history.
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
- **A verdict JOINS an already-queued run, it never refuses the human.** One queued run
  per loop is the queue discipline (`runs_one_queued_idx`), so R-answer reports the
  existing run with `alreadyQueued: true` and the queued run pulls both answered tasks
  when it claims. Refusing here would fail a person's answer for a reason that is not
  about them. Deliberate reading of CLI spec §7.2 over API spec §4.2, whose
  `ON CONFLICT (id)` does not cover the one-queued-run index at all.
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
  three branches AND the near misses (watched-and-due, fresh-and-unwatched, closed).
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
  (you / loops / pool), ported from `data/graph-demo-r1/`. Same input ⇒ same coordinates,
  so a refetch never reshuffles the canvas; manual pins live in localStorage.
  **DEVIATION**: spec §8.3 detects adoption from the `object-created` diff showing
  `watcher` absent — unimplementable, since that event's diff carries only
  `pendingQuestion`, so every watched task would read as adopted. We use the positive fact
  instead: an event moving `watcher` null → a loop id.
- **Local fixture**: `pnpm --filter @loopany/server workspace:seed` writes a full fixture
  THROUGH the kernel (real events, diffs, provenance). pglite is single-writer, so seed
  BEFORE starting `pnpm dev` on the same `LOOPANY_DATA_DIR`.
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
- **`loop create` binds no machine, and that is the design answering, not an omission.**
  The kernel `objects` row has no machine column and `runQueue.claimOnce` selects queued
  runs by `objects.teamId`, so any machine of the team claims. A loop with `cron:` is
  armed at birth (`createObjectIn` sets `next_fire`); without one it never fires on its
  own, and the create render says which of the two was born.
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
- **Still NOT built, deliberately** (out of unit 6's enumerated scope, both spec'd at API
  spec §1.16 if a later unit wants them): `PATCH /api/loops/:id`, the human's whole-file
  loop edit — so a person who typo'd a charter must fix it through a run's `loop evolve`
  or the web UI, since evolve is agent-only; and `POST /api/loops/:id/run-now`, the manual
  fire. Neither is a CLI verb today.

## The Tasks screen is a KANBAN BOARD (`kernel/taskBoard.ts` + `workspace/board.ts`)

The five filters the Tasks list used to offer (Open / Due / Questions / Unclaimed /
Closed) became five COLUMNS — the same state predicates, turned from a chooser into a
layout. `/api/views/tasks` composes them; there is no separate board endpoint, because
the board IS the Tasks screen and a second one would be exactly the drift the BFF rule
forbids. The raw `/api/tasks` (`objectApi.listTasks`, the human CLI) is untouched.

- **`kernel/taskBoard.ts` is the ONE column mapping** — pure, clock-free, no imports:
  `BOARD_COLUMNS` (key + label + the one sentence that explains the column, which ships
  in the payload so the client never restates the lifecycle) and `columnFor(facts,
  stamp)`. A column is not a new state: the kernel has two (`open → closed`) plus three
  facets (`pendingQuestion`, `watcher`, `followUpAt`), and a column names one cell of
  that fact table. Precedence is `closed → waiting → unclaimed → due → watched`, so the
  mapping is TOTAL and DISJOINT by construction — `taskBoard.test.ts` asserts both over
  the whole fact-table cross product, because a board that drops a card hides work.
  Deliberate: due-AND-unwatched lands in `unclaimed` (a date on a task no loop watches is
  nobody's alarm); the card still carries its overdue badge and the §6 safety-floor
  counters ride the board payload (`counts`, single-sourced from `inboxCounts`).
- **`components/workspace/board.ts` says which ACTIONS a card offers** — pure, tested
  without a DOM. **There is NO drag-and-drop, by product decision**: a column renders a
  fact, not a control, and a task changes only through a human entrance the kernel
  actually has — `close` (the one transition, note collected BEFORE the write since the
  kernel requires it) and the `watcher` PATCH in both directions (`claim…` is a picker,
  because a loop must be named; `release` clears it). Each is a labelled button on the
  card, so the board is keyboard-usable and no write can be made by an accidental
  gesture. `cardActions`/`hasActions` are an AFFORDANCE layer, never authority: the
  kernel re-decides every write and its refusal is rendered verbatim. `release` is
  offered on a WAITING card too — consequential (the eventual answer then wakes no loop)
  but a deliberate, named act rather than a spatial one; that combination was exactly the
  misleading green-lit drop the drag surface used to allow. `board.test.ts` pins the
  absence of any drag wiring in the pane.
- Verified against the seeded pglite stack (`workspace:seed` then `LOOPANY_PORT=… pnpm
  dev` on the same `LOOPANY_DATA_DIR`): no card is draggable and no column takes a drop;
  `close…` collects the note and lands a `task-closed` event with `entrance: human`;
  `claim…`/`release` move a card between columns; and an out-of-band `PATCH` moves one
  over SSE with no user action.

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
  rewrite's three inbox reasons map onto it: `question` is amber, and `due-unwatched` +
  `orphan` are rose, because both are work nobody picked up. `parts.tsx` `reasonTone` is
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
  homes), claim / release / close-with-note, the html doc's in-frame self-probe still
  printing `origin: null · app cookies: threw: SecurityError · parent.location: blocked`,
  the System canvas, zero console errors, and no page-level horizontal scroll at 760px
  (the board still scrolls inside its own pane). NB the deployed graph reference is
  allowlist-gated, so signed out it renders `SignIn` — to compare against it, render the
  branch's own `styles/workspace.css` with its `WorkspaceView.tsx` markup instead.

## Maintaining this file

Keep entries durable and project-intrinsic (build/test/release, architecture, sharp
edges) — not task narration. Prefer a pointer to the authoritative file/command/test
over copying detail. Update or prune an entry when the code it describes changes; delete
what no longer holds rather than letting it drift. `CLAUDE.md` symlinks here, so one edit
serves both. English only, tight prose.
