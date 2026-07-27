---
name: loopany
description: Manage the Loopany task tree and its scheduled agent loops from a coding session. Use when the user wants to capture work as a task, turn a task they just did into a recurring/scheduled loop, edit an existing task or loop's schedule or instructions, or asks to build a Loopany loop. Every task is a folder (README + artifacts); a task with cron set runs on autopilot. A task can carry a goal (a finish line) and completes itself when the goal is met.
---

# Loopany — the task tree, with agents on a schedule

Loopany tracks work as a **task tree** and runs the recurring parts automatically
on this machine. Every task is a **folder** — `README.md` (front-matter work-state
+ `## Spec` + `## Current understanding` + `## Timeline`) with its artifacts
beside it. The tree comes from each README's `parent:` field. **A loop is just a
task with `cron` set** — recurrence is a field, not a kind. A task with a **goal**
is closed — each run judges the goal and it finishes itself once met; without one
it's an open monitor.

Work end to end; keep questions to quick check-ins, don't run a full interview.
Two check-ins are right: if the session has no real task to capture yet, ask what
to build rather than inventing one (`references/create.md` §1); and when the user
hasn't specified a recurring task's cadence or per-run output, propose a sensible
default and confirm it before creating (`references/create.md` §2).

The verb grammar (run `loopany --help` or `loopany agent-context` for the full
machine-readable surface):

```
loopany create "<title>" [--cron "0 9 * * *"] …   start a task; --cron makes it a LOOP
loopany get <id> [--runs]                          one task in full + children + config
loopany list [<id>] [--due] [--assignee <who>]     the tree / a filtered worklist —
        [--here] [--team <id>]                     team-wide by default, --here = this machine
loopany search <keywords>                          dedup BEFORE creating (team-wide)
loopany update <id> k=v … [--note "…"]             fields; cron="…" arms a schedule, cron=null stops it
loopany run <id> [--wait]                          dispatch an agent at a task now
```

Reads are team-wide: rows on another device show an `@machine` marker, and a slug
that exists on two machines resolves via `<machine>/<slug>`. Each task has an
optional **assignee**: a person (`assignee: <email>` in the front matter — pure
worklist metadata; `owner:` is a legacy alias) or an **executor**
(`loopany update <id> assignee=<machine>/<agent>`, your own devices only) — the
executor form re-binds the task and auto-dispatches one run when it sits at
`status: todo`.

Three standing rules: **capture after planning** (a goal/strategy/experiment/task
agreed in conversation becomes a node — search first, then create under the right
parent); **update + timeline after progress** (`loopany update … --note "…"` or
edit the README — never let recorded state drift from reality); **tasks are never
deleted** (`status=archived` is the terminal state). `status=follow-up` must carry a
`follow_up_date` — the date to check whether the shipped thing worked.

Working a task in THIS session? The whole lifecycle is two commands:
`loopany update <id> status=in-progress` when you start, then
`loopany update <id> status=done --note "what shipped"` when you finish (or
`status=follow-up follow_up_date=YYYY-MM-DD --note "what to check"`). No
`report` here — that verb belongs to scheduled runs; in a session, the note IS
the record.

Read the reference for the job (they live on disk next to this file, under
`references/`):

- **Creating a task or loop** (the common case — you just did a task and want it
  captured or scheduled): **`references/create.md`**. It decides what to build,
  authors the Spec (with an optional goal + cron), and runs `loopany create`.
- **Editing an existing task/loop** (reschedule, rename, pause, set/clear a goal,
  change status, or change what it does): **`references/update.md`**.
- **How a loop stays coherent and improves over time** (the evolution pass that
  sharpens its **task** and **workflow** from its own run history, then fits its
  dashboard to the data): **`references/evolve.md`**.
- **How a loop behaves each time it runs** (the runtime protocol: the task file as
  memory, surfacing only what changed, the report/finish grammar and finish bar, the
  schedule levers, and front-matter product conventions): **`references/run.md`**.

The machine is already connected — this skill was installed at user scope for each
coding agent loopany knows about (Claude Code `~/.claude/skills/loopany/`, Codex
`~/.agents/skills/loopany/`) when it connected via `loopany up`. Just author the
loop and run the `loopany` CLI; the references cover the exact commands.
