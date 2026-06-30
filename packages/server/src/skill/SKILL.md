---
name: loopany
description: Create, update, and evolve scheduled LoopAny agent loops from a coding session. Use when the user wants to turn a task they just did into a recurring/scheduled loop, edit an existing loop's schedule or instructions, or pastes a LoopAny capture snippet ("Fetch .../api/skill and help me build a loop.").
---

# LoopAny — build and maintain scheduled loops

You just helped the user accomplish something they want to run **automatically on a
schedule**. Turn it into a LoopAny *loop*. The user's LoopAny web tab is open and
waiting for the loop to appear — so work end to end; don't ask follow-up questions.
(The one exception: if the session is essentially empty and there's no real task to
loop yet, ask what to build rather than inventing one — see `references/create.md` §0.)

This skill routes to focused references — read the one for the job:

- **Creating a loop** (the common case — you just did a task and want it scheduled):
  do **step 1 below first** (it connects this machine), then follow
  **`references/create.md`**.
- **Editing an existing loop** (reschedule, rename, pause, or change what it does):
  **`references/update.md`**.
- **How a loop stays coherent and improves over time** (the task-file-as-running-memory
  model): **`references/evolve.md`**.

> **Where to read the references.** On first capture this skill usually isn't on
> disk yet, so fetch the references over HTTP from the **server-url** the user
> pasted, e.g. `<server-url>/api/skill/references/create.md`. (Once you run
> `loopany new`, the skill is installed into that loop's workdir at
> `<workdir>/.claude/skills/loopany/`, so a later session working in that loop's
> folder finds the reference files on disk.)

The user pasted these values along with the capture link — use them verbatim:

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

> The loopany skill installs itself at **loop creation**: `loopany new` (step 2)
> best-effort installs it into the new loop's **workdir** (`<workdir>/.claude/skills/loopany/`,
> via `npx skills`) so it's discoverable there, printing one status line and never
> failing the create. To install it by hand anywhere, run `<loopany-cli> skill
> install` (`-g` for `~/.claude`).

## 2 · Build the loop

With the machine connected, follow **`references/create.md`** end to end: create the
loop's folder and task file, author the throwaway config, and run `loopany new`. Then
tell the user it's created (name + cadence).

To edit a loop later, see **`references/update.md`**. For how each scheduled run reads
and maintains its task file, see **`references/evolve.md`**.
