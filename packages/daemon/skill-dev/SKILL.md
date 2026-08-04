---
name: loopany-dev
description: Drive the Loopany REWRITE (kernel) stack from a coding session — create and evolve loops, work tasks and docs, answer the human inbox, and fire a loop off its cadence. Use when working against a LOCAL Loopany dev stack (LOOPANY_RUNS_V2=1) with the `loopany loop|task|doc|inbox|answer` verbs. Not for production loops — the shipping product has its own `loopany` skill.
---

# Loopany rewrite (kernel) — the dev flow

This skill drives the **rewrite** of Loopany: an event-sourced kernel where every
loop, task and doc is an **object**, and every change to one is an **event** on
its timeline. It is a different surface from the shipping product, with different
verbs and a different artifact format.

**It targets a LOCAL dev stack, never production.** Read [Never
production](#never-production) before you run anything.

## The stack is MANAGED — read this first

The dev stack your session talks to is **operated for you**. It is already
running, on a port and a data directory an operator chose. Your entire surface on
it is the `loopany-dev` command that is on your PATH.

**Always:**

- Invoke the on-PATH `loopany-dev` command, and nothing else. It already carries
  the stack's server URL, home and data directory. Start with a bare
  `loopany-dev` to see where you are.

**Never:**

- Never `source scripts/rewrite-local-run.env.sh` (or any other env script). It
  stands up a *different*, isolated stack; objects you create there land in a data
  directory the real environment never reads — they are invisible and lost.
- Never start a server, a daemon, or a dev process. Not `pnpm dev`, not
  `loopany up`, not a background node.
- Never run a seed, migration or fixture script against the stack.
- Never invent, guess or override a port, `LOOPANY_SERVER_URL`, `LOOPANY_HOME`,
  `LOOPANY_DATA_DIR` or `LOOPANY_RW_BASE`. If the CLI does not tell you the port,
  you do not need it.

**Creating an object on any port or stack other than the one the CLI is already
configured for is always wrong**, however plausible the reason looked.

Examples in this skill and its references are written as `loopany <verb>` for
readability; **you type `loopany-dev <verb>`**. Bare `loopany` is the production
binary and never reads your dev stack.

**If the CLI reports the server is down or unreachable:** wait ~30s and retry
**once**. If it is still down, **STOP and tell the human**. A down stack is an
operator matter, not something to fix by standing one up — there is no
self-service recovery here, and every attempt at one has produced orphaned data.

## What the kernel is

Four object kinds, one record:

- **loop** — a standing cadence plus a **charter** (its body: the prompt every run
  receives). A loop is `active`, `paused` or `retired`. It never "completes":
  it is a standing thing, not a unit of work.
- **task** — a unit of work with a lifecycle `open → closed`, plus three facets: a
  `watcher` (the loop that acts next — never empty; yours by default),
  a `follow_up` date (whose arrival WAKES that watcher),
  and a `needs_human` question (which puts it in the human inbox).
- **doc** — a product, addressed by id and rewritten in place, so everything
  citing it follows the rewrite.
- **mirror** — a **pointer** to something outside the system (a PR, an issue, a
  URL), attached to the task/doc/loop that depends on it. **A mirror tells you
  WHERE to look, never WHAT state it is in** — it has no state field, and the
  schema has nowhere to put one, so a mirror can never be stale.

Two properties follow from event-sourcing and drive most of the surface:

- **Nothing is ever deleted.** There is no `loop delete`, no `task delete`, no
  `doc delete`. `loop retire` is the D in CRUD — terminal, the charter freezes,
  the cadence is gone, the whole record stays readable. A task **closes with an
  attestation** (`--note`), and there is no reopen: create a new task instead.
- **Every mutation writes an event with a `{old, new}` diff**, so `loop show` /
  `task show` print an event tail you can read the history from. A no-op writes
  no event and is reported as `changed: false` — retrying after a dropped
  connection is free.

**There is no `self`.** Every command takes an explicit id (`loop-4c1d77`,
`task-7f3a91`, `doc-2b8e04`). Inside a run, your work order names your loop id on
its first line.

## Who is allowed to do what

The split is on **run context**, not on a credential: a request carrying
`X-Loopany-Run` is an *agent's*, anything else is a *human's*. The CLI attaches
that header from the environment the daemon set — you can neither type it nor
forge a different one.

- **Human-only** (refused inside a run): `loop create`, `loop pause|resume|retire`,
  `loop run-now`, `inbox`, `answer`, `task tell`. Creating a loop mints a standing
  cadence and a new actor; pausing, retiring and firing off-cadence are operational
  calls the owner keeps; and `task tell` is a person instructing a loop, so a loop
  instructing itself would be a loop with no cadence at all.
- **Agent-only**: `loop evolve`, `loop update` — a run edits its OWN loop.
- **Both**: `loop list`, `loop show`, and the whole `task` / `doc` / `mirror` family.

A run that wants a human-only thing **proposes** it:

```sh
loopany task create --file proposal.md --needs-human "create a loop that …" --watcher loop-4c1d77
```

## The verbs

Every verb answers `--help` **locally, before any side effect** — no round trip,
safe on a verb that writes. Use it; the tables below are a map, not the grammar.

| Family | Verbs |
| --- | --- |
| loop | `create --file` · `list [--status]` · `show <id> [--file\|--full]` · `evolve <id> --file` · `update <id> --cron --approval` · `pause\|resume\|retire <id> [--note]` · `run-now <id>` |
| task | `list [--open\|--closed] [--due] [--watcher] [--creator] [--since]` · `show <id>` · `create --file` · `update <id>` · `close <id> --note` |
| doc | `show <id> [--file\|--full]` · `create --file` · `update <id> --file` |
| mirror | `attach <object-id> --kind --coords [--note]` · `detach <mirror-id> --from` · `list [--attached-to\|--kind\|--coords-like]` · `kinds` · `show <id>` · `update <id> --note` |
| human | `inbox` · `answer <task-id> "…"` · `task tell <task-id> "…"` |

Depth lives in the two references beside this file:

- **[references/loops.md](references/loops.md)** — the loop artifact format
  (front matter + charter), `workdir`, cadence, the governance gate, and
  **run-now + paused semantics**. Read it before creating or editing a loop.
- **[references/work.md](references/work.md)** — tasks, docs, **mirrors**, the
  inbox, `answer` and `task tell`, and the run's own working rhythm.

Output is TOON on every verb: `ok:` / typed lists / `help[]` on success,
`error:` + `code:` + `wrote:` / `expected:` + `help[]` on a refusal. **Read the
refusal** — it names the legal move, and exit codes are a pure function of the
status: `0` accepted, `1` transport (retry with backoff), `2` refused with
teaching (rewrite and retry once), `3` not found (re-enumerate, never retry the
same id).

## Never production

`loopany` on a developer machine is usually the **production** binary: the PATH
shim points at the installed daemon and `~/.loopany` holds a credential for the
live server. Running kernel verbs there does not read your dev stack.

**Use the on-PATH `loopany-dev` command — never bare `loopany`.** It runs the
rewrite CLI against your managed dev stack, sets `LOOPANY_RUNS_V2=1`, and
**refuses** any `LOOPANY_SERVER_URL` that is not loopback:

```sh
loopany-dev                      # the kernel home: roster, inbox floor, recent runs
loopany-dev loop list
loopany-dev loop show loop-4c1d77
```

That is the whole contract. Do not set `LOOPANY_SERVER_URL`, `LOOPANY_HOME`,
`LOOPANY_DATA_DIR` or a port yourself to "point it at" a stack — the command is
already configured, and a stack you point it at yourself is a stack nobody reads.

(`scripts/loopany-dev` and `scripts/rewrite-local-run.env.sh` in the platform repo
exist for **developing the platform itself** — standing up a throwaway stack to
test the server or the CLI. If you are USING a stack rather than working on the
platform, they are not for you; see the header of each script and
`packages/server/AGENTS.md`, "Real local execution on the rewrite line".)

**Bare `loopany-dev` with no arguments is a read**, and on a runs-v2 stack it
prints the kernel home — the loop roster, the inbox count and the newest runs. It
is the cheapest way to see where you are before doing anything.
