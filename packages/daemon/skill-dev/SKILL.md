---
name: loopany-dev
description: "Drive a managed LOCAL Loopany convergence stack: inspect and edit production loops, work event-sourced tasks/docs/mirrors, answer the human inbox, and test run delivery. Use only through the on-PATH loopany-dev command; never use it for the production Loopany service or to operate the dev stack lifecycle."
---

# Loopany converged dev flow

Use `loopany-dev` to work against the managed local convergence stack. Production
`loops` rows are the only live loop objects; event-sourced kernel objects remain
for tasks, docs and mirrors. Their events attach to production loop ids directly.

## The stack is MANAGED — read this first

The operator already chose the port, data directory, home and daemon. Start with
bare `loopany-dev` to confirm the target and read the production loop roster.

Always:

- Invoke the on-PATH `loopany-dev` command. Examples below shorten it to
  `loopany`; type `loopany-dev` on this stack.
- If the stack is unreachable, wait about 30s, retry once, then stop and
  tell the human.

Never:

- Never use bare `loopany`; it targets the real production service.
- Never source `scripts/rewrite-local-run.env.sh` or set
  `LOOPANY_SERVER_URL`, `LOOPANY_HOME`, `LOOPANY_DATA_DIR`, a port, or
  `LOOPANY_RUNS_V2` yourself.
- Never start a server or daemon. Never stop, restart, seed, migrate or otherwise
  operate them. The stack lifecycle belongs to its operator.

## The converged model

- A **loop** is a production loop: machine-bound, scheduled by the production
  scheduler, delivered through `/api/machine/poll`, and reported through the
  production run-token pipeline. Its standing brief lives in its task file's
  `## Spec`.
- A **task** is event-sourced work with an always-present `watcher`, an optional
  `follow_up` that wakes that production loop, and an optional human question.
- A **doc** is an authored product, addressed by id and rewritten in place.
- A **mirror** is a stateless pointer to an external PR, issue or URL. It says
  where to look, never what state the external thing is in.

Kernel loop objects remain only as same-id history anchors until cleanup. Every
`loop *` kernel command is therefore a local teaching refusal that points to the
production equivalent; it must never mutate the kernel twin.

## Commands

Use the production owner surface for loops:

```sh
loopany loops
loopany show <loop-id>
loopany new --json '<config>'
loopany edit <loop-id> --json '<patch>'
```

Use the workspace surface for attached work:

```sh
loopany task list --watcher <loop-id> --due
loopany task show <task-id>
loopany task create --file <path>
loopany task update <task-id> --follow-up +3d
loopany task close <task-id> --note "verified and settled"
loopany doc show|create|update …
loopany mirror attach|detach|list|show|update …
loopany inbox
loopany answer <task-id> "…"
loopany task tell <task-id> "…"
```

Every workspace verb answers `--help` locally. Read teaching refusals and retry
the named legal move once; do not route around them.

For details, read only the reference relevant to the work:

- [references/loops.md](references/loops.md) — production loop/task-file,
  schedule, pause and manual-run semantics.
- [references/work.md](references/work.md) — task, doc, mirror, inbox and run
  discipline.

## Run discipline

Treat a scoped trigger's task payload and directive/answer text as verbatim
execution input. Check external mirrors rather than trusting stored state. Update
the task after acting on reality. Nothing found is a clean result.

A paused loop's due tasks stand down until it is re-enabled. Manual **Run now**
still fires once through the production pipeline and leaves the loop paused.

## Never production

This skill targets a local managed development stack only. `scripts/loopany-dev`
rejects non-loopback servers. Bare `loopany-dev` is a read: it shows the
production roster, inbox count and recent runs without changing lifecycle state.
