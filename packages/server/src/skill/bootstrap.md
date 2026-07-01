# LoopAny — first capture: connect this machine and build a loop

You're reading this because the user pasted a LoopAny capture snippet (`Fetch
<server-url>/api/skill and help me build a loop.`) into your session. LoopAny turns
a task into a **scheduled agent loop** that runs automatically on this machine. Your
job now: connect this machine, decide *what* loop to build, then build it — end to
end. The user's LoopAny web tab is open and waiting for the loop to appear, so keep
questions to quick check-ins; don't run a full interview.

This is the **bootstrap** doc, served over HTTP on first contact before the loopany
skill is installed on disk. Follow it top to bottom. (Once you run `loopany new`, the
skill installs into the loop's workdir at `<workdir>/.claude/skills/loopany/`, so a
later session working in that loop's folder auto-triggers the installed skill instead
— it reads the same references from disk.)

## The pasted values

The user pasted these along with the capture link — use them verbatim:

- **server-url** — the LoopAny server base URL (e.g. `http://localhost:3000`).
- **connect-key** — a one-time token (starts with `dk_`). It both authorizes a NEW
  machine and tags the loop back to the web dialog (its `claim`).
- **loopany-cli** *(optional)* — the command that runs the loopany CLI, used as the
  prefix for every `loopany` invocation. **If it's not pasted, use
  `npx @crewlet/loopany@latest`.** (A dev server may paste a local command instead.)
- **agent** *(optional)* — the coding agent this loop should be recorded against
  (`claude-code` or `codex`). If a value is pasted, use it; otherwise **declare
  yourself** via `--agent <you>` on `loopany new` (e.g. `--agent claude-code`).
  LoopAny also sniffs its own env to confirm the host, so this is a fallback;
  recording it is honest, not load-bearing.

## 1 · Connect this machine

One idempotent command does the whole thing — run it verbatim (substitute
**loopany-cli**, defaulting to `npx @crewlet/loopany@latest`):

```bash
<loopany-cli> up --server-url <server-url> --connect-key <connect-key>
```

`loopany up` resolves this machine's stable identity (reuses the stored device
token, else adopts the connect-key), checks whether a daemon is already live,
starts a single detached one if not — surviving this session — and waits until the
server reports the machine online. It never starts a second daemon, and it only
stands up the daemon — it does **not** install any skill (it may be run from
anywhere, e.g. your home dir, purely to start the daemon).

It exits `0` once connected (printing `daemon online …` or `daemon already
running …`); then continue. If it can't come online, it says where the log is.

## 2 · Decide what loop to build

Before authoring anything, read the session you're in and pick the right starting
point:

- **The user already did a clear task in this session** (the common case — they just
  finished something and want it to keep happening on a schedule). Turn **that task**
  into the loop: recap what it did in one line, and build the loop around it using the
  real URLs, paths, commands, and thresholds from what you just did together.
- **There's no task yet** (the session is essentially empty — the user pasted the
  onboarding prompt and nothing else). **Do not invent a loop from thin air.** Look at
  **what this project actually is** (its README, its code, its purpose) and brainstorm
  **a few concrete loops that would be useful FOR THIS project**, then let the user
  pick one. Make the options specific to what you see, e.g.:
  - "Each morning, summarize new commits/issues in this repo and flag anything risky."
  - "Every hour, run the health check against <the service this project deploys> and
    alert only when it's down."
  - "Daily, check <the upstream dep / API this project relies on> for breaking changes
    and open a note when something moved."

Only continue once there's a real intent — either the task already in this session,
or the loop the user picked from your brainstorm.

## 3 · Build the loop

With the machine connected and the intent settled, fetch and follow the **create**
reference end to end. On first capture the skill isn't on disk yet, so fetch it over
HTTP from the **server-url** the user pasted:

```
<server-url>/api/skill/references/create.md
```

Follow it to create the loop's folder and task file, author the throwaway config, and
run `loopany new`. It covers the two remaining quick check-ins — confirming there's a
real task (§0) and proposing-then-confirming the cadence and per-run output when the
user left them loose (§0.5) — so you never silently guess. Pass the **connect-key**
as `--connect-key` so the created loop resolves back to the web dialog.

When `loopany new` succeeds, tell the user it's created (name + cadence) and point
them at the LoopAny web tab to watch for the first run.

## Editing and evolving, later

Those flows normally run from the installed skill (`references/update.md`,
`references/evolve.md`), but you can fetch them over HTTP the same way if needed
(`<server-url>/api/skill/references/update.md`, `.../evolve.md`):

- **Editing an existing loop** (reschedule, rename, pause, or change what it does):
  `references/update.md`.
- **How a loop refines itself over time** — the evolution pass that improves the loop
  from its own run history (sharpening its **task** and **workflow** ahead of fitting
  its dashboard to the data its runs produce): `references/evolve.md`.
