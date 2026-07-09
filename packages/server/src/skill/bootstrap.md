# adScaile — first capture: connect this machine, then build a loop

You're reading this because the user pasted a adScaile capture snippet (`Fetch
<server-url>/api/bootstrap and help me build a loop.`) into your session. adScaile
turns a task into a **scheduled agent loop** that runs automatically on this machine.
Their adScaile web tab is open and waiting for the loop to appear, so work end to end
and keep questions to quick check-ins — don't run a full interview.

This bootstrap doc is served over HTTP on first contact, before the adscaile skill is
installed on disk. Do the two steps below, then hand off to the create reference,
which owns everything from "what should this loop be?" onward. (`adscaile up`
installs the skill at USER scope for each coding agent adscaile knows about (Claude
Code `~/.claude/skills/adscaile/`, Codex `~/.agents/skills/adscaile/`) and `adscaile
new` refreshes it, so a later session in ANY folder on this machine auto-triggers the
installed skill and reads the same references from disk.)

## The pasted values

The user pasted these along with the capture link — use them verbatim:

- **server-url** — the adScaile server base URL (e.g. `http://localhost:3000`).
- **connect-key** — a one-time token (starts with `dk_`). It both authorizes a NEW
  machine and tags the loop back to the web dialog (its `claim`).
- **adscaile-cli** *(optional)* — the command prefix for every `adscaile` invocation.
  **If it's not pasted, use `npx @crewlet/adscaile@latest`.** (A dev server may paste
  a local command instead.)

The paste may also carry a short **task description** below those values — the user
started from a template card on the dashboard. That description is the loop to build;
the create reference (step 2) treats it as the intent.

## 1 · Connect this machine

One idempotent command does the whole thing — run it verbatim (substitute
**adscaile-cli**):

```bash
<adscaile-cli> up --server-url <server-url> --connect-key <connect-key>
```

`adscaile up` resolves this machine's stable identity (reuses the stored device
token, else adopts the connect-key), starts a single detached daemon if none is live
— it survives this session and never doubles up — and waits until the server reports
the machine online. Once connected it also best-effort refreshes the adscaile skill
at USER scope for each coding agent adscaile knows about (Claude Code
`~/.claude/skills/adscaile/`, Codex `~/.agents/skills/adscaile/`), announced in one
line, never blocking.

It exits `0` once connected (printing `daemon online …` or `daemon already running
…`); then continue. If it can't come online, it says where the log is.

## 2 · Build the loop

With the machine connected, fetch and follow the **create** reference end to end.
The skill isn't on disk yet, so fetch it over HTTP from the **server-url**:

```
<server-url>/api/skill/references/create.md
```

Follow it from its §1: it decides *what* loop to build (the task already in this
session, or — if the session is empty — brainstorming loops for this project and
letting the user pick), settles the cadence and per-run output, authors the loop's
task file and config, and runs `adscaile new`. Pass the **connect-key** as
`--connect-key` so the created loop resolves back to the web dialog, and declare
which coding agent you are with `--agent claude-code` (or `--agent codex` / `--agent grok`).
create.md carries the flow through to telling the user it's live — you don't need
to add anything here.

## Editing and evolving, later

Those flows normally run from the installed skill, but you can fetch them over HTTP
the same way if needed:

- **Editing an existing loop** (reschedule, rename, pause, set/clear a goal, or
  change what it does): `<server-url>/api/skill/references/update.md`.
- **How a loop refines itself over time** — the evolution pass that improves the
  loop from its own run history: `<server-url>/api/skill/references/evolve.md`.
