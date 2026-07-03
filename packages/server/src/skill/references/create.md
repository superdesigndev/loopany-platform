# Create a loop

This machine is already connected — `loopany up` on first capture (see `bootstrap.md`)
or the daemon that's been running since. Decide what to build, author it, create it.
Use the **loopany-cli** prefix the user pasted (default `npx @crewlet/loopany@latest`)
and, on the first-capture path, the **connect-key** from the capture snippet.

## 1 · Decide what to build

A loop only makes sense with a real task behind it. Read the session you're in and
pick the starting point:

- **The user already did a clear task this session** (the common case — they just
  finished something and want it to keep happening). Turn *that task* into the loop:
  recap it in one line, then build around the real URLs, paths, commands, and
  thresholds from what you just did together.
- **There's no task yet** (the session is essentially empty). **Don't invent a loop
  from thin air.** Look at what *this project actually is* (its README, its code,
  its purpose), brainstorm a few concrete loops that would be useful FOR IT, and let
  the user pick. Make the options specific to what you see, e.g.:
  - "Each morning, summarize new commits/issues in this repo and flag anything risky."
  - "Every hour, run the health check against <the service this deploys> and alert
    only when it's down."
  - "Iterate on <the failing test suite> until it's green, then finish."

Only continue once there's a real intent — the task already in this session, or the
loop the user picked.

## 2 · Settle cadence, output, and the finish line

**Never silently guess** how often the loop runs or what each run produces. Reason
out sensible defaults for *this specific task*, propose them in plain language in
one short message, and get a yes (or an adjustment) before you create — **propose →
confirm → build**.

- **Cadence.** Propose a schedule that fits the task: a daily digest → "every day at
  9am your time"; a monitor → "every hour"; a weekly roundup → "Monday mornings".
  State it in human terms; you turn it into cron in §4.
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

## 3 · Create the loop's folder and task file

Every loop gets its **own folder** under the project: `<project>/loopany/<slug>/`
(make it if needed; pick a short `<slug>` from the loop name). Its task file lives
there, and by default every artifact it produces (reports, exports, scratch) lands
there too, so its output stays self-contained.

Write the **task file** at `<project>/loopany/<slug>/README.md` — the loop's durable
brief and running memory. Each scheduled run reads it for context and maintains it
(see `evolve.md`). Fill it from what we ACTUALLY just did — real URLs, paths,
commands, thresholds:

```markdown
# <Loop name>

## Spec
What this loop checks or does and why, plus the concrete steps / commands /
endpoints / files involved — the real ones from this session. State when to message
the user vs. stay silent. If the loop writes markdown products, state their
front-matter convention here too: the fixed `type:` vocabulary this loop uses and
whether products carry a `date:` (see §2). For a goal-driven (closed) loop, open the
Spec with a sentence or two restating the mission and the finish line — prose only;
the authoritative, checkable setpoint lives in the config `goal`, not here. There is
NO `## Goal` section.

## Current understanding
The baseline / known state / open issues — what the loop currently expects. Seed it
with what we established this session; each run updates it.

## Timeline
<!-- one dated entry per run, appended below by the loop -->
```

Keep the absolute path to `README.md` — it goes in the config as `taskFile`.

## 4 · Author the loop config

A loop fires on a cron schedule. Each run is **either**:

- **workflow** *(preferred when the task is deterministic — zero-LLM, cheap)*: a JS
  **function body** run in Node with global `fetch`, a `prev` cursor (the last run's
  returned `state`), and `tools.call(...)` (the machine's configured MCP servers; see
  `evolve.md`). Contract: `return { message?: string, state?: any }`. `message` goes
  to the user verbatim (no LLM); `state` persists and comes back as `prev` next run
  (use it to diff / avoid repeating). To escalate to the coding agent instead, call
  `agent(message?, data?)`. Prefer this whenever the task reduces to hitting an API,
  reading a value, or computing a digest.
- **the coding agent (claude)**: for runs that need reasoning, code, or file work. It
  runs via claude-code in `workdir`, driven by a server-composed trigger that points
  it at your **task file** — no per-run instruction to write; the brief lives
  entirely in the task file's `## Spec`.

### Workflow syntax contract — read this before writing one

A workflow **IS** a plain **JavaScript statement sequence** that Loopany runs
*inside* an async function — so top-level `await` is fine and you end with
`return { message?, state? }`. The injected globals `prev`, `agent(message?, data?)`,
`tools.call(name, args)`, and `fetch` are already in scope — use them directly.

A workflow is **NOT an ES module** and **not the Claude Code `Workflow` tool**. Do
**not** start it with `export const meta = {…}`; any top-level `export`/`import` is a
parse error that fails the whole run before any line executes. Need a module? Use
dynamic `await import('node:os')`. There is no `require`. The server parse-checks
the body at write time and rejects a bad one with this same guidance — a rejected
`loopany new`/`edit`/`set-workflow` means fix the syntax.

**Canonical example** (the whole surface — no header, no imports):

```js
const res = await tools.call("posthog.exec", { query: "select 1" });
const rows = res.data?.results ?? [];
if (rows.length === (prev?.count ?? -1)) return { state: prev };   // nothing new → silent tick
agent("summarize what changed", rows);                            // escalate to the agent
return { message: `${rows.length} rows`, state: { count: rows.length } };
```

Author the config **inline** and pass it to `loopany new --json` (§5) — no config
file to write. Only the loop's real intent goes in it; the CLI fills the envelope:

```json
{
  "name": "short human name",
  "cron": "m h dom mon dow",
  "workflow": "<JS function body>",
  "goal": "<one-line checkable finish line — omit for a monitor loop>",
  "workdir": "<absolute project dir>",
  "taskFile": "<absolute path to the task file above>",
  "stateSchema": [{ "key": "x", "label": "X", "unit": "" }],
  "ui": "<small dashboard HTML — optional; see 'Dashboard at create' below>",
  "notify": "auto"
}
```

Rules:
- Include **`workflow` or `taskFile`** (or both, if the workflow escalates to the
  agent). There is no `task` field — the agent's brief is the task file, so set
  `workdir` + `taskFile` for any agent loop. Make any `workflow` self-contained and
  defensive (handle fetch failures).
- **`goal` makes the loop closed**: with a goal set, each run judges it and calls
  `loopany finish` when met, ending the loop. Omit `goal` for a monitor/digest loop
  that runs indefinitely (§2).
- `stateSchema` is optional — declare numeric per-run metrics to get a chart.
- `ui` is optional — the loop's dashboard panel as small HTML (see **Dashboard at
  create** below).
- `notify`: `auto` (only when there's something to say) | `always` | `never`.
- **Don't add `timezone`, `claim`, or any auth** — `loopany new` injects the
  timezone, the connect-key claim, and this machine's device token. (If the user
  states a different zone, pass `--tz <IANA>` in §5.)

### Dashboard at create — when the product shape is already known

The dashboard is usually left to a later evolve pass, but when you ALREADY know the
loop's product shape at create time — a template-driven loop, or any loop whose Spec
fixes the artifacts/metrics up front — author the initial `ui` NOW and include it in
the config, so the loop has a day-one dashboard instead of a blank one until it
evolves. Use the same panel primitives and `{{latest.<key>}}` bindings documented in
`evolve.md` §3 (`<loop-chart>` for a metric trend, `<loop-kanban>`/`<loop-embed>`/
`<loop-calendar>` for the loop's typed products) — don't duplicate that guidance here;
just bind only keys your `stateSchema` declares and columns your Spec's `type`
vocabulary uses. Keep it small. Skip it when the product shape isn't settled yet — a
speculative dashboard is worse than none.

## 5 · Validate, then create

Preview first with `--dry-run` — the server validates the config and echoes the
normalized envelope, detected timezone, the next 3 fire times, and the open/closed
classification, persisting nothing:

```bash
<loopany-cli> new --json '<config>' --dry-run
```

Check the classification matches your intent (a `goal` → `closed: will self-finish`;
no goal → `open: runs until paused`) and the fire times look right. Then create for
real — pass the connect-key so the web dialog learns the loop was created, and
declare which coding agent you are:

```bash
<loopany-cli> new \
  --json '<config>' \
  --connect-key <connect-key> \
  --agent claude-code          # which coding agent you are (claude-code | codex); omit to auto-detect
```

`loopany new` detects the IANA timezone, injects the claim, records the coding agent
(the `--agent` you pass, or — preferred — the host it sniffs from its own env),
authenticates, validates, and POSTs it. On success it prints `created loop <name> —
<cron> <timezone>`; the loop now appears in the web UI and runs on schedule. (For a
large inline config, `--json -` reads it from stdin.) On `loopany: <error>`, fix the
config and re-run.

Finally, tell the user it's created (name + cadence) and that the first run comes
automatically shortly — point them at the Loopany web UI to watch for the result.
