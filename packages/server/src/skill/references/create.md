# Create a loop

You've already connected this machine with `loopany up` (see the skill overview,
step 1). Now author the loop and create it. Use the **loopany-cli** prefix the user
pasted (default `npx @crewlet/loopany@latest`) and the **connect-key** from the
capture snippet.

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

Pick a sensible 5-field `cron` cadence. **Don't worry about the timezone** — you
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
