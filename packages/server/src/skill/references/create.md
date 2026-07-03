# Create a loop

This machine is already connected — `loopany up` on first capture (see `bootstrap.md`)
or the running daemon from when the loop was installed. Now decide what to build,
author it, and create it. Use the **loopany-cli** prefix the user pasted (default
`npx @crewlet/loopany@latest`) and the **connect-key** from the capture snippet
(present on the first-capture path).

## 0 · Decide what to build

A loop only makes sense with a real task behind it. Read the session you're in and
pick the starting point:

- **The user already did a clear task this session** (the common case — they just
  finished something and want it to keep happening). Turn *that task* into the loop:
  recap it in one line, then build around it using the real URLs, paths, commands,
  and thresholds from what you just did together.
- **There's no task yet** (the session is essentially empty — they pasted the
  onboarding prompt and nothing else). **Don't invent a loop from thin air.** Look at
  what *this project actually is* (its README, its code, its purpose) and brainstorm
  a few concrete loops that would be useful FOR IT, then let the user pick. Make the
  options specific to what you see, e.g.:
  - "Each morning, summarize new commits/issues in this repo and flag anything risky."
  - "Every hour, run the health check against <the service this deploys> and alert
    only when it's down."
  - "Iterate on <the failing test suite> until it's green, then finish."

Only continue once there's a real intent — the task already in this session, or the
loop the user picked.

## 0.5 · Settle cadence, output, and (if goal-shaped) the finish line

Two parameters are easy to leave unspecified, and you must **never silently guess**
them: **how often the loop runs** and **what each run produces**. A third applies
only to some loops: whether the loop has a **finish line**. Reason about sensible
defaults for *this specific task*, propose them in plain language in one short
message, and get a yes (or an adjustment) before you create — **propose → confirm →
build**.

- **Cadence.** Propose a schedule that fits the task: a daily digest → "every day at
  9am your time"; a monitor → "every hour"; a weekly roundup → "Monday mornings".
  State it in human terms; you turn it into cron in §2.
- **Per-run output.** Propose a concrete artifact or message format: "a short markdown
  summary in `report.md`", "a one-line status, alert only when something looks off",
  "an article at `articles/<date>.md`". This becomes the Spec + notify rule.
- **Finish line — only for goal-shaped tasks.** Some tasks have a definite done state:
  the user says "until", "reach", "iterate to", "get X to Y". Those are **closed
  loops** — they carry a one-line, checkable **goal** and finish themselves when it's
  met. Propose that finish line too ("…and stop once the suite passes"). Most loops
  are **monitor-shaped** — digests, watches, health checks that run indefinitely.
  For those, there is no goal: don't propose one or mention finishing.

Propose all applicable pieces together — e.g. *"I'll run this every hour and iterate
on the failing tests, dropping a status in `report.md`, and finish once the whole
suite is green — sound good?"* — so the user confirms in one reply. (This pairs with
§0: no task → ask first; loose parameters → propose and confirm. Quick check-ins,
not an interview.)

## 1 · Create the loop's folder and task file

Every loop gets its **own folder** under the project: `<project>/loopany/<slug>/`
(make it if needed; pick a short `<slug>` from the loop name). That's the loop's home
— its task file lives there, and by default every artifact it produces (reports,
exports, scratch) lands there too, so its output stays self-contained.

Inside it, write the **task file** at `<project>/loopany/<slug>/README.md`: a markdown
doc that is the loop's durable brief and running memory. Each scheduled run reads it
for context and maintains it, so the loop stays coherent over time (see `evolve.md`).
Fill it from what we ACTUALLY just did — real URLs, paths, commands, thresholds:

```markdown
# <Loop name>

## Spec
What this loop checks or does and why, plus the concrete steps / commands /
endpoints / files involved — the real ones from this session. State when to message
the user vs. stay silent. For a goal-driven (closed) loop, open the Spec with one or
two sentences restating the mission and the finish line the loop works toward — so
the run reads it as prose (the authoritative, checkable setpoint lives in the config
`goal`, not here). There is NO `## Goal` section.

## Current understanding
The baseline / known state / open issues — what the loop currently expects. Seed it
with what we established this session; each run updates it.

## Timeline
<!-- one dated entry per run, appended below by the loop -->
```

Keep the absolute path to `README.md` — it goes in the config as `taskFile`.

## 2 · Author the loop config

A loop fires on a cron schedule. Each run is **either**:

- **workflow** *(preferred when the task is deterministic — zero-LLM, cheap)*: a JS
  **function body** run in Node with global `fetch`, a `prev` cursor (the last run's
  returned `state`), and `tools.call(...)` (the machine's configured MCP servers; see
  `evolve.md`). Contract: `return { message?: string, state?: any }`. `message` is
  sent to the user verbatim (no LLM). `state` persists and is handed back as `prev`
  next run (use it to diff / avoid repeating). To escalate to the coding agent
  instead, call `agent(message?, data?)`. Prefer this whenever the task reduces to
  hitting an API, reading a value, or computing a digest.
- **the coding agent (claude)**: for runs that need reasoning, code, or file work. It
  runs via claude-code in `workdir`, driven by a server-composed trigger that points
  it at your **task file** — so there's no per-run instruction to write; the brief
  lives entirely in the task file's `## Spec`.

### Workflow syntax contract — read this before writing one

**What a workflow IS:** a plain **JavaScript statement sequence** that LoopAny runs
*inside* an async function — so top-level `await` is fine and you end with
`return { message?, state? }`. The injected globals `prev`, `agent(message?, data?)`,
`tools.call(name, args)`, and `fetch` are already in scope — use them directly.

**What a workflow is NOT:** it is **not an ES module** and **not the Claude Code
`Workflow` tool**. Do **not** start it with `export const meta = {…}`, and do **not**
use any top-level `export`/`import` — those are a parse error that fails the whole run
before any line executes. (If you know the Claude Code `Workflow` tool, forget its
`export const meta` header here — this is a different, smaller thing: no header, no
imports.) Need a module? Use dynamic `await import('node:os')`. There is no `require`.
The server parse-checks the body at write time and rejects a bad one with this same
guidance, so a rejected `loopany new`/`edit`/`set-workflow` means fix the syntax.

**Canonical example** (the whole surface — no header, no imports):

```js
const res = await tools.call("posthog.exec", { query: "select 1" });
const rows = res.data?.results ?? [];
if (rows.length === (prev?.count ?? -1)) return { state: prev };   // nothing new → silent tick
agent("summarize what changed", rows);                            // escalate to the agent
return { message: `${rows.length} rows`, state: { count: rows.length } };
```

Author the config **inline** and pass it to `loopany new --json` (§3) — no config
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
  that runs indefinitely (§0.5).
- `stateSchema` is optional — declare numeric per-run metrics to get a chart. (The
  dashboard itself is usually left to a later evolve pass — see `evolve.md` §3.)
- `notify`: `auto` (only when there's something to say) | `always` | `never`.
- **Don't add `timezone`, `claim`, or any auth** — `loopany new` injects the
  timezone, the connect-key claim, and this machine's device token. (Override the zone
  only if the user states a different one: pass `--tz <IANA>` in §3.)

## 3 · Validate, then create

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

`loopany new` detects the IANA timezone, injects the claim, **records the coding
agent** (the `--agent` you pass, or — preferred — the host it sniffs from its own
env), authenticates, validates, and POSTs it. On success it prints `created loop
<name> — <cron> <timezone>`; the loop now appears in the web UI and runs on schedule.
(For a large inline config, `--json -` reads it from stdin.) On `loopany: <error>`,
fix the config and re-run.

Finally, tell the user it's created (name + cadence) and that it will run
automatically for the first time shortly — point them at the LoopAny web UI to watch
for the first result.
