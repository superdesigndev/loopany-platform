# How a loop evolves — the task file as running memory

A loop is not a frozen instruction. Its **task file**
(`loopany/<slug>/README.md`) is both its **durable brief** and its **running
memory**: each scheduled run reads it for context and updates it, so the loop stays
coherent and improves over time instead of drifting or repeating itself.

## The three sections, over time

The task-file template (see `create.md`) has three sections that play distinct roles
across runs:

- **Spec** — the stable contract: what to check/do, the concrete steps, and the
  notify rule (when to message the user vs. stay silent). It changes rarely, and
  only on purpose — when the user wants the loop to do something different. That's a
  human/agent edit to the file (see `update.md`), not something a run rewrites.
- **Current understanding** — the loop's live model of the world: the baseline,
  known state, and open issues it currently expects. Each run **reconciles** this
  against what it actually observed and updates it, so the next run starts from the
  truth rather than the original snapshot.
- **Timeline** — an append-only log: one dated entry per run, added at the bottom.
  This is the loop's history — what it saw, what it did, what it told (or didn't
  tell) the user. New runs read recent entries to avoid repeating themselves and to
  spot trends.

## What each run does

1. **Read** the task file (Spec + Current understanding + recent Timeline) plus any
   docs it links — that's the run's full context.
2. **Do the work** per the Spec. For a `workflow` run this is deterministic JS; for a
   `task` run the coding agent reasons it out. Use `prev`/state or the Timeline to
   diff against last time so you only surface what's new.
3. **Update Current understanding** if the world moved (resolved an issue, learned a
   new baseline, found something to watch).
4. **Append one Timeline entry** (dated) summarizing this run.
5. **Notify per the Spec's rule** — message the user only when warranted under
   `notify: auto`; `always`/`never` override that.

## When to escalate a workflow to the agent

A `workflow` run is cheap and deterministic — prefer it for "hit an API, read a
value, compute a digest". When a run hits something that needs reasoning, code, or
file work (an anomaly to investigate, a report to write, a fix to make), escalate
from the workflow to the coding agent by calling `agent(message?, data?)`; the agent
then runs in `workdir` with the same task file as its brief. This keeps the common
case zero-LLM while still letting a loop think when it must.

## Changing what a loop does

When the user wants the loop itself to behave differently (not just reschedule),
edit the **Spec** in the task file directly — that's the single place its behavior is
defined. The change syncs to the server on the next run. Schedule/envelope changes
(cadence, name, notify, pause) go through `loopany edit` instead — see `update.md`.
