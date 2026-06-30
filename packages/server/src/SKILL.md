---
name: loopany-build-loop
description: Turn a task you just completed in this coding-agent session into a scheduled LoopAny loop — write its task file, register this machine, and create the loop via the API.
---

# LoopAny — build a loop from what we just did

You just helped the user accomplish a task they want to run **automatically on a
schedule**. Turn it into a LoopAny *loop*. The user's LoopAny web tab is open and
waiting for the loop to appear — so just do the steps below end to end; don't ask
follow-up questions.

The user pasted these values along with this link — use them verbatim:

- **server-url** — the LoopAny server base URL (e.g. `http://localhost:3000`)
- **connect-key** — a one-time token (starts with `dk_`). It both authorizes a NEW
  machine and tags the loop back to the web dialog (its `claim`).
- **loopany-cli** *(optional)* — the command that runs the loopany CLI, used as the
  prefix for every `loopany` invocation below. **If it's not pasted, use
  `npx @crewlet/loopany@latest`.** (A dev server may paste a local command instead.)
- **agent** *(optional)* — the coding agent this loop should be recorded against
  (`claude-code` or `codex`). If a value is pasted, use it; otherwise **declare
  yourself** — tell LoopAny which agent you are by passing `--agent <you>` to
  `loopany new` in step 4 (e.g. `--agent claude-code` if you are Claude Code,
  `--agent codex` if you are Codex). LoopAny also sniffs its own env to confirm the
  host, so this is just a fallback; recording it is honest, not load-bearing.

## 1 · Make sure a daemon is running for THIS machine

One idempotent command does the whole thing — run it verbatim (substitute
**loopany-cli**, defaulting to `npx @crewlet/loopany@latest`):

```bash
<loopany-cli> up --server-url <server-url> --connect-key <connect-key>
```

`loopany up` resolves this machine's stable identity (reuses the stored device
token, else adopts the connect-key), checks whether a daemon is already live,
starts a single detached one if not — surviving this Claude Code session — and
waits until the server reports the machine online. It never starts a second
daemon. It exits `0` once connected (printing `daemon online …` or `daemon
already running …`); then continue to step 2. If it can't come online, it says
where the log is.

## 2 · Create the loop's folder and task file

Every loop gets its **own folder** under the project: `<project>/loopany/<slug>/`
(make it if needed; pick a short `<slug>` from the loop name). That folder is the
loop's home — its task file lives there, and by default every artifact the loop
produces (reports, exports, generated files, scratch) lands there too, so each
loop's output stays self-contained and out of the project's way.

Inside it, write the **task file** at `<project>/loopany/<slug>/README.md`: a markdown
doc that is the loop's durable brief and running memory. Each scheduled run reads it
for context and maintains it, so the loop stays coherent over time. Fill it from
what we ACTUALLY just did — real URLs, paths, commands, thresholds:

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

## 3 · Author the loop config

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
in step 2, keep `task` SHORT — don't restate the steps/filters/queries there.
`task` is just the trigger: point the agent at the task file and state the notify
behavior. For example:

> "Read the task file `loopany/<slug>/README.md` (and any docs it links) and run it
> for today. Append a Timeline entry when done. Per its Spec, message the user only
> when warranted; otherwise return nothing."

Pick a sensible 5-field `cron` cadence. **Don't worry about the timezone** — you
don't compute or set it. `loopany new` (step 4) auto-detects this machine's IANA
zone and pins it for you, so "8am" means the user's 8am, not the server's UTC.
(Override only if the user states a different zone: pass `--tz <IANA>` in step 4.)

Write the config to **`loopany/<slug>/loop.tmp.json`** (next to the task file) —
only the loop's real intent goes in it; the CLI fills the fixed envelope. It's a
**throwaway creation payload**, not the live loop: once `loopany new` POSTs it the
server owns the schedule/envelope and only the task file syncs back, so the
`.tmp.json` name flags that it goes stale and is safe to delete after step 4
(later changes go through `loopany edit` + the task file, never this file):

```json
{
  "name": "short human name",
  "cron": "m h dom mon dow",
  "workflow": "<JS function body>",
  "task": "<SHORT trigger — read + run the task file, then the notify rule>",
  "workdir": "<absolute project dir>",
  "taskFile": "<absolute path to the task file from step 2>",
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

## 4 · Create the loop

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
env), authenticates as this machine, validates the config, and POSTs it. On success it prints `created loop
<name> — <cron> <timezone>`; the loop now appears in the LoopAny web UI and runs
on schedule. Tell the user it's created (name + cadence) — the `loop.tmp.json` has
served its purpose and can be deleted. If it prints `loopany: <error>`, fix
`loop.tmp.json` and re-run.

## 5 · Edit an existing loop

The loop lives in two places, and you edit each where it lives:

- **Schedule / delivery envelope** (cadence, name, timezone, notify, model, pause)
  — the server owns it. Use the same **loopany-cli** prefix as above; it reuses
  this machine's persisted device token, so no `--server-url`/`--connect-key` or
  other auth is needed.
- **What the loop does** (its instructions, context, log) — that's the loop's
  **task file (`loopany/<slug>/README.md`) on this machine**. Just edit that file
  directly in the repo. It syncs back to the server on the loop's next run; nothing
  else to do.

First find the loop id (only loops bound to THIS machine are listed):

```bash
<loopany-cli> loops
# -> loop-xxxx  on      0 8 * * *  Asia/Shanghai  Cookie Daily Breakfast Report
#    loop-yyyy  paused  0 * * * *                 Hourly metrics
```

Then change the envelope (pass only what changes):

```bash
<loopany-cli> edit <loop-id> --cron "0 9 * * *"      # reschedule (5-field cron)
<loopany-cli> edit <loop-id> --name "New name" --notify always
<loopany-cli> edit <loop-id> --pause                 # or --resume
<loopany-cli> edit <loop-id> --run-at 2h             # one extra run in 2h, then resume cadence
```

It prints `updated <name> — <fields>` on success, or `loopany: <error>` to fix.
You can only edit loops bound to this machine; if `<loopany-cli> loops` doesn't
list it, the user is on a different machine than the one running the loop.

> Pausing, deleting, or running a loop now are also one-click in the LoopAny web
> dashboard — point the user there for those rather than the CLI if they prefer.
