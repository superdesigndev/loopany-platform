# Create a loop

This machine is already connected — `loopany up` on first capture (see `bootstrap.md`)
or the running daemon from when the loop was installed. Now author the loop and create
it. Use the **loopany-cli** prefix the user pasted (default `npx @crewlet/loopany@latest`)
and the **connect-key** from the capture snippet (present on the first-capture path).

## 0 · Make sure there's a real task to loop

A loop only makes sense when there's a real task behind it. If the session is
essentially empty — the user just pasted the onboarding prompt and there's no actual
task or intent in context — **do not invent a loop.** Ask the user what kind of loop
they'd like to create, and offer a few concrete examples to make it easy to answer:

- "Find and summarize the single most relevant Hacker News story for me each day"
- "Monitor our service's health and alert me when something looks off"
- "Analyze this project's codebase and report on <something you care about>"

Only continue to the steps below once there's a real intent — either already in this
session, or supplied by the user's answer.

## 0.5 · Settle the cadence and output format — propose, confirm, then build

Even with a clear task, two parameters are easy to leave unspecified, and you must
**never silently guess** them: **how often the loop runs** and **what each run
produces**. When the user hasn't stated one, reason about a sensible default for
*this specific task*, propose it in plain language, and get a yes (or an adjustment)
before you run `loopany new`. The pattern is **propose → confirm → build**.

- **Cadence.** If the user didn't say how often, propose a schedule that fits the
  task: a daily digest → "every day at 9am your time"; a monitor / health check →
  "every hour"; a weekly roundup → "Monday mornings". State it in human terms — you
  turn it into a cron expression in §2.
- **Per-run output.** If the user didn't say what each run should produce, propose a
  concrete artifact or message format: "a short markdown summary in `report.md`", "a
  one-line status, with an alert only when something looks off", "an article at
  `articles/<date>.md`". This becomes the loop's Spec and notify rule (§1–§2).

Propose both together in one short message — e.g. *"I'll run this every morning at
9am and drop a short markdown summary in `report.md` each day — sound good?"* — so
the user can confirm or adjust in a single reply. Once they've confirmed, continue to
the steps below with the agreed cadence and output. (This pairs with §0: if there's
no task at all, ask first; if there's a task but loose parameters, propose and
confirm. Both are quick check-ins, not a full interview.)

## 1 · Create the loop's folder and task file

Every loop gets its **own folder** under the project: `<project>/loopany/<slug>/`
(make it if needed; pick a short `<slug>` from the loop name). That folder is the
loop's home — its task file lives there, and by default every artifact the loop
produces (reports, exports, generated files, scratch) lands there too, so each
loop's output stays self-contained and out of the project's way.

Inside it, write the **task file** at `<project>/loopany/<slug>/README.md`: a markdown
doc that is the loop's durable brief and running memory. Each scheduled run reads it
for context and maintains it, so the loop stays coherent over time (see
`evolve.md`). Fill it from what we ACTUALLY just did — real URLs, paths, commands,
thresholds:

```markdown
# <Loop name>

## Spec
What this loop checks or does and why, plus the concrete steps / commands /
endpoints / files involved — the real ones from this session. State when to message
the user vs. stay silent.

## Current understanding
The baseline / known state / open issues — what the loop currently expects. Seed it
with what we established this session; each run updates it.

## Timeline
<!-- one dated entry per run, appended below by the loop -->
```

Keep the absolute path to `README.md` — it goes in the config as `taskFile`.

## 2 · Author the loop config

A loop fires on a cron schedule. Each run is **either**:

- **workflow** *(preferred — zero-LLM, cheap)*: a JS **function body** run in Node
  with global `fetch` and a `prev` cursor (the last run's returned `state`).
  Contract: `return { message?: string, state?: any }`. `message` is sent to the
  user verbatim (no LLM). `state` is persisted and handed back as `prev` next run
  (use it to diff / avoid repeating). To escalate to the coding agent instead,
  call `agent(message?, data?)`. Prefer this whenever the task is deterministic
  (hit an API, read a value, compute a digest).
- **task** *(the coding agent / claude)*: a natural-language instruction for runs
  that need reasoning, code, or file work. It runs via claude-code in `workdir`.

**The method lives in the task file, not in `task`.** Since you wrote the task file
above, keep `task` SHORT — don't restate the steps/filters/queries there. `task` is
just the trigger: point the agent at the task file and state the notify behavior.
For example:

> "Read the task file `loopany/<slug>/README.md` (and any docs it links) and run it
> for today. Append a Timeline entry when done. Per its Spec, message the user only
> when warranted; otherwise return nothing."

Turn the cadence you settled in §0.5 into a 5-field `cron` expression (if the user
never gave one and you haven't proposed-and-confirmed yet, do that first). **Don't
worry about the timezone** — you
don't compute or set it. `loopany new` (next step) auto-detects this machine's IANA
zone and pins it for you, so "8am" means the user's 8am, not the server's UTC.
(Override only if the user states a different zone: pass `--tz <IANA>` below.)

Write the config to **`loopany/<slug>/loop.tmp.json`** (next to the task file) —
only the loop's real intent goes in it; the CLI fills the fixed envelope. It's a
**throwaway creation payload**, not the live loop: once `loopany new` POSTs it the
server owns the schedule/envelope and only the task file syncs back, so the
`.tmp.json` name flags that it goes stale and is safe to delete after creation
(later changes go through `loopany edit` + the task file, never this file — see
`update.md`):

```json
{
  "name": "short human name",
  "cron": "m h dom mon dow",
  "workflow": "<JS function body>",
  "task": "<SHORT trigger — read + run the task file, then the notify rule>",
  "workdir": "<absolute project dir>",
  "taskFile": "<absolute path to the task file above>",
  "stateSchema": [{ "key": "x", "label": "X", "unit": "" }],
  "notify": "auto",
  "summary": "one short sentence describing what this loop does"
}
```

Rules:
- Include **either** `workflow` **or** `task` (or both, if the workflow escalates).
- Always set `workdir` and `taskFile`. Put the real instructions in the **task
  file**; keep `task` a short pointer to it (avoid duplicating content).
- Make the `workflow` self-contained and defensive (handle fetch failures).
- `stateSchema` is optional — declare numeric per-run metrics to get a chart.
- `notify`: `auto` (only when there's something to say) | `always` | `never`.
- **Don't add `timezone`, `claim`, or any auth** — `loopany new` injects the
  timezone, the connect-key claim, and this machine's device token for you.

## 3 · Create the loop

One command creates it from the config file — pass the connect-key so the web
dialog learns the loop was created:

```bash
<loopany-cli> new \
  --config loopany/<slug>/loop.tmp.json \
  --connect-key <connect-key> \
  --agent <agent>          # which coding agent you are (claude-code | codex); omit to auto-detect
```

`loopany new` detects the IANA timezone, injects the claim, **records the coding
agent** (the `--agent` you pass, or — preferred — the host it sniffs from its own
env), authenticates as this machine, validates the config, and POSTs it. On success
it prints `created loop <name> — <cron> <timezone>`; the loop now appears in the
LoopAny web UI and runs on schedule. Tell the user it's created (name + cadence) —
the `loop.tmp.json` has served its purpose and can be deleted. If it prints
`loopany: <error>`, fix `loop.tmp.json` and re-run.

Finally, let the user know what happens next: this loop will run automatically for
the first time shortly, so head to the LoopAny web UI to watch for the first result.
