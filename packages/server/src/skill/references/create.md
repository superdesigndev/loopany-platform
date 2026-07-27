# Create a task (and optionally make it a loop)

This machine is already connected — `loopany daemon up` on first capture (see
`bootstrap.md`) or the daemon that's been running since. Decide what to build,
author it, create it. Use the **loopany-cli** prefix the user pasted (default
`npx @crewlet/loopany@latest`) and, on the first-capture path, the **connect-key**
from the capture snippet.

Everything here creates a **task**: a folder (`<slug>/README.md` + artifacts
beside it) registered in the owner's task tree. A task with `cron` set is a
**loop** — it runs on schedule; without one it's inert tracked work. Recurrence
is a field you can add or remove later (`loopany update <id> cron=…`).

## 1 · Decide what to build

A task only makes sense with real intent behind it. Read the session you're in and
pick the starting point:

- **The user already did a clear task this session** (the common case — they just
  finished something and want it captured or recurring). Turn *that* into the task:
  recap it in one line, then build around the real URLs, paths, commands, and
  thresholds from what you just did together.
- **The capture snippet itself carries a task description** (the user started from a
  template card on the dashboard). That description IS the intent — build exactly
  that loop, grounded in this project's real paths and commands, and still confirm
  anything it leaves open in §2.
- **There's no task yet** (the session is essentially empty). **Don't invent a loop
  from thin air.** Look at what *this project actually is* (its README, its code,
  its purpose), brainstorm a few concrete loops that would be useful FOR IT, and let
  the user pick. Make the options specific to what you see, e.g.:
  - "Each morning, summarize new commits/issues in this repo and flag anything risky."
  - "Every hour, run the health check against <the service this deploys> and alert
    only when it's down."
  - "Iterate on <the failing test suite> until it's green, then finish."

**Dedup and place before you create.** Run `loopany search <keywords>` (it looks
across ALL the user's devices, not just this one) — a similar
task may already exist (update it instead of duplicating). Then pick the parent:
`loopany list` shows the tree; a new experiment/task usually hangs under the
strategy or goal it serves (`--parent <slug>`). A node with no parent is a
top-level goal. Only continue once there's a real intent and a chosen place.

## 2 · Settle cadence, output, and the finish line

**Never silently guess** how often a loop runs or what each run produces. Reason
out sensible defaults for *this specific task*, propose them in plain language in
one short message, and get a yes (or an adjustment) before you create — **propose →
confirm → build**. (An inert, non-recurring task needs none of this — just create it.)

- **Cadence.** Propose a schedule that fits the task: a daily digest → "every day at
  9am your time"; a monitor → "every hour"; a weekly roundup → "Monday mornings".
  State it in human terms; it becomes the `cron` field in §4.
- **Per-run output.** Propose a concrete artifact or message format: "a short markdown
  summary in `report.md`", "a one-line status, alert only when something looks off",
  "an article at `articles/<date>.md`". This becomes the Spec + notify rule.
- **Product format — when the loop writes markdown products.** Design their shape now
  so the dashboard can index them. Each product opens with a fenced `---` front-matter
  block of **flat top-level `key: value` scalars** (no nested YAML, no lists — the
  parser reads only flat scalars): `type:` the loop's own one-word classification
  label, `title:` a display title, `date:` the product's day (`YYYY-MM-DD`; omit it
  for a living doc that isn't a dated product). All three are optional. Pick the
  loop's small, fixed **`type` vocabulary** up front — e.g. `idea | draft | published`,
  or `research | in-progress | done` — and write it into the Spec so every run reuses
  the same words; a `<loop-kanban>` dashboard board keys its columns on it (see
  evolve.md §3). The dashboard treats `date:` as the authoritative calendar date and
  shows `type`/`title` as quiet chips in the Files list. A compact example:

  ```markdown
  ---
  type: draft
  title: Q3 outreach plan
  date: 2026-07-01
  ---

  # Q3 outreach plan
  …body…
  ```
- **Finish line — only for goal-shaped tasks.** Some tasks have a definite done state:
  the user says "until", "reach", "iterate to", "get X to Y". Those are **closed
  loops** — they carry a one-line, checkable **goal** and finish themselves when it's
  met. Propose that finish line too ("…and stop once the suite passes"). Most loops
  are **monitor-shaped** — digests, watches, health checks that run indefinitely.
  For those, there is no goal: don't propose one or mention finishing.

Propose all applicable pieces together — e.g. *"I'll run this every hour and iterate
on the failing tests, dropping a status in `report.md`, and finish once the whole
suite is green — sound good?"* — so the user confirms in one reply. (This pairs with
§1: no task → ask first; loose parameters → propose and confirm. Quick check-ins,
not an interview.)

## 3 · Create it, then write the real Spec

Every task gets its **own folder** (`<slug>/README.md` + artifacts beside it), and by
default the lightweight products it produces (reports, exports, dashboard `ui`, small
artifacts) land there too, so its output stays self-contained.

**This folder is a synced content home, not a scratch workspace.** The daemon
continuously syncs it to the server, so heavy work products MUST live elsewhere: when a
run needs to clone a repo, open a git worktree, install `node_modules`, or produce build
output or caches, it does that work **outside** the loop folder (a sibling directory or a
temp dir) and writes only the finished report/artifact back in. Author the Spec so runs
naturally keep bulk out — e.g. *"do the fix in a git worktree created outside this loop
folder"*, never inside it. A repo checkout dropped in the loop folder floods the sync.

`loopany create` scaffolds the folder + README and registers the task in one step
(idempotent on the slug; a fuzzy-duplicate title warns unless `--force`):

```bash
<loopany-cli> create "Reddit AI-citation brief" \
  --parent acquisition --type experiment --priority P1 \
  --cron "0 5 * * *" \
  --json '<envelope from §4 — for goal/workflow/ui etc.>'
```

`--cron` is what makes it a **loop** — omit it (and any envelope `cron`) for an
inert task with no schedule. A simple daily loop needs nothing but the title and
`--cron`; reach for `--json` only when the envelope carries more (goal, workflow,
dashboard). `--assignee <email>` records the responsible person in the front
matter (handing the task to an agent-on-a-device is a post-create step:
`loopany update <id> assignee=<machine>/<agent>`, see `update.md`).

It prints the created folder (default `~/loopany/<slug>/`; override the root with
`LOOPANY_TASKS_DIR`). The scaffolded `README.md` is the task's durable brief and
running memory — front-matter work-state on top, then the three sections every run
maintains:

```markdown
---
id: <slug>            title: <name>       type: goal|strategy|experiment|task|idea
status: idea|todo     priority: P0-P3     parent: <parent slug>
---

## Spec
## Current understanding
## Timeline
```

**Now open that README and replace the placeholder `## Spec`** with the real brief
from this session — concrete URLs, paths, commands, thresholds; when to message the
user vs. stay silent; the product front-matter convention from §2 if the loop writes
markdown. Seed `## Current understanding` with what you established this session.
For a goal-driven (closed) loop, open the Spec with a sentence or two restating the
mission and the finish line — prose only; the authoritative, checkable setpoint
lives in the `goal` field, not here. There is NO `## Goal` section. The file syncs
automatically; it is the task's source of truth.

## 4 · The envelope (`--json`) — only for a RECURRING task

The envelope carries the execution fields. Each scheduled run is **either**:

- **workflow** *(preferred when the task is deterministic — zero-LLM, cheap)*: a JS
  **function body** run in Node with global `fetch`, a `prev` cursor (the last run's
  returned `state`), and `tools.call(...)` (the machine's configured MCP servers; see
  `evolve.md`). Contract: `return { message?: string, state?: any }`. `message` goes
  to the user verbatim (no LLM); `state` persists and comes back as `prev` next run
  (use it to diff / avoid repeating). To escalate to the coding agent instead, call
  `agent(message?, data?)`. Prefer this whenever the task reduces to hitting an API,
  reading a value, or computing a digest.
- **the coding agent**: for runs that need reasoning, code, or file work. It
  runs via your loop's host coding agent in `workdir`, driven by a server-composed trigger that points
  it at your **task file** — no per-run instruction to write; the brief lives
  entirely in the task file's `## Spec`.

### Workflow syntax contract — read this before writing one

A workflow **IS** a plain **JavaScript statement sequence** that Loopany runs
*inside* an async function — so top-level `await` is fine and you end with
`return { message?, state? }`. The injected globals `prev`, `agent(message?, data?)`,
`tools.call(name, args)`, and `fetch` are already in scope — use them directly.
It runs **locally on the loop's machine** as a bare `node` subprocess (isolation =
subprocess + timeout + allowlisted env, not a capability sandbox): every node builtin
works via dynamic `await import(...)`, so a script may read a local credential file at
runtime and call an authenticated API with plain `fetch` — an MCP server is one way to
reach an external tool, never the only one. One hard rule: **never embed a secret
literal in the body** — it is stored server-side; credentials belong on the machine
(a local file read at runtime, or `LOOPANY_WORKFLOW_ENV` passthrough), never in the
script text.

A workflow is **NOT an ES module** and **not the Claude Code `Workflow` tool**. Do
**not** start it with `export const meta = {…}`; any top-level `export`/`import` is a
parse error that fails the whole run before any line executes. Need a module? Use
dynamic `await import('node:os')`. There is no `require`. The server parse-checks
the body at write time and rejects a bad one with this same guidance — a rejected
`loopany create`/`update` means fix the syntax.

**Canonical example** (the whole surface — no header, no imports):

```js
const res = await tools.call("posthog.exec", { query: "select 1" });
const rows = res.data?.results ?? [];
if (rows.length === (prev?.count ?? -1)) return { state: prev };   // nothing new → silent tick
agent("summarize what changed", rows);                            // escalate to the agent
return { message: `${rows.length} rows`, state: { count: rows.length } };
```

The envelope keys (pass only what applies — the CLI fills identity/paths):

```json
{
  "cron": "m h dom mon dow",
  "goal": "<one-line checkable finish line — omit for a monitor loop>",
  "workflow": "<JS function body>",
  "workdir": "<absolute dir runs execute in — defaults to the task's folder>",
  "stateSchema": [{ "key": "x", "label": "X", "unit": "" }],
  "ui": "<small dashboard HTML — optional; see 'Dashboard at create' below>",
  "notify": "auto"
}
```

Rules:
- **`goal` makes the loop closed**: with a goal set, each run judges it and calls
  `loopany finish` when met, ending the loop. Omit `goal` for a monitor/digest loop
  that runs indefinitely (§2).
- `stateSchema` is optional — declare numeric per-run metrics to get a chart.
- `ui` is optional — the loop's dashboard panel as small HTML (see **Dashboard at
  create** below).
- `notify`: `auto` (only when there's something to say) | `always` | `never`.
- **Don't add `timezone` or any auth** — the CLI injects the timezone and this
  machine's device token. (If the user states a different zone, put
  `"timezone": "<IANA>"` in the envelope.)
- **First-capture path only** (bootstrap.md): also put the pasted connect-key and
  your agent identity in the envelope — `"claim": "<connect-key>",
  "agent": "claude-code"` — so the waiting web dialog learns the loop was created.

### Dashboard at create — when the product shape is already known

The dashboard is usually left to a later evolve pass, but when you ALREADY know the
loop's product shape at create time — a template-driven loop, or any loop whose Spec
fixes the artifacts/metrics up front — author the initial `ui` NOW and include it in
the config, so the loop has a day-one dashboard instead of a blank one until it
evolves. Use the same panel primitives and `{{latest.<key>}}` bindings documented in
`evolve.md` §3 (`<loop-chart>` for a metric trend, `<loop-kanban>`/`<loop-embed>`/
`<loop-calendar>` for the loop's typed products, `<loop-tabs>` to split several panels
into tabs) — don't duplicate that guidance here;
just bind only keys your `stateSchema` declares and columns your Spec's `type`
vocabulary uses. Keep it small. Skip it when the product shape isn't settled yet — a
speculative dashboard is worse than none.

**Template references (on demand).** When the task came from a dashboard template,
it may ship a per-template reference with a validated dashboard layout and state
schema at `<server-url>/api/skill/references/templates/<template-name>/reference.md`
— fetch it when you reach this step (never earlier; it's deliberately not in the
paste prompt). Start from that layout and adapt it to the vocabulary you agreed
with the user, rather than composing a dashboard from scratch.

## 5 · Validate, then create

Preview with `--dry-run` first — the server validates the envelope and echoes the
normalized config, detected timezone, the next 3 fire times, and the open/closed
classification, persisting nothing:

```bash
<loopany-cli> create "<title>" --parent <slug> --json '<envelope>' --dry-run
```

no goal → `open: runs until paused`) and the fire times look right. `workflow` and
`ui` are echoed as presence flags (`yes`/`no`), not their source — if you authored a
`ui` and the preview says `ui: no` (plus a warning), it validated to nothing; fix the
HTML before creating. Then create for real (drop `--dry-run`). On success the task
appears in the tree (`loopany list`) and — when it has a cron — runs once immediately;
if a `ui` was dropped the response still carries a `loopany: warning:`, so re-check and
push a fix with `loopany update <id> --ui-file <path>` (`update.md`). On `loopany:
<error>`, fix and re-run (create is idempotent on the slug — a retry never duplicates).

Finally, tell the user it's created (name + cadence if recurring) and — for a loop —
that the first run comes automatically shortly; point them at the Loopany web UI
(the Tasks page shows the tree; the loop page shows runs) to watch for the result.

## Cloud-born tasks

`loopany create "<title>"` births the task in the CLOUD — no local folder or
README is written. Seed the brief with `--spec "<text>"` or `--spec-file <path>`
(the doc's `## Spec`). The task's folder appears lazily when a run first writes
artifacts into it. Attach external material with `refs:` in the work-state
(URLs, tickets, repo paths) instead of copying files — state gets a row; bytes
stay files.
