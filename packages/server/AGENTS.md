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
- **Superset body**: every `/api/machine/cli` verb returns its axi TOON in a `text`
  field (+ `exitCode`) ALONGSIDE its existing structured JSON fields — never
  replacing them. The 0.11 daemon ignores `text` and renders structured; the next
  daemon prefers `text`. So a render change ships server-first with no daemon release.
  `renderLoopLog`/`listLoops`/`createLoop`/`editLoop` add `text` at the source (so the
  legacy routes benefit too); `finalizeCli` (wraps `cli()`) fills `text` from a
  structured `{error}` and ensures `exitCode` — it is idempotent + additive.
- **F2** (in-run `loopany log` printed nothing): fixed for free by `renderLoopLog`
  gaining `text` — the in-run callback already prints `body.text`. Proven at the
  callback boundary by `daemon/src/callback.test.ts` (a stub server returning the new
  body, asserting non-empty stdout — that test changes NO daemon source).
- **F5** (fail-loud): `dispatch` `report`/`finish` reject an invalid `--status` with a
  400 `VALIDATION_ERROR` (`status must be new|resolved|nothing-new (got "x")`) instead
  of the old silent `isStatus(...) ? {status} : {}` drop.
- All dispatch errors render via `derr(code, message, slug?)` → `errorBlock` (slug
  defaults from HTTP status; `finishLoop`'s already-finished rejection pins CONFLICT).
  `describe()` (`show`) is intentionally UNCHANGED in batch 1 — its full-envelope
  redesign is batch 2, and existing tests pin `self-schedule:`/`goal:` kebab keys.

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
