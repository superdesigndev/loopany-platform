# LoopAny MVP - Finalized Design v1

> Design date 2026-06-18. Distill c0's `src/scheduler/` + `web/` into a standalone product **LoopAny**: a multi-user "scheduled loop management + scheduling" SaaS, with execution fully BYOA (tasks run on the user's own machine via claude-code). The product itself **ships no agent and no LLM**.

>
> Upstream baselines: `docs/loopany-cli-design.md` (c0's loop engine design), `/Users/stonex/Workspace/slock/byoa-research/MINIMAL_DAEMON.md` (the minimal BYOA daemon approach).
>
> This document is the product of a branch-by-branch interview - every decision was locked after weighing trade-offs, and the "Decision List" below is the single source of truth.

---

## 0. Product boundary: what is cut / kept relative to c0

LoopAny takes only c0's **loop management + scheduling + execution** core, cutting everything related to personal agent / IM.

| Cut | Kept and migrated |
|---|---|
| Layer 1 IM Gateway (WeChat/Feishu/telegram/xiaozhi) | `scheduler/` core (store / control / workflow / loop-prompt / templates / shim / exec-env) |
| Layer 2 pi entry agent (no built-in agent, all BYOA) | `web/` frontend (dashboard / LoopCard / generative UI rendering / binding) |
| memory / history / sessions / skills / compaction | LoopJob data model, croner scheduling, generative UI / evolution mechanism |
| `owner: PeerRef` / `sendDirect` / `enterAgent` / legacy pi paths | the "how to call claude" knowledge in `handoff/claude.ts` - but the execution point moves to the user's machine |
| codex backend (MVP is claude-only) | exec / evolve, the two kinds of claude pass (the delivery role dispatched to machines; draft is deprecated → see D5 capture-from-Claude-Code) |
| shadow / graduation (deferred to phase 2) | evolution (data-driven self-evolution, kept) |

---

## 1. Decision List (locked)

| # | Decision | Trade-off points |
|---|---|---|
| **Deployment** | **Fly.io** single always-on container, `min_machines_running=1`, **single instance**, with a mounted volume | The workload is inherently stateful / long-lived; Vercel serverless would force a pile of compromises ("per-minute tick + HTTP polling + managed DB + in-function JS sandbox"); Fly lets c0's scheduler migrate almost verbatim. Cost: must keep 1 machine always on (croner has to stay awake), can't scale horizontally (in-process timer is a singleton) |
| **Scheduler** | **In-process singleton**: croner + per-job `nextRunAt` timer; Nitro plugin boot, `globalThis` guard against HMR re-instantiation | Directly reuses c0 `scheduler/index.ts`'s scheduling loop |
| **Transport** | **WS push delivery** (push as soon as the machine is online); machine offline → that tick's run is **recorded directly as error**, no inbox queueing / catch-up | best-effort: push when online, mark error when offline, retry on the next cron tick. Drops BYOA's P9 catch-up |
| **Storage** | **Drizzle ORM (SQLite dialect / better-sqlite3 driver) on Fly volume**; `runs` is **extracted into a standalone table** from c0's inline `runs[]` ring (phase made explicit) | Using Drizzle instead of raw SQL is for **near-zero cost when switching to Supabase/Postgres in the future**: schema `sqlite-core→pg-core` + swap driver + Better Auth adapter `provider:"sqlite"→"pg"`, **business queries untouched**; raw SQL would require rewriting the whole layer. A standalone runs table lets `WHERE phase IN(...)` (timeout reclaim) and `LIMIT` (timeline pagination) be done in a single query |
| **Execution location** | **gate + exec all run on the machine**, one delivery runs the whole pipeline (gate → claude when needed); **server does zero code execution, zero LLM** | Under multi-tenancy, "arbitrary user JS running on a shared server" is a real privilege-escalation surface; pushing it down to machines makes server = pure scheduler+store+UI+auth, naturally multi-tenant safe. Cost: even the cheap silent check needs the machine online |
| **Delivery roles** | `exec`, `evolve` (`draft` deprecated → D5; `review`/shadow keep a slot, added incrementally in phase 2) | The role dimension + run-token permission bits are kept in a shape that lets review be added incrementally |
| **Identity/Auth** | **Better Auth + GitHub login**; **shared team workspace** - all logged-in users see/can operate all loops and machines (v1). `userId` is only the creator attribution, **queries do not filter by userId** | Three people share one dashboard. **Corollary: in the shared view any logged-in user can create a loop on any machine (=RCE), so registration must be locked down** - GitHub login goes through an **allowlist** (an env-listed set of allowed GitHub users), non-listed users rejected. This replaces the old logic of "open registration backstopped by per-user isolation" |
| **Creation UX** | **AI-First = capture-from-Claude-Code** (D5): the Web hands out a connect line, the user gets the task working in their own Claude Code and creates the loop via API | See §6 |
| **Editing UX** | An Edit form in detail PATCHes directly; pause/resume/delete/run-now use buttons | |
| **Notification** | **One global Slack bot token + one fixed channel**, on a `notify` hit do `chat.postMessage` (the message carries a loop/owner prefix); on parse failure fall back to a dashboard red dot | Default assumes you are all in the same Slack workspace; cross-workspace multi-tenancy (per-user Slack OAuth) in phase 2 |
| **Machine jail** | When "binding a machine" on the Web, configure a per-machine workdir allowlist, stored on the server, sent down with each delivery for the daemon to enforce; **skip = unrestricted** | The machine owner's only gate over "the scope of scheduled RCE activity on my machine" |
| **claude invocation** | **One-shot `claude -p --output-format json` per delivery**; cross-run continuity via **taskFile** (not `--resume`); MVP does no streaming | Different loops have different cwd/persona, so "one always-on session per machine" doesn't hold; taskFile continuation is c0's existing approach |
| **transcript view** | **Cut in MVP** (the transcript lands on the machine, the server can't read it); run detail relies on report-returned fields + final text | Phase 2 adds "read-on-demand over WS, have the daemon read and stream it live" |
| Cut | evolution's **shadow/graduation**, manual forms, IM/pi agent, codex, transcript | |

---

## 2. Architecture

```
┌──── LoopAny Server (Fly single process · zero code exec · zero LLM)────┐
│ TanStack Start UI + server fns                                         │
│ Better Auth (/api/auth/$ · GitHub · the same sqlite)                   │
│ Scheduler singleton (croner + nextRunAt, nitro plugin boot)            │
│ WS /machine/connect (device-token → machine → userId)                  │
│ /agent-api/loop (run-token, reuse control.ts logic, UDS→HTTP)          │
│ /machine/report   ·   Slack push (global token, fixed channel)         │
│ Evolve: synthesize system prompt(evolve) + run history → delivery          │
│ SQLite on volume: user/session/account + machines/loops/runs           │
└─────────▲ WS push delivery        ▲ HTTP callback(Bearer)──────────────┘
          │                          │
┌─────────┴──────────────────────────┴─────────────────────────────────┐
│ @crewlet/loopany daemon (user machine · npx foreground · single-instance lock) │
│ device-token+url(env) · connect WS · receive delivery                  │
│ built-in workflow harness: run workflow(prev)→message?/state/escalate  │
│ escalate→claude -p --output-format json --dangerously-skip-… ···       │
│   cwd ∈ machine allowlist(or unrestricted) · loopany report/… → agent-api │
└─────────┬──────────────────────────▲─────────────────────────────────┘
          │ spawn                     │
   claude (user's local login state · taskFile as cross-run memory)
```

**Core invariant**: the server never executes user code, never calls an LLM, never spawns claude. It only schedules, stores, authenticates, and pushes. All code execution (workflow JS + claude) happens on the user's machine.

---

## 3. Data model (SQLite)

Better Auth self-manages: `user` / `session` / `account` / `verification`.

Three business tables:

```
machines
  id          TEXT PK         -- m-sha256(token)[:16]
  userId      TEXT FK->user
  name        TEXT            -- friendly name (set at bind time, e.g. "Tim's Mac")
  tokenHash   TEXT            -- hash of the device token
  roots       JSON NULL       -- workdir allowlist; NULL/[] = unrestricted
  lastSeen    TEXT
  online      INTEGER         -- WS connection status
  createdAt   TEXT

loops
  id          TEXT PK
  userId      TEXT FK->user
  machineId   TEXT FK->machines   -- bound execution machine (set at creation, no cross-machine fallback)
  name        TEXT
  cron        TEXT
  task        TEXT NULL
  taskFile    TEXT NULL           -- path on the machine; the persistent memory of an exec loop
  workflow    TEXT NULL           -- zero-LLM pre-filter JS (written by a human / evolve author)
  ui          TEXT NULL           -- generative UI template (evolve author, sanitized at render time)
  stateSchema JSON NULL           -- metric schema [{key,label,unit}]
  notify      TEXT                -- always | auto | never
  allowControl INTEGER            -- whether a run may self-modify its schedule
  model       TEXT NULL
  enabled     INTEGER
  nextRunAt   TEXT NULL           -- one-time override (self-reschedule / evolve tick)
  state       JSON NULL           -- workflow cursor (the state returned last time)
  evolvedRunCount INTEGER NULL    -- runs count at the last evolution (drives periodic triggering)
  evolveDue   INTEGER NULL        -- flag: run evolution as the sole work on the next tick
  createdAt   TEXT
  updatedAt   TEXT
  -- note: graduation fields removed in MVP (no shadow)

runs
  id          TEXT PK
  loopId      TEXT FK->loops
  userId      TEXT FK->user
  machineId   TEXT FK->machines
  phase       TEXT                -- pending | running | done | error
  role        TEXT                -- exec | evolve | edit  (draft deprecated → D5)
  ts          TEXT
  outcome     TEXT                -- silent | direct | exec | error | evolve
  status      TEXT NULL           -- new | resolved | nothing-new (returned by report)
  message     TEXT NULL
  durationMs  INTEGER NULL
  error       TEXT NULL
  sample      REAL NULL
  state       JSON NULL           -- this run's observation snapshot (chart data point)
  control     JSON NULL           -- audit of control actions initiated by this run
  sessionId   TEXT NULL           -- locator for the claude transcript on the machine (MVP doesn't read it, field reserved)
```

---

## 4. Component responsibilities

> **Frontend design baseline**: the UI follows **Vercel Design / Geist** (https://vercel.com/design.md) - restrained black/white/gray, clear hierarchy, the Geist font and spacing system. dashboard / conversational compose / machine management all follow this tone.

### 4.1 Server (Fly single process · `packages/server`)

- **TanStack Start UI + server fns**: dashboard (loop list / timeline / generative UI panel), conversational compose, machine management. server fns call the in-process Scheduler/Store directly (no longer HTTP-proxying c0).
- **Better Auth**: `/api/auth/$` mounts `auth.handler`, GitHub provider (**login goes through an allowlist**: only GitHub users in `LOOPANY_ALLOWED_LOGINS` may enter), session cookie, the same better-sqlite3 instance. Every server fn / route reads the session only to do a **login check** (shared workspace, **does not filter data by userId**); `userId` is written into loop/run only as creator attribution for display.
- **Scheduler singleton**: a Nitro plugin boots it at server startup, with a `globalThis` guard against duplication. croner scans all users' enabled loops + a per-loop `nextRunAt` timer. A tick only does: create a pending run + delivery → WS push (run=error if the machine is offline) → recompute next. **Executes no code.**
- **WS `/machine/connect`**: `Authorization: Bearer <device-token>` → resolve machine → userId → mark online, push delivery, receive ack.
- **`/agent-api/loop`**: `Authorization: Bearer <run-token>`, body `{argv}`. Reuses c0 `control.ts`'s RunSlot logic (transport switched from Unix socket to an HTTP route). Verbs opened in MVP: `report`, `show` (always available); `reschedule/set-cron/pause/resume/notify` (`allowControl` opt-in); `set-ui/set-schema/set-workflow` (only run-tokens of the `evolve` role). `graduate` is cut.
- **`/machine/report`**: `{runId, ok, exitCode, durationMs, sessionId}` → fetch this run's accumulated report+controls → write the done/error run → push Slack per the notify setting.
- **Slack push**: global `LOOPANY_SLACK_BOT_TOKEN`, fixed `LOOPANY_SLACK_CHANNEL`, `chat.postMessage`, the body carrying a loop name/owner prefix.
- **Evolve synthesis**: the server holds the evolve prompt, synthesizes the system prompt + stuffs the most recent N run histories into the delivery payload. (The `draft` role synthesis + the recipe directory / draft-builder prompt were dropped → see D5.)

### 4.2 Daemon (`@crewlet/loopany` · `packages/daemon`)

Following BYOA `MINIMAL_DAEMON.md`:

- Reads `LOOPANY_TOKEN` + `LOOPANY_SERVER_URL` (env), single-instance lock (`~/.loopany/machine.lock`).
- Connects WS (Bearer device-token), exponential-backoff reconnect on disconnect.
- On `deliver` → the built-in **workflow harness** (injecting `prev` / `fetch` / a registration-style `agent()`, reusing c0 `scheduler/workflow.ts`) runs `workflow(prev)` → `{message?, state, escalate}`.
- Needs to escalate (or no workflow) → write the `loopany` PATH wrapper in the workdir → `claude -p --output-format json --permission-mode bypassPermissions --append-system-prompt-file <sent down> --disallowed-tools <self-scheduling> [--model m]`, **cwd ∈ the machine allowlist** (sent down with the delivery, empty = unrestricted).
- claude reports / reschedules / set-ui etc. back via `loopany <verb>` (shim, HTTP→`/agent-api/loop`, Bearer run-token). The `--message-file/--state-file/--file` inline logic is kept.
- Parse claude stdout to get `session_id` → `POST /machine/report`.
- Runs in the foreground, exits gracefully on Ctrl-C, does no keep-alive.

---

## 5. Execution lifecycle (asynchronous)

```
cron/nextRunAt tick
  └─ pick out due loops (same loop's previous run not terminated → skip, mirroring inFlight)
  └─ evolveDue loop → run the evolution tick (role=evolve) as the sole work of this tick
  └─ otherwise normal: create pending run + delivery
       ├─ machine offline → run goes straight to done(error="machine offline"), end
       └─ machine online → WS push deliver(run=pending)
            └─ machine ack → run=running
            └─ machine: workflow gate → claude when needed
                 ├─ direct message → loopany report (→ Slack)
                 └─ escalate → claude does the work → loopany report --state/--message
            └─ machine POST /machine/report
                 └─ server writes the done/error run (with report+controls) → push Slack per notify
                 └─ after a normal run: flagEvolveIfDue (every N rounds → set evolveDue + a near-future nextRunAt)

Reclaim: machine took the delivery but no report within timeoutMs+grace (default 20min), or WS disconnected and the run is not terminated → server marks error
```

---

## 6. AI-First creation UX (capture-from-Claude-Code · see D5)

> **Major change (this round, see D5)**: abandon "the server dispatches a `role=draft` delivery so the machine drafts in a single round". **A single-round instruction can hardly produce a suitable loop** - real tasks often need multi-round interaction to get working. The new model: the user **actually gets the task working in their own Claude Code session** (any number of rounds, looking at real files/output), then has Claude **create the loop directly into the platform via API**. The Web is only responsible for handing out the "connect line" + waiting.

**Creation** (New-loop Modal, **no machine selection**, see D6):

1. The Modal, on open, `mintClaim()`s a `dk_` **claim code** (without creating a machine row), and shows a copyable **connect line**:
   ```
   Follow <origin>/api/skill and build a loop for the thing you did above. Run it <schedule>, and <action> each time.
   server-url: <origin>
   connect-key: dk_…              // both the new machine's device token and the loop's claim
   [daemon-cmd: …]                // included only when LOOPANY_DAEMON_CMD is configured (local dev)
   ```
   The instruction line is an **editable template**: `<schedule>` (default `every day at 9am`) and `<action>` (default `write an article`) are inline click-to-edit chips the user can customize before copying, so the pasted text carries their own cadence + task. The `/api/skill` URL and the `server-url`/`connect-key`/`daemon-cmd` config lines stay fixed and read-only. A cleared chip falls back to its default so the instruction never reads broken.
2. The user **pastes it into their own Claude Code** (in the project where they just got the task working). Claude follows `<origin>/api/skill` (server route returns the skill **overview** `src/skill/SKILL.md`, inlined with `?raw`, which routes to the `create`/`update`/`evolve` references - see D14): ① settle the device token (`~/.loopany/device-token` present → reuse = associate the existing machine; absent → take the connect-key as this machine's = authorize a new machine) → status check online, and if offline `nohup`-detach the daemon (**self-registers** this machine); ② write the task file + the loop config JSON; ③ `POST <origin>/api/machine/loop` (Bearer **device token**, body carries `claim`=connect-key).
3. The Web side **polls `claimStatus(connect-key)`**, and once the claim is redeemed by `createLoop` it knows which loop was created → the Modal flips to "Loop created ✓" → refresh the dashboard. **The Web never needs to know which machine it was.**

**Machine-side API**: `GET /api/machine/status` (device token → `{online,name,lastSeen}`, unknown token returns `online:false`); `POST /api/machine/loop` (device token → validate cron + workflow|task → `store.createLoop` binds this machine → `scheduler.addLoop` schedules immediately → redeem the `claim`). `gateway.poll`, on an unknown token, **self-registers** the machine (name=hostname).

**Editing**: config changes still use the Edit form in detail (PATCH directly); pause/resume, delete, run-now, (evolve TBD) use buttons.

**Trade-off**: creating a loop **no longer requires the machine to be online at that moment** (the minted key itself registers the machine row; the daemon is started on the spot by Claude Code). Cost: compose isn't a conversation inside the platform, it relies on the user's local Claude Code - but in exchange you get a loop that actually works.

---

## 7. Evolution (kept · no shadow)

- Periodic trigger: a loop has run `EVOLVE_EVERY`(=3) more times than at the last evolution → `flagEvolveIfDue` sets `evolveDue` + a near-future `nextRunAt` → the next tick runs evolution (`runEvolutionTick`) specifically as the sole work of that tick. Plus an "Evolve now" manual button.
- Evolution is a `role=evolve` claude pass, run on the machine: the server synthesizes the evolve prompt + stuffs the most recent N run histories into the delivery → claude calls `loopany set-ui / set-schema / set-workflow` to report back → the server applies it, the run records `outcome:evolve`.
- **No shadow**: the graduation state machine is removed. The new workflow written by evolve **takes effect immediately and runs unattended** (an accepted pre-phase-2 risk).
- **zero-exec corollary**: c0's `setWorkflow` originally ran the new workflow JS once on the server to validate it; MVP server does zero execution, so **`set-workflow` only stores the string on the server, without validation**. A bad workflow surfaces as an error in the next run on the machine, self-corrected on the next evolve tick.
- Applicability precondition `canEvolve`: the loop has evolvable material (a metric schema or a workflow).

---

## 8. Security / trust model

- **Web side**: GitHub login + a **login allowlist** (`LOOPANY_ALLOWED_LOGINS`). **Shared team workspace** - after login you see/can operate all loops and machines, not filtered by userId. **Note**: in the shared view "if you can see it you can operate any machine", so the allowlist is the only admission gate - it replaces per-user isolation, narrowing "who can run code on these machines" to trusted members in the list. `userId` is only creator attribution.
- **Machine admission**: the device token is issued at "bind machine" time on the Web (`m-sha256(token)[:16]` as the machine id).
- **Run admission**: each delivery issues a run-token on the spot (bound to runId+jobId+machineId), invalidated as soon as the run terminates; agent-api admits verbs per the token's role permission bits.
- **Machine activity scope**: a per-machine workdir allowlist (configured on the Web, sent down to the daemon, which enforces cwd ∈ allowlist; skip = unrestricted).
- **Transport**: WS / HTTP all use `Authorization: Bearer` throughout, the token never goes in the URL.
- **server**: zero code execution, zero LLM, zero claude - no sandbox burden, no LLM key.

---

## 9. Build plan

- **P0 skeleton**: pnpm monorepo (`packages/server` ports web+scheduler and strips out IM/agent/gateway/memory; `packages/daemon` an empty shell). **Drizzle schema (machines/loops/runs) + Better Auth (Drizzle adapter, provider sqlite) + GitHub + login allowlist**. Scheduler runs cron in-process + runs table persisted. dashboard read + machine-binding UI (sign token / configure roots).
- **P1 BYOA execution (exec)**: daemon (WS + single-instance lock + workflow harness + spawn claude + loopany shim) + the server's WS gateway / agent-api (control ported) / `/machine/report` + machine jail. Run one exec loop end-to-end on a single machine.
- **P2 AI-First + evolution (draft + evolve)**: conversational compose/edit UX + `role=draft` delivery + server-side recipe directory + generative UI rendering + evolution state machine (`role=evolve`). (**`role=draft` delivery + the recipe directory were dropped → D5**, replaced by capture-from-Claude-Code; evolve kept.)
- **P3 closed-loop polish**: Slack notifications, timeout reclaim, machine online/offline UI, run detail card, "Evolve now" / run-now / pause buttons.
- **P4 onto Fly**: Dockerfile + fly.toml (single instance + volume + `min_machines_running=1`) + secrets (GitHub OAuth, Slack token, Better Auth secret) + GitHub OAuth App configuration.

---

## 10. Phase 2 (explicitly deferred)

- shadow / graduation (put evolve/human-written workflows on a shadow probation; review role delivery).
- ~~transcript view~~ (**already landed early, see D7** - a slimmed-down push version, not the originally envisioned read-and-stream-live over WS). Phase 2 adds back system/query echo + full trace.
- live token streaming (`--output-format stream-json` + a reworked report channel).
- cross Slack-workspace multi-tenancy (per-user Slack OAuth).
- codex backend (**execution** still deferred - every loop is still run via claude regardless of its recorded agent; codex *recording* has since landed, see D12); persistent claude sessions / `--resume`; machine-offline inbox queueing + catch-up; multi-machine fallback.
- daemon keep-alive (`loopany install` writes launchd/systemd).
- ~~web **Files view** for live-synced loop artifacts~~ + ~~per-run artifact diff (`run_snapshots`, Phase 3)~~ (**both landed, see D11** - read-only, built on the D10 sync foundation).

---

## 11. Deviations from the original plan (Deviations)

> **Substantive** changes to the architecture above, encountered during implementation, are recorded here (with reasons), keeping the text above as the "target design" and this section as the "landed truth". Principle: don't lightly change the original plan, consult the docs first on hitting a problem, and major changes must be recorded.

### D1 — Machine transport: WS push → HTTP short-poll (landed)

- **Original plan**: a persistent WS `/machine/connect`, the server actively pushes delivery (§1 decision table "Transport", §2 architecture diagram).
- **Changed to**: the daemon `POST /api/machine/poll` (Bearer device token) every ~2-3s to claim its own machine's pending run; the server doesn't push. `/agent-api/loop`, `/machine/report` remain plain HTTP.
- **Reason**: cramming a persistent WS into TanStack/Nitro is unstable under dev; short-poll is pure HTTP, runs reliably in a single process, and a few seconds of latency has no impact on minute/day-scale cron loops. The design doc had short-poll listed as a fallback all along.
- **Corollary**: the "offline → instant error" semantics are pushed down into the server's reclaim sweep - a tick only creates a pending run (transport-agnostic), pending unclaimed for >60s → `machine offline`, running over timeout → `timed out`. The `Dispatcher` seam is kept (WS push can be swapped back as a later optimization).

### D2 — ~~single process → main.ts proxy~~ **reverted (misdiagnosis, back to the original single-process plan)**

> **Lesson recorded**: D2 was once changed to a main.ts backend + UI proxy because "the TanStack server-route doesn't dispatch". **It was later traced to be a misdiagnosis** - the root cause was **vite dev by default binding only IPv6 `localhost`(::1), while I had been testing with `127.0.0.1`, so connections never reached the server (`curl code=000`)**. After binding vite to `host: '127.0.0.1'`, `createFileRoute(...).server.handlers` (`@tanstack/react-start@1.168`, the documented form is correct) **works perfectly** (the minimal `/api/health` returns 200 JSON).

- **Conclusion**: **keep the original single-process design** - Scheduler + machine endpoints + UI server fn all in the same TanStack process; `ensureServer()` (a globalThis guard) guarantees a unique scheduler.
  - Machine routes (server route files): `routes/api.machine.poll.ts`, `routes/agent-api.loop.ts`, `routes/machine.report.ts` (dynamic-import `getGateway()` inside the handler, to avoid better-sqlite3 entering the client bundle).
  - UI: the server fn in `server/loopApi.ts` **directly calls** the in-process `store` + `scheduler` (producing JobSummary/JobDetail via `server/adapters.ts`), no longer proxies.
  - dev/seed: `routes/api.admin.ts` (action dispatch, no `$id` path param, to avoid route codegen mixing up routes).
- **Config fix**: `vite.config.ts` `server.host = '127.0.0.1'` (eliminates the IPv4/IPv6 mismatch, unifying daemon/curl/the whole chain on 127.0.0.1).
- **main.ts kept as an optional headless backend** (the same gateway code, a separate port/DB) - `scripts/demo-cookie.sh` uses it; **never run against the same DB as `pnpm dev` at the same time** (double scheduler).

### D3 — device token stored in plaintext (landed)

- **Original plan**: machine stores only `tokenHash`, the raw token shown once at bind time.
- **Changed to**: the machines table adds `token` (plaintext, migration 0003), the UI's "Machines panel" can re-copy the connect command anytime.
- **Reason**: MVP-friendly - if the token is lost there's no need to reset (a reset would change the `m-sha256(token)` machine id, disconnecting already-bound loops). For a self-hosted small team the DB is the root of trust anyway, so this trade-off is accepted (user-confirmed). The machine id is still = `machineIdFromToken(token)`, no decoupling needed.

### D4 — machine workdir jail moved from daemon env to server config (landed)

- The machine's workdir allowlist is configured at bind time in the "Machines panel" → stored in `machines.roots` → sent down with each delivery → the daemon enforces cwd ∈ roots (`d.roots ?? env LOOPANY_ROOTS`, server takes priority). Conforms to the original design "configure roots when binding the machine on the Web, the daemon enforces, skip = unrestricted".

### D5 — AI-First compose: server `role=draft` delivery → capture-from-Claude-Code (landed, **reverts D's (last round) draft on-the-spot probing**)

- **Motivation**: a single round (even a single round with workdir probing) can hardly produce a suitable loop; real tasks need to be worked through over multiple rounds in Claude Code.
- **Reverted**: removed the entire server-driven draft subsystem - the `drafts` table (migration `0003` DROP), `createDraft/getDraft/parseSkill/draftLoop` server fns, the gateway `poll`'s drafts branch + `draftReport` + draft token, the `/machine/draft-report` route, the daemon `runDraft`, `buildDraftSystemPrompt/buildDraftTask`. `gateway/draft.ts` keeps only `parseDraft` (with the `DraftJob` type).
- **Added**:
  - `src/SKILL.md` served via the server route `GET /api/skill` (`?raw` inline + `text/markdown; charset=utf-8`) - instructions for Claude Code: start the daemon + write the loop config + POST to create the loop. **Since refactored into an installable skill at `src/skill/` - `/api/skill` now serves the overview `src/skill/SKILL.md`; see D14.** **Why go through a route, not `/public`**: a static `.md` doesn't carry `charset=utf-8` (garbled Chinese), and under dev the vite static layer would swallow the `.md` path before the server route, so an extensionless `/api/skill` is used.
  - `POST /api/machine/loop` (`gateway.createLoop`, device-token auth, accepts name/cron/workflow/task/workdir/**taskFile**/stateSchema/notify) + the route `routes/api.machine.loop.ts`. SKILL.md requires Claude to **first write a task file in the project** (`<project>/loopany/<slug>.md`: Goal/How it runs/Notify/Log), the loop config carries its absolute path `taskFile` - the loop's persistent brief + run log. **All in English**.
  - `gateway.poll`: auto-name with hostname when the machine has no name.
  - **`GET /api/machine/status` (device token, gap#1)**: returns `{online,name,lastSeen}` (online computed live per poll TTL). SKILL.md step 1 curls it first - if already connected (`online:true`) it **skips starting the daemon**, avoiding a duplicate connection.
  - **SKILL.md refinements** (per observing a real run `cb75c207`): ① start the daemon with `nohup … &` to **detach** (uninterrupted when the claude-code session closes; gap#2, true persistence can still add launchd in phase 2); ② **when taskFile is present, `task` is thinned** to a pointer of "read the task file + execute + notify rules", with method/filtering/queries all left in the task file, no longer repeated in `task` (gap#3).
  - `getConfig.customDaemon` (carries `daemon-cmd:` in the connect line only when `LOOPANY_DAEMON_CMD` is configured); `JobSummary.machineId` (the Web claims the new loop by this).
  - `ComposeModal` rewritten to mint-key + connect line + poll-wait.
- **e2e (agent-browser + curl)**: New Loop → mint `dk_…` → the connect line contains the real `<origin>/api/skill` + server-url + connect-key + daemon-cmd → `POST /api/machine/loop` creates a workflow loop → the Modal auto-flips to "Loop created ✓". `/api/skill` 200, no token 401. Both packages typecheck clean.

### D6 — New Loop drops machine selection: claim token + self-registration + persistent identity (landed)

- **Motivation**: the Web doesn't know which machine the user will paste to, so forcing a machine choice is wrong. Let binding happen on the machine side, the Web just hands out a "claim code" and waits.
- **token dual-use**: the `dk_` token in the connect line = ① the new machine's device token (first time), ② the loop's `claim` (always) - so "authorize a new machine" and "associate an existing machine" can both be done with the same token.
- **machine self-registration**: `gateway.poll`, on an unknown token, **creates the machine row directly** (name=hostname), no longer requiring the Web to `createMachine` first. `/api/machine/status` returns `{online:false}` for an unknown token (no longer 401), so the skill's check is uniform.
- **claim association**: `createLoop` accepts `claim` → writes the in-process claims registry (`tokens.ts`); the two server fns `mintClaim`/`claimStatus` give the Web a code + polling; the Modal no longer lists machines, no longer claims by `JobSummary.machineId`, instead waits on the claim.
- **persistent identity**: the daemon writes `--api-key` to `~/.loopany/device-token` and reads it back when no arg is given - **reusing the same machine id** across loops/restarts on the same machine (solving the duplicate connection + working with gap#2). SKILL.md step 1 acts on this: if device-token is present reuse it (associate the existing machine), if absent take the connect-key as this machine's token (authorize a new machine); if status checks online, skip starting the daemon.
- **Security**: self-registration = anyone holding a valid token can create a machine/loop (§8 is already a low-security personal model; one can only touch one's own machine's token, and the Web side still has the GitHub allowlist gate).
- **e2e**: New Loop (no machine selection) → connect line → simulate the skill: device-token logic → self-register (status flips online + hostname auto-named) → `POST …/loop` with claim → the Modal flips to "Loop created ✓" via `claimStatus`. status unknown token → `{online:false}`. Both packages typecheck clean.

### D7 — transcript view: read-and-stream-live over WS → slimmed-down push (landed, brought forward from phase 2)

- **Motivation**: §10 originally deferred the transcript view to phase 2, on the reasoning that "the transcript is on the machine, the server can't read it". But the daemon, having run claude, **already parses the transcript locally** (`artifacts.ts` extracts artifacts) - the obstacle was actually already bypassed. Read-and-stream-live over WS (the original idea) also no longer applies after D1 cut WS, and the daemon may go offline after finishing. **Changed to: on finishing, push the slimmed-down trace up to be stored too**, reusing the same local file read, zero extra round-trips.
- **daemon** (`artifacts.ts` merges `sessionArtifacts`+the standalone transcript into a single-read `sessionTrace()`): **one** `.jsonl` read+parse simultaneously yields artifacts and `TranscriptStep[]` (assistant text / tool_use name+input / tool_result head), each field clipped to 1.5KB, at most 80 steps - only for "understand at a glance", not a full log. `runner.ts` gets both from a single `sessionTrace`, the report body carries an extra `transcript`.
- **server**: `runs` adds a `transcript JSON` column (migration `0005`, an appended ALTER); the report handler `coerceTranscript` (defensively re-clips, at most 200 steps / 4KB fields, filtering out illegal kinds) stores it; `RunSummary` adds `id` (`toRunSummary` carries it), `getTranscript({runId})` fetches it directly via `store.getRun` (no longer addressing by sessionId a second time). The frontend `RunView`'s `<Transcript>` was already written to render, only changed to pass `run.id`.
- **Not done in the slim version**: system prompt / full user query echo (`TranscriptResult` reserved the fields, only steps filled for now), streaming, files written by Bash (only Write/Edit tools enter the trace, the same limitation as artifacts). Old runs (without this column) → RunView already has fallback copy.
- **Tests**: gateway unit test adds "report stores transcript → `runBySession` reads it back" (including coerce filtering out extra fields + illegal kinds). 11 unit tests all pass, both packages typecheck clean.

### D8 — Team scope + per-loop push channel (landed, replaces "one global Slack")

- **Motivation**: ① §1 "Notification" was originally one global Slack token + a fixed channel, with no way for each person to configure their own push; ② the original "shared workspace" had actually drifted to filtering by `userId` (`store.listMachines(userId)` etc.), effectively "team=user". This round makes the scope unit explicitly a **team**, and makes push **multi-channel per team, one chosen per loop**.
- **Team model (a minimal self-built one, not the Better Auth org plugin)**: adds two tables `teams`(id/name/ownerUserId) + `team_members`(teamId/userId/role). The team id is **deterministic** = `team-<userId>` (open mode = `team-shared`), so the teamId can be derived from the userId without a table lookup. `machines`/`loops` each add `teamId` (indexed).
  - **Default personal team**: Better Auth `databaseHooks.user.create.after` creates `<name>'s Team`; `requestScope()` further backstops with `ensureTeam` (idempotent `INSERT OR IGNORE` + in-process memo), covering old users registered before the hook.
  - **Scope switch**: `requestScope()` changes from returning `{enforce,userId}` to `{enforce,userId,teamId}` - **`userId` is still the creator-attribution column written, `teamId` is the read filter + auth basis**. The filter key in `listLoops/listMachines` userId→teamId; `ownedLoop`, run attribution (getTranscript/cancelRun, via loop.teamId), and createJob's machine attribution check are all team-ified. The gateway's self-registration + `POST /api/machine/loop` write `teamId` (the loop inherits it from the machine).
  - **Migration `0010`**: after drizzle generates the structure, **a hand-written data backfill** - create teams by the distinct `user_id` of `machines`/`loops` (`shared`→`team-shared` with no owner), create owner member rows, backfill `team_id` in both tables. Local migrate + self-registration e2e verified: machine lands in `team-shared`, teams created, loops `team_id` non-null.
- **Push channel (multi-channel per team · one chosen per loop)**: adds `notification_channels`(id/teamId/type/name/config JSON); `loops` adds `channelId`.
  - **Dispatch refactor**: `gateway/slack.ts` → `gateway/notify.ts`. Keeps `shouldNotify(notify,status)` (**when to send**, orthogonal to the channel); new `dispatchNotification(loop,msg)` (**where to send**): `loop.channelId` empty → **don't send externally (dashboard only, removed the global Slack backstop)**; otherwise send per the channel `type`. `sendTelegram`(Bot API `sendMessage`) / `sendSlack`(`chat.postMessage`) return `{ok,error?}` (don't throw). The report handler switches to calling `dispatchNotification`.
  - **Behavior change**: an old loop no longer sends externally before a channel is chosen in the dashboard - acceptable pre-production. The global `LOOPANY_SLACK_*` env is no longer read (slack is now one channel type, phase 2 can expose a slack channel form in the UI).
  - **server fn**: `server/notifyFns.ts` = `listChannels`/`createChannel`(validates required fields per type)/`deleteChannel`(unbinds loops pointing at it → channelId=null)/`testChannel`(sends a test message immediately, returns the real ok/error). **The secret is never returned to the client** - list gives only `ChannelSummary{id,type,name,hint}` (hint is a masked indicator).
  - **UI**: a "Notifications" entry next to the header "Machines" button → `NotificationsModal` (lists channels + an add-Telegram form <name/botToken/chatId> + per-row Test/Delete); `LoopForm` adds a `push channel` dropdown next to notify (`none (dashboard only)` + team channels, writes `channelId`); `JobFull.channelId` is carried out via adapters to backfill the edit form.
- **Verification**: both packages typecheck clean; server unit tests 20 passed; dev boots fine (page/`/api/skill` 200); `POST /api/machine/poll` self-registration writes out `team-shared` + the teams row + loops `team_id` all backfilled (verified directly in the DB).
- **Not done (marked as follow-up)**: team member invitation/management UI; choosing a channel when creating a loop via Claude Code through `POST /api/machine/loop`/SKILL.md (for now choose it when editing in the dashboard); exposing a slack channel form in the UI; cross-workspace Slack OAuth (still phase 2).

### D9 — Multi-team switching + super admin (landed, picks up D8's leftover "multi-team switching")

- **Motivation**: ① when a user belongs to multiple teams they need to switch scope in the dashboard; ② operations need a super admin view that can see **all teams, all users' loops**. D8's team schema (`team_members`) was ready but the read side never queried it (always used the deterministic personal team); this round makes "the visible team set + the selected team" explicit. **No migration needed** (superadmin goes via env, selection via cookie).
- **Super admin**: `auth.isSuperAdmin(email)`, sourced from a built-in `shitianxin@gmail.com` + env `LOOPANY_SUPERADMINS` (comma-separated emails, lowercased). An admin can switch to any team, or pick the "all teams" aggregate view.
- **Selected team (client sets the cookie, server validates)**: the `loopany.team` cookie (`__all__` sentinel = the admin aggregate view). `requestScope()` reads the cookie and **validates** - an admin may pick any existing team, a normal user is limited to `isTeamMember`, illegal/missing falls back to the personal team, **never blindly trusting the cookie**. The return type expands to `{enforce,userId,teamId,isAdmin,allTeams}`.
  - `currentUserId()` → `currentUser()` (one getSession fetches id+email, for the admin decision).
  - `listJobs`/`listMachines`: `allTeams` passes `undefined` (lists across teams, as in open mode); otherwise by `teamId`. `ownedLoop`: the admin aggregate view admits a loop of any team (open/operate), the rest still limited to the current team.
- **store**: `listTeamsForUser`(member join)/`listAllTeams`(admin)/`isTeamMember`.
- **server fn**: `listMyTeams()` → `TeamsView{teams,activeTeamId,isAdmin,allTeams}` (admin gets all teams + `__all__`, a normal user gets only their member teams - usually 1 ⇒ no dropdown; open mode ⇒ empty).
- **UI**: `components/TeamSwitcher.tsx`, to the left of the header "Notifications". **Renders only when >1 team** (transparent to normal users); admins get an extra "All teams" item. Switching writes the cookie + `router.invalidate()`.
- **Verification**: both packages typecheck clean; server unit tests 20 passed.
- **Limitation (marked as follow-up)**: `New Loop` creation is **not yet cross-team** in this round - it lands in the admin's personal team; the team member invitation UI is still missing, so multiple teams are in practice visible only to the admin. **The creation half has since landed - see D13** (per-team connect-key lands a captured loop in the active team; push-channel cross-team + the invitation UI remain open).

### D10 — Loop artifact live-sync, Phase 1 (landed, new feature not in the original plan)

- **Motivation**: a loop produces files (reports, exports, generated output) in its own folder, but the server only ever saw the report text + the slim transcript (D7) - never the files themselves. Phase 1 lays the foundation for a future web Files view: the daemon **live-syncs each loop's folder up to the server**, content-addressed, including idle-time human edits between runs.
- **Watch scope (captain decision)**: each loop's **own folder** - `dirname(taskFile)` → `workdir` → a per-loop scratch dir - **not** the whole project workdir, so `node_modules`/`.git` are never traversed. The daemon (`packages/daemon/src/watcher.ts`, **chokidar v4**) learns the watch set **server-authoritatively** from the poll response's `watch:[…]` (restart-safe; no client guessing), sha256-hashes the folder into a **FULL manifest** (a deleted file = its absence from the manifest), and syncs the diff.
- **Wire protocol**: `POST /api/machine/sync` (**device token**, NOT the run token - that's revoked at run end, and sync continues idle) posts the full manifest; the server replies `needHashes` (the blobs it lacks); the daemon `PUT /api/machine/blob/:hash` uploads the missing bytes (the server verifies `sha256(body) === :hash` before storing). Small text blobs (**≤64KB**) are inlined in the POST to save the round-trip. `runId` is threaded onto each sync.
- **Storage (captain decision)**: blob **BYTES** live in **Cloudflare R2** (S3-compatible via `@aws-sdk/client-s3`), keyed by content hash, behind a `BlobStore` interface (`gateway/blobstore.ts`) wired from `LOOPANY_R2_*` env (**no hardcoded creds**); when those are unset the **in-memory** implementation is the **test/dev default**, so tests need no live R2 or network. Metadata lives in two new additive tables, **`blobs`** + **`artifact_files`** (migration **`0011`**) - the R2 variant has **no `content` column**, so the server's zero-exec invariant holds (it only stores/reads bytes, never interprets them). `artifact_files` extends the originally-planned schema with `binary`/`oversize` flags to represent metadata-only files; `lastRunId` records the in-flight run (null for idle edits) purely as the **Phase 3 seam**.
- **Caps + security (enforced on BOTH daemon and server)**: per-file cap **10MB** → larger files sync as **metadata only** (path + size + `oversize`, no bytes). Path-safety (reject absolute / `..` paths) + the secret/junk **ignore list** (`.git`/`node_modules`/`.loopany`/`.env*`/`*.pem`/`id_rsa*`/`credentials`/`.DS_Store`) are enforced by the daemon (don't send) **and** defensively by the server (`gateway/artifacts.ts`, don't store). Deletions are recorded as **tombstones** (`artifact_files.deleted`), not hard deletes.
- **Out of scope (intentional, at the time)**: Phase 2 (the web **Files view**) and Phase 3 (`run_snapshots` per-run diff) were **not** built in Phase 1 - `runId` on syncs + `artifact_files.lastRunId` were left as the seams. **Both have since landed - see D11.**
- **Dependencies**: `chokidar` v4 (daemon), `@aws-sdk/client-s3` (server).
- **Verification**: `pnpm -r typecheck` + both package builds clean; **64 server tests pass (12 added in this phase**, driving the in-memory blob store - no creds/network).

### D11 — Loop artifact live-sync, Phase 2 (web Files view) + Phase 3 (per-run diff) (landed)

- **Motivation**: D10 laid the sync foundation but left the consumer side as seams. D11 builds the **read-only** web surfaces on top: a per-loop Files view and a per-run artifact diff. Both preserve the **zero-exec invariant** - the server only stores/reads bytes and computes pure-string diffs; no writes, no sync-state mutation.
- **Phase 2 — Files view (read path)**: lazy-by-id server fns `getArtifacts`/`getArtifact` (`server/loopApi.ts`, following the `getTranscript` pattern) delegate to pure helpers in `server/artifactFiles.ts` (read bytes via `gateway.readBlob`, decode text; **binary/oversize → download marker**, never inlined). Rendered by `FilesView.tsx` + `ArtifactFileRow.tsx` as a "Files" section in `JobDetailView`. **Tombstoned/deleted files (`artifact_files.deleted`) never appear.** Binary/oversize bytes download via the session-authed, **path-safe** splat route `routes/api.artifact.$loopId.$.ts`, team-scoped through the shared `auth.loopInScope` predicate that `ownedLoop` also reuses.
- **Phase 3 — per-run diff**: new additive table **`run_snapshots`** (migration **`0012`**; manifest = `path → {hash, size, binary, oversize}`). The gateway `report()` writes a snapshot from `artifact_files` at finalize (`store.buildLoopManifest`); `getRunDiff({runId})` lazily diffs run N against the prior run (`store.prevRunSnapshot`) - **unified text diff via the pure-string `diff` (jsdiff) lib** in `server/runDiff.ts`, with a **size-delta marker** for binary/oversize/too-large files. Rendered in `RunView`'s "Changes (N)" section; old runs with no snapshot degrade to a calm fallback.
- **Inline-diff size cap (review fix)**: the synchronous per-file text diff is bounded by `MAX_DIFF_BYTES` = **512KB** (`runDiff.ts`) - larger text files degrade to the size-delta marker like binary/oversize, so a single big file can't block the single-process server.
- **Daemon flush-before-report**: the daemon flushes a final **run-tagged** sync before reporting (`watcher.flushLoop` + `runner` `reportRun`, under a **bounded flush timeout**) so the snapshot captures end-state.
- **Shared helper**: byte counts render through `humanBytes` in `lib/format.ts` (extracted, reused by the Files view + diff markers).
- **Dependencies**: `diff` (jsdiff) v9 (server, pure-string - no exec).
- **Verification**: `pnpm -r typecheck` + builds clean; new server tests `server/artifactFiles.test.ts` + `server/runDiff.test.ts` drive the in-memory blob store (no creds/network).

### D12 — Coding-agent recording (`loops.agent`, landed, recording-only, new feature not in the original plan)

- **Motivation**: a loop is created from inside a coding-agent session (Claude Code today, Codex emerging), but the platform hardcoded `executor:"claude"` everywhere and couldn't even record which agent a loop was bound to. D12 introduces the **concept** of a loop's coding agent and records it honestly - **recording-only**, deliberately not execution: the daemon still **executes every loop via Claude** regardless of this value (codex execution stays the deferred §10 item), so codex loops are surfaced as "recorded - runs via Claude for now".
- **Schema**: `loops` adds **`agent`** (`text`, TS-only enum `claude-code | codex`, **NOT NULL default `claude-code`**, additive migration **`0013`**) - existing rows backfill to `claude-code` via the default. As with the other `text(col,{enum})` columns, SQLite stores plain text with no CHECK, so **widening the agent set later is a pure type change, no migration**.
- **Capture at `loopany new` (daemon `create.ts`)**: `resolveAgent(env, declared)` resolves by the agreed precedence **measured CLI env-fingerprint > declared (`--agent` flag / config `agent:`) > undefined** (undefined ⇒ let the server default it; we never invent a value the host didn't evidence). The fingerprints (verified, not memory): Claude Code = `CLAUDECODE` / `CLAUDE_CODE_*`; Codex = `CODEX_SANDBOX` / `CODEX_SANDBOX_NETWORK_DISABLED` (sandbox-only ⇒ best-effort, falls back to the declared value; `CODEX_COMPANION_*` is **deliberately ignored** since a Claude session also exports it). The daemon sends `agent` in the `POST /api/machine/loop` body.
- **Server (`gateway.createLoop`)**: accepts/**coerces** `body.agent` - an unknown/absent value degrades to `claude-code` (back-compat: older daemons omit it), it **never rejects** the loop. `adapters.ts` now reads `loop.agent` instead of the hardcoded `executor:"claude"`: `JobSummary.kind` is `exec:<agent>` and `JobFull.agent` carries it out to the UI.
- **UI (de-Claude where a loop is in view, captioned for codex)**: `ComposeModal` gains an **agent selector** - codex is **selectable** (captain decision: record it honestly now) but messaged "recorded - runs via Claude for now"; the connect snippet carries an `agent:` line; `SKILL.md` tells the agent to self-declare via `--agent`. Generic/loop-in-view copy in `MachinesModal`/`RunView` is neutralized too. **Execution-path copy stays "Claude" on purpose** (run-now, edit-via-Claude-Code in `JobDetailView`) - that IS what runs.
- **Verification**: `pnpm -r typecheck` + build clean; the daemon gains vitest (`create.test.ts`) for the detector/precedence; server tests cover `createLoop` persistence + the adapter mapping.

### D13 - Per-team connect-key → loop team (multi-team capture, landed; closes D9's creation limitation)

- **Motivation**: a user who belongs to multiple teams could not create a loop in their non-default team via the capture/connect-key flow. **Root cause**: `mintClaim` dropped the session's active `teamId` and `createLoop` always used the machine's single home team (`team-<userId>`), so captured loops silently mis-filed into the creator's **personal** team and the web `createJob` path walled on a "machine must be in the active team" check. **Target architecture (captain-approved)**: ONE daemon/machine per computer (never per-team machines); each team the user belongs to has its own connect-key/snippet; a loop created via team B's connect-key lands in team B. A loop's `teamId` comes from the **connect-key/claim context**, server-validated against membership - **not** from a single `machine.teamId`. **Scope is Phase 1 + 2 only** (Phase 3 - a durable `connect_keys` table + the team-member invitation UI - is deliberately left as seams + an AGENTS.md note).
- **Claim-intent map (decision: Option A, in-memory)**: `mintClaim` (`server/loopApi.ts`) reads the **validated** active team from `requestScope()` and binds it (+ minter) to the freshly-minted connect-key via `rememberClaimIntent(key,{userId,teamId})` (`gateway/tokens.ts`, an in-memory map alongside `deviceOwners`/`claimResults`, **24h TTL, no migration**). A server restart drops pending intents (a snippet pasted afterward falls back to the home team, like a timed-out claim today). The intended Phase-3 upgrade is a durable `connect_keys` table (Option C) - **not built**. `mintClaim` **fails safe in the admin "All teams" view** - returns `{error}` (its return type is now a `{token}|{error}` union) rather than minting a key that would fall back to the personal team; `ComposeModal` surfaces it.
- **Cross-team create is fail-CLOSED (on purpose)**: `createLoop` (`gateway/index.ts`) resolves `loop.teamId` from `readClaimIntent(body.claim)`: no intent ⇒ fall back to the machine's home team (back-compat); when the intent team **differs** from the home team it's a CROSS-TEAM create, gated so it never silently mis-files (the original bug): `machine.userId === intent.userId` (**bind the claim to its minter**) **AND** re-validate authorization **now** (membership can change after mint) - `store.isTeamMember(team,userId)` OR superadmin on an existing team (mirrors `requestScope`). The team value is **server-minted, never client input**. The "intent team === home team" short-circuit means **open mode** (single `team-shared`, no member rows) and same-team captures skip the checks and are unaffected. The default push channel is computed against the **resolved** team so it routes to that team's channel.
- **Home team stays the personal team (review fix)**: self-register (`poll`) sets a machine's home team to **ALWAYS** the owner's personal team - **not** seeded from the first connect-key's intent. Keeping home = personal team preserves the safe invariant that a machine's no-claim fallback can never be a shared team the owner is merely a (possibly later-revoked) member of; the actual team comes from the validated claim intent at create time regardless.
- **`isSuperAdmin` extracted to a standalone pure module** (`src/superadmin.ts`, env-only, re-exported by `auth.ts`) so the framework-agnostic gateway can re-check admin authorization **without** importing the Better-Auth-initializing `auth.ts`; `store.userEmail(userId)` looks up the email. Behavior-identical refactor.
- **Machine is membership-scoped, not single-team**: `store.listMachinesForTeam(teamId)` (owner↔`team_members` join) makes one machine visible in every team its owner belongs to. `machineFns` listing + web `createJob` machine pick/validation use it (a machine is usable if its owner is the current user **or** a member of the active team). `machine.teamId` is **RETAINED** as the home/default no-claim fallback. The daemon is **unchanged** - the per-team key already travels as `claim` in `loopany new`, and `loopany up` keeps the single stored device token.
- **Phase-3 follow-ups (NOT built)**: the durable `connect_keys` table (Option C, restart-safe), and the team-member **invitation UI** - without it only superadmins can be multi-team, so this path is admin-only in practice today.
- **Verification**: `pnpm -r typecheck` green (both packages); 64 server tests green incl. 7 new gateway tests (cross-team success incl. existing-machine reuse, fail-closed minter mismatch, fail-closed non-member, superadmin authorization, no-claim back-compat, same-team/open-mode no-check, membership-scoped listing).

### D14 - Loopany skill as an installable agent skill + auto-install at loop creation (landed, new feature not in the original plan)

- **Motivation**: the loop-builder knowledge lived as ONE inline doc (`packages/server/src/SKILL.md`) served only over HTTP at `/api/skill`. Two problems: ① a single growing doc is harder for an agent to navigate than a routing overview + focused references; ② the agent had to fetch it over the network every capture, with no local, persistent skill install. D14 turns it into a **real, installable agent skill** and **auto-installs it locally at loop creation**, reusing the `npx skills` CLI (vercel-labs/skills) as the installer rather than hand-rolling detect/install/no-clobber/version logic.
- **Phase 0 - skill content (single source of truth, no fork)**: the old `src/SKILL.md` is **removed**; content is **moved** (not forked) into `packages/server/src/skill/`: `SKILL.md` is a **routing overview** (frontmatter `name: loopany` + a strong `description` so Claude auto-triggers it) pointing to `references/{create,update,evolve}.md` - the create flow (up → task file → config → `new`), the `loopany edit`/envelope-vs-task-file update flow, and the task-file-as-running-memory evolve model. `/api/skill` keeps serving the **overview** (`routes/api.skill.ts`, Vite `?raw`) as the bootstrap/back-compat path; a new **path-safe** route `GET /api/skill/references/<file>` (`routes/api.skill.references.$.ts`, static map - only the 3 exact filenames resolve, nothing else, no filesystem access) serves the references over HTTP as a **fallback** for when the local install was skipped. The server only reads bytes it shipped (zero-exec invariant holds).
- **Phase 2 - daemon integration (bundle + auto-install)**: the skill is **bundled into the public `@crewlet/loopany` npm package** (`package.json` `files` lists `skill`, generated from the server source by `scripts/sync-skill.mjs` on `build`/`prepublishOnly`, **gitignored** so it never drifts) - a **LOCAL path source**, deliberately chosen because the platform repo is **PRIVATE** so end users cannot install from it. The install fires at **loop creation, into the loop's own workdir** (corrected from the original `loopany up` trigger - see the trigger-fix bullet below): after `loopany new` confirms the gateway create succeeded, the daemon **best-effort installs the bundled skill** into the loop's resolved **workdir** (`<workdir>/.claude/skills/loopany/`) via `npx --yes skills add <bundled-dir> -a claude-code -y --copy` run with `cwd` set to that workdir (`src/skill-install.ts` `installSkill({cwd})`, `src/create.ts`; project scope is the `skills` CLI default; `-y` non-interactive + idempotent-overwrite; `--copy` self-contained, no symlink into the package's temp dir). It is **announced** (one status line) and **never blocks** loop creation - it runs only after a confirmed create, and any failure (no network/npx, no write perm, bundled skill absent) degrades **silently** to the always-working `/api/skill` path. `installSkill()` takes an injectable `Runner` (now carrying the `cwd`) and `runCreate` takes injectable fetch/installer seams, so tests need no network/npx (`skill-install.test.ts`, `create.test.ts`). A thin verb `loopany skill {status,install}` (`skill-cli.ts`, `-g`/`--global`) is the **manual escape hatch** - install by hand into cwd, or `-g` for `~/.claude`.
- **Trigger fix (corrected in 0.4.0)**: the auto-install originally ran during `loopany up`, installing into **the dir `up` was invoked from**. That was wrong - `loopany up` just stands up the machine daemon and may be run from anywhere (home/root) purely to start it, so it should not drop a `.claude/skills/loopany` into an arbitrary cwd. The install was **removed from `loopany up`** (`src/ensure.ts` no longer touches skills; the `--no-skill`/`--skill-global` flags that only drove it are gone) and **moved to `loopany new`**, scoped to the **loop's workdir** - the directory that loop's agent actually runs in - matching the feature's real intent. **Web-created loops** (made from the New-loop dialog with no local `loopany new`) are intentionally **not** covered - a separate lazy-at-run-time install idea the captain deferred.
- **Captain's settled decisions baked in**: reuse `npx skills` (not hand-rolled); **project-level** install default (not global); **announced + best-effort + never-blocks**. The `npx skills` mechanics (local-path install support, exact `skills add` invocation, project-scope default, `-y` non-interactive, update) were **verified against the current CLI** before relying on them.
- **Out of scope (intentional)**: multi-agent target dirs beyond Claude; durable update reconciliation beyond what `skills` gives for free.
- **Verification**: `pnpm -r typecheck` green; 28 daemon + 64 server tests green; daemon build green; a real `npx skills` e2e install verified. (Note: the server nitro `build` is green - both warm and clean rebuilds locally and in CI/Fly prod deploys; an earlier report of a `tslib`/`@aws-crypto` vendor-bundling failure could not be reproduced and was an environment-specific/transient local issue, not a standing defect - the `tslib (2.8.1)` line is nitro's normal dependency-tracing output.)

### D15 - Loop detail: dashboard modal → dedicated pages (landed, frontend/routing only)

- **Motivation**: the loop detail experience was a `Modal` popup (`JobDetailView` + a nested `RunView` modal) over the dashboard - not deep-linkable, not browser-back-able, and cramped. Redesigned into **dedicated TanStack Start routes** with a fresh layout. **Frontend/routing only**: reuses the existing server fns (`getJobDetail`/`getArtifacts`/`getArtifact`/`getRunDiff`/`getTranscript`/`loadOlderRuns`) and the Phase 1-3 artifact/diff plumbing - **NO backend was added or changed** (supersedes the modal-rendering parts of D7/D11/D12).
- **Loop page (`/loops/$loopId`)**: `routes/loops.$loopId.tsx` → `components/LoopDetailView.tsx` (renamed from `JobDetailView.tsx`). A header card (name/cron/next/agent/machine-status/id + a Run-once / Edit / ··· toolbar), an optional agent-authored `LoopView` dashboard, then a 2-col `[1.55fr_1fr]` grid of the unified Files panel and the **Runs** section (Timeline strip + clickable run list). The dashboard (`routes/index.tsx`) + `LoopCard` now **navigate** (`useNavigate`) instead of `setView` - no more `Modal` for detail. The page owns its own `getJobDetail` fetch + self-poll (3s while a run is live, else 8s; `ssr:false` so the session cookie rides along). Edit paths (hand-to-Claude-Code via `requestEdit`; manual `LoopForm` fallback) survive as in-page mode takeovers; reconnect renders `MachinesModal` on the page itself.
- **Unified Files panel (`components/LoopFilesPanel.tsx`)**: merges the former separate task-file box + `FilesView.tsx` (both **DELETED**) into ONE master-detail - a file list (task file pinned first with a `TASK` chip, then synced artifacts path-sorted) drives a content viewer; the **task file is selected by default**. Markdown (task file + `*.md`) renders via `TaskFileView` (gained a `bare` prop = no own inset/scroll, host owns the surface), other text in a mono `<pre>`, binary/oversize → the existing `/api/artifact/$loopId/$` download route. An artifact whose path equals the task file is de-duped.
- **Run page (`/loops/$loopId/runs/$runId`)**: `RunView.tsx` now exports a page-oriented **`RunDetailView`** (the old modal `RunView` is gone). The route file `loops.$loopId_.runs.$runId.tsx` uses the trailing-`_` on `$loopId` to **un-nest** it from the loop layout - a standalone, deep-linkable + browser-back full page, not an `<Outlet/>` panel. It resolves the run from `getJobDetail(loopId).runs` (latest ~100); a run older than that window is located by paging backward with the existing `loadOlderRuns` cursor fn (bounded by `MAX_OLDER_PAGES`, `try/finally` so `searchDone` always settles) so a run clickable in the `Timeline` strip never dead-ends - **still NO new backend**. Only when the backward walk is exhausted does it show the calm "no longer available" fallback. It self-polls while running (a **SILENT** poll, split from the err-setting initial load + `err` cleared on success, so a transient `getJobDetail` blip can't brick the page on the error guard - the initial-load error path also gained a **Retry** affordance), refetches the `getTranscript` trace when the run settles (keyed on `run.running`), and renders the Phase-3 `getRunDiff` "Changes".
- **Verification**: browser-verified (chrome-devtools-axi), four states screenshotted under `docs/screenshots/loop-detail-page/`; `pnpm -r typecheck` green (both packages); 58 server tests green (frontend-only change, no test delta).

### Verified (local e2e)

- `scripts/demo-cookie-unified.sh` - the "Cookie Daily Breakfast Report" runs end-to-end through the **unified TanStack server** (`pnpm dev`): daemon short-polls the TanStack machine route → claude produces the report → `loopany report`(agent-api route) → run `done` (43s, a real breakfast report).
- `scripts/demo-cookie.sh` - runs through the main.ts headless backend equally (backup path).
- **Dashboard browser test** (agent-browser): client → `listJobs` server fn → in-process store, the loop card renders correctly (Geist style).
- **Production server test**: nitro build → `drizzle-kit migrate` → `node .output/server/index.mjs`, page/server route/machine routes all normal.
- **auth off-by-default test**: with no GitHub credentials `/api/auth/get-session`→null, the dashboard renders as usual (doesn't break the verified flow).
- server unit tests 5 passed; both packages typecheck clean (already upgraded to latest: TS 6 / @types/node 25 / better-sqlite3 12.11 / nitro etc.).

## 12. v1 status (as of this round)

**Completed and verified**: monorepo · Drizzle/SQLite data layer · scheduling engine (cron+nextRunAt+pending/running/done/error+reclaim) · BYOA execution pipeline (daemon short-poll + claude spawn + workdir jail + loopany callback) · **workflow gate (machine side) - a pure workflow loop runs zero-agent: the daemon runs the JS → sends the message directly + a persistent cursor, never touching claude; only an `agent()` escalation runs claude** · unified TanStack single process (UI + server fn + machine routes + in-process scheduler) · dashboard reads real data · Slack notifications · Better Auth(GitHub+allowlist, off by default) · production nitro build + Fly config (Dockerfile/fly.toml/.env.example/README).

> **Real loop verification**: imported c0's live `~/.c0/cron/cron-mq640gkq-d01f285b.json` (Cookie Daily Breakfast Report, workflow-only, querying a Home Assistant feeder sensor) verbatim into LoopAny, the daemon triggered on the local machine (LAN-reachable HA) → `done/direct/124ms`, output real feeding data, zero agent (no sessionId), the cursor `{todayDate,grams}` persisted for the next `prev`. This fixes the gap where "the daemon always escalated to claude before".

**Filled in (this round's follow-up)**:
- **Machine binding UI**: a two-act "Connect computer" flow (command+wait → daemon reports hostname/platform → name prefilled → Done). `LOOPANY_DAEMON_CMD` is configurable (locally `npx tsx src/cli.ts` runs the source); the daemon's `loopany` shim changed to a self-contained node script (launch-method agnostic). Browser-tested.
- **AI-First compose = capture-from-Claude-Code (major change, see D5)**: abandon the server `role=draft` single-round drafting (a single round can't produce a suitable loop). Changed to the Web handing out a "connect line" (`<origin>/SKILL.md` + server-url + connect-key), the user pastes it into their own Claude Code → Claude starts the daemon + creates the loop via `POST /api/machine/loop`; the Web polls `listJobs` and on a hit flips to "Loop created ✓". The entire draft subsystem is deleted (drafts table/`createDraft`/`getDraft`/`runDraft`/`draftReport`/draft token/`/machine/draft-report`, migration `0003` DROP). **agent-browser + curl e2e passed.**
- **workflow-only loop**: the daemon runs the workflow gate, a pure workflow sends directly zero-agent (verified by the real Cookie loop).
- **evolution (evolve role) wired up + tested**:
  - **Trigger**: manual `evolveJob`→`scheduler.evolveNow` (the detail "Evolve now" button, `canEvolve`=allowed only with a stateSchema or workflow); automatic `maybeFlagEvolve` (after an exec run succeeds, if `countRuns - evolvedRunCount ≥ LOOPANY_EVOLVE_EVERY`(default 3) then set `evolveDue` + a 5s-delayed evolve tick).
  - **Dispatch**: a `role:evolve` run, `buildDelivery` uses the `evolve.md` system prompt + `buildEvolveTask`(the most recent 12 runs' data); the daemon `runDelivery` for evolve **skips the workflow gate, runs claude directly**, outcome=`evolve`, returns no message.
  - **Permissions**: an evolve run-token carries `canSetUi/canSetSchema/canSetWorkflow` (+`allowControl`); agent-api admits `set-ui`/`set-schema`/`set-workflow` accordingly (set-schema is incremental, must not drop a key still in use), an exec run-token calling these → 403.
  - **Wrap-up**: `report`(role=evolve)→`finishEvolution` (clears `evolveDue`, pushes `evolvedRunCount`=countRuns, `nextRunAt`=null); evolve doesn't send Slack; the sweep/dispatch failure path also `finishEvolution` to avoid getting stuck.
  - **Tests (curl plays daemon+claude, driving the real server pipeline)**: manual/automatic trigger → dispatch role=evolve+the evolve prompt → set-ui/schema/workflow stored (ui set, schema adds paid, workflow replaced) → report→`done/evolve`, `evolveDue` cleared, `evolvedRunCount` advanced; negative: a non-evolvable loop is rejected, an exec token set-ui→403. Added an `/api/admin {action:'evolve'}` dev trigger hook (peer to run-loop).

**Still to do (v1.x)**:
- SKILL.md real-machine closed loop: have Claude Code actually go start the daemon + create the loop (both API/UI sides verified; missing one full-chain run of "a real person pasting the connect line in Claude Code").
- **GitHub OAuth round-trip test**: needs a real GitHub OAuth app (no local credentials, the structure landed per the official docs).
- WS push, shadow/graduation, codex - see §10. (The transcript view already landed early, see D7.)
