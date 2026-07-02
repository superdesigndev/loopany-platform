# LoopAny — first capture: connect this machine, then build a loop

You're reading this because the user pasted a LoopAny capture snippet (`Fetch
<server-url>/api/bootstrap and help me build a loop.`) into your session. LoopAny
turns a task into a **scheduled agent loop** that runs automatically on this machine.
Their LoopAny web tab is open and waiting for the loop to appear, so work end to end
and keep questions to quick check-ins — don't run a full interview.

This is the **bootstrap** doc, served over HTTP on first contact before the loopany
skill is installed on disk. Do the two situational things below, then hand off to the
create reference, which owns everything from "what should this loop be?" onward.
(Once you run `loopany new`, the skill installs into the loop's workdir at
`<workdir>/.claude/skills/loopany/`, so a later session in that folder auto-triggers
the installed skill and reads the same references from disk.)

## The pasted values

The user pasted these along with the capture link — use them verbatim:

- **server-url** — the LoopAny server base URL (e.g. `http://localhost:3000`).
- **connect-key** — a one-time token (starts with `dk_`). It both authorizes a NEW
  machine and tags the loop back to the web dialog (its `claim`).
- **loopany-cli** *(optional)* — the command that runs the loopany CLI, used as the
  prefix for every `loopany` invocation. **If it's not pasted, use
  `npx @crewlet/loopany@latest`.** (A dev server may paste a local command instead.)

## 1 · Connect this machine

One idempotent command does the whole thing — run it verbatim (substitute
**loopany-cli**, defaulting to `npx @crewlet/loopany@latest`):

```bash
<loopany-cli> up --server-url <server-url> --connect-key <connect-key>
```

`loopany up` resolves this machine's stable identity (reuses the stored device
token, else adopts the connect-key), checks whether a daemon is already live, starts
a single detached one if not — surviving this session — and waits until the server
reports the machine online. It never starts a second daemon, and it only stands up
the daemon: it does **not** install any skill (it may be run from anywhere, e.g. your
home dir, purely to start the daemon).

It exits `0` once connected (printing `daemon online …` or `daemon already running …`);
then continue. If it can't come online, it says where the log is. **Declare which
coding agent you are** by passing `--agent claude-code` (or `--agent codex`) on
`loopany new` later — LoopAny also sniffs its own env to confirm the host, so this is
an honest fallback, not load-bearing.

## 2 · Build the loop

With the machine connected, fetch and follow the **create** reference end to end. On
first capture the skill isn't on disk yet, so fetch it over HTTP from the
**server-url** the user pasted:

```
<server-url>/api/skill/references/create.md
```

Follow it from its §0: it decides *what* loop to build (turning the task already in
this session into a loop, or — if the session is empty — brainstorming loops for
this project and letting the user pick), settles the cadence and per-run output,
authors the loop's task file and config, and runs `loopany new`. Pass the
**connect-key** as `--connect-key` so the created loop resolves back to the web
dialog. create.md carries the flow through to telling the user it's live — you don't
need to add anything here.

## Editing and evolving, later

Those flows normally run from the installed skill, but you can fetch them over HTTP
the same way if needed:

- **Editing an existing loop** (reschedule, rename, pause, set/clear a goal, or
  change what it does): `<server-url>/api/skill/references/update.md`.
- **How a loop refines itself over time** — the evolution pass that improves the loop
  from its own run history: `<server-url>/api/skill/references/evolve.md`.
