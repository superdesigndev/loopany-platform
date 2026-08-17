# loopany-kernel-live Guide

The shared Kernel task environment for the team: **the server owns state and time, while execution happens on each person's own machine**. You create a Task or Loop on the server and assign it to an agent on a machine. The daemon on that machine claims the work, starts a real coding-agent session, and writes the result back to the server. Everyone sees the same Task tree.

- Server: `https://loopany-kernel-live.fly.dev` (real clock, cron sweep every 30 seconds, persistent data)
- Model: Task (one-off work or approval), Loop (cron recurrence), Run (one execution), and a fully auditable event stream
- Execution: BYOA - assign work to `<machine-alias>/<agent>` and the real agent runs on that machine
- Connection requires **device-code login plus workspace membership**. Self-issued tokens can no longer register a machine

> **Trust boundary:** the login gate is active, but a workspace is **fully shared**. Every member can see each other's Task bodies, notes, event streams, and artifacts, and can assign work to your machine. **Do not put secrets, private-network information, or personal data in Task bodies, notes, or artifacts.**

---

## 1. Prerequisites

- Node.js 20 or newer
- At least one installed and authenticated coding agent. The `claude`, `codex`, or `grok` command must be available. The daemon detects supported agents on `PATH` and reports them as assignable agents to the server
- A checkout of this repository on the `fm/kernel-cli` branch

## 2. Install once

```bash
git clone git@github.com:superdesigndev/loopany-platform.git && cd loopany-platform
git checkout fm/kernel-cli
bash scripts/install-daemon.sh     # Install the global Loopany daemon used by production
bash scripts/install-kernel-cli.sh # Internal testing: point lk / lk-runtime at this checkout
```

The second script installs three executables:

| Command | Purpose |
|---|---|
| `lk` (a symlink to `loopany-kernel`) | The Kernel CLI used for everyday work |
| `lk-runtime` | The **daemon half** of kernel-live. Use it for `up`, `status`, and `down` |
| `loopany` | Installed by the first script. It belongs to the production environment and is **not used by this guide** |

During internal testing, `lk` reads directly from the current checkout. Switching branches or editing source changes its behavior immediately, without reinstalling it.

### Why `lk-runtime` exists

The Kernel CLI and daemon intentionally **share one credential directory** containing the server URL, machine key, pid, and logs. Two details must therefore remain fixed. The installer bakes both into the wrapper, so you do not need to export them in every shell:

1. **An isolated home:** `lk` and `lk-runtime` use `~/.loopany-kernel-live` by default and never touch production's `~/.loopany`. Without this isolation, one `lk setup` could overwrite the production server URL and machine key, redirecting the production daemon to the wrong environment.
2. **A runtime from this checkout:** `lk setup` needs a runtime binary to register the machine. It first looks for `cli.js` next to the launcher in the published layout. A source installation does not have that file, so it would otherwise fall back to a bare `loopany` on `PATH`. That binary may come from an older checkout which knows neither `--runtime-only` nor `mk_` registration, leaving setup stuck at `starting daemon...` with repeated 401 responses.

Both defaults use the `${VAR:-default}` form, so an explicitly set environment variable still takes precedence.

## 3. Connect this machine

Run one command:

```bash
lk setup /<workspace> --server https://loopany-kernel-live.fly.dev
```

It performs four operations: device-code login, machine registration, daemon startup, and workspace binding.

```text
Open https://loopany-kernel-live.fly.dev/device?user_code=XXXXXXXX
Code: XXXXXXXX
Waiting for approval...
starting daemon...
daemon online - this machine is connected (Your-Machine)
Ready
Signed in as you@superdesign.dev
Machine: Your-Machine
Workspace: /<workspace>
Daemon: running
```

- Open the displayed URL in a browser and approve the device code. The command continues automatically.
- `--server` is needed only the first time. Later, `lk setup /another-workspace` reuses the existing session. Switching servers clears the old session and requires a new login.
- A non-member receives `you are not a member of /<workspace>`. Ask an administrator to add you instead of retrying with another name.
- If the server already has a machine with the **same hostname**, setup asks `Reclaim it? [y/N]`. Choose `y` to take over the existing identity or `n` to create a new machine. Non-interactive scripts and CI must pass either `--reclaim` or `--new` explicitly.

The `mk_`-prefixed machine key is exchanged through your authenticated session and stored in `~/.loopany-kernel-live/machine.json` with mode 0600. **It grants complete control of this machine.** Never commit it or paste it into a conversation. The daemon no longer accepts legacy self-issued `dk_` tokens.

### Machine aliases

The alias is the routing address for Tasks - the first half of `<alias>/claude`. By default it is the **short hostname** (`mbp.local` becomes `mbp`). To customize it, set `LOOPANY_MACHINE_ALIAS` in the daemon environment. Every poll reports the alias:

```bash
LOOPANY_MACHINE_ALIAS=tim-mbp lk-runtime up
```

Aliases are unique **within a workspace**. If an alias is already taken during registration, the server appends a machine-ID fragment (`mbp` becomes `mbp-3f9a2c`). Registration succeeds, but the resulting address is harder to remember. **Choose an alias once and do not change it.** Assignment routing depends on it. `lk team` always shows the current canonical address, so treat that output as authoritative.

### Manage the kernel-live daemon

Always use `lk-runtime`. Its isolated home ensures that it cannot affect production:

```bash
lk-runtime status   # Whether the daemon is running and which server it uses
lk-runtime up       # Idempotent: start it in the background or confirm it is running
lk-runtime down     # Stop only the kernel-live daemon
```

Continue to use bare `loopany status` and `loopany down` for production. The two daemons can run simultaneously because they use different homes and pidfiles. Their logs also live in their respective homes:

```bash
tail -f ~/.loopany-kernel-live/daemon.log
```

The daemon must remain running to claim pending Runs assigned to this machine and start their agents. The server mints Runs but never executes an agent. Runs remain queued while the daemon is stopped and are not lost when a laptop sleeps.

## 4. Confirm identity and workspace

```bash
lk me      # The signed-in person and selected team
lk team    # People (person:<id>) and executable agent addresses in the workspace
lk logout  # Revoke only the CLI session; machine registration remains active
```

The Agents section of `lk team` is the authoritative list of addresses accepted by `--assignee`:

```text
Agents
  tim-mbp/claude     available  last-success 2026-08-14T01:30:15.655Z
  tim-mbp/codex      available
  alice-mba/claude   available
```

CLI resolution order is: environment variables, the current directory's `.loopany` workspace, then the current home's remote binding. Add `--remote` when you are inside a local workspace but want to force access to kernel-live.

## 5. Everyday use

```bash
# Create one-off work and assign it to an agent on your machine
lk create "Research option X" --id research-x --assignee tim-mbp/claude \
  --workdir /Users/tim/Workspace/proj --body-file brief.md

# Create a recurring Loop that runs every day at 07:00
lk create "Daily release radar" --id release-radar --cron "0 7 * * *" --timezone Asia/Shanghai \
  --status in-progress --assignee tim-mbp/claude --body-file radar-brief.md

# Assign work to a teammate's machine by using its alias
lk update research-x assignee=alice-mba/claude

# Hand the decision to a person. An email enters that person's Inbox and starts no agent
lk update research-x assignee=alice@superdesign.dev --note "Please choose one of the two options"

# Run one pass immediately instead of waiting for cron
lk run release-radar

# Observe the system
lk-runtime status    # The daemon must be online or Runs remain pending
lk kanban            # Interactive board: q quits, / searches, f changes columns
lk list              # Task tree
lk show research-x --log   # Full event stream for one Task
lk timeline          # Recent team activity
lk inbox --assignee alice@superdesign.dev   # A person's decision Inbox, with hand-back commands
lk loops             # Every Loop: next trigger, last result, and blocking reason
```

Important details:

- **A Task body is the agent's brief.** Use `--body-file` and state the work, boundaries, and completion criteria clearly.
- `--workdir` must be an **absolute path that exists on the target machine**. A missing path fails loudly.
- Creating a Task assigned to an agent dispatches it once. A Loop follows its cron schedule. Assigning to a person only places it in their Inbox.
- A misspelled machine alias or agent name does not fail the write. The Run remains pending and the Task receives a `dispatch blocked` note listing every available address in the workspace. Correct the assignee using that list.
- A silent agent exit is not success. The server converts `done` without any agent event into `failed`; the protocol requires at least one honest note per pass. Repeated failures park the work instead of retrying forever and wasting quota.
- The coding-agent account on the executing machine pays for the Run.

### Optional deterministic Workflow pre-stage

A Task can install a versioned deterministic pre-stage. The only current format is `loopany-js-v1`. The script is an async function body with direct access to `prev`, `agent(message, data)`, `tools.call(name, args)`, and `fetch`. A pass can complete silently or directly when it does not call `agent()`. Calling `agent()` injects the signal into the same Run's CORE prompt before starting the Task's assignee agent. If the script fails, the Run falls back to the agent with diagnostic context.

```bash
lk workflow validate --file workflow.js
lk workflow set release-radar --file workflow.js --if-version 1
lk workflow show release-radar
lk workflow clear release-radar --if-version 2
```

A successful Workflow's returned `state` is stored on the Run and becomes `prev` on the next pass. Workflow is optional Task execution configuration, not a separate entity. `set` and `clear` use normal Task-update team permissions, compare-and-swap protection, and audit events.

The complete Workflow has a default 180-second timeout, configurable through the daemon's `LOOPANY_WORKFLOW_TIMEOUT_SECONDS`. Each `tools.call` still has a default 30-second timeout.

## 6. Troubleshooting

| Symptom | What to check |
|---|---|
| Stuck at `starting daemon...` | Confirm that you used `lk` instead of a hand-written wrapper. `lk setup` must resolve the runtime from this checkout. Falling back to another `loopany` on `PATH` causes repeated 401 responses. Check `~/.loopany-kernel-live/daemon.log` for `poll non-ok status: 401`. |
| `you are not a member of /x` | The workspace name is wrong or you are not a member. Ask an administrator instead of retrying with another name. |
| `lk` reports `not logged in` | The session expired. Run `lk setup /<workspace>` again, or `lk login <server>`, and approve the new device code. |
| A Task remains pending | Check that the daemon is online with `lk-runtime status`, then inspect the blocked note with `lk show <id> --log` for a wrong alias, missing agent, or offline machine. |
| The agent does not start | Confirm that the target machine has an authenticated `claude`, `codex`, or `grok` command, then inspect `~/.loopany-kernel-live/daemon.log`. |
| A Run becomes failed | The agent exited silently without writing an event. Improve the completion requirement in the Task body. |
| Production points at the wrong environment | `env | grep LOOPANY_HOME` should be empty. Use bare `loopany` for production and `lk` or `lk-runtime` for kernel-live. Do not mix them. |
| Need server logs | Run `fly logs -a loopany-kernel-live` with Fly access. |
