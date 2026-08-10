---
name: loopany
description: >-
  Record, advance, and hand off tasks and documents with the loopany kernel CLI.
  Use inside a loop run (you were spawned with a task) to note progress, file
  products by kind, and end the run with an honest status. Also the human/agent
  surface for reading the tree, the inbox, and a task's full history.
---

# loopany — the task kernel skill (v1)

You and the human share ONE surface: the `loopany-kernel` CLI. Objects are the
present, events are the past, triggers are the future, runs are the handoff in
flight. Everything else (inbox, tree, board) is a query — it is never stored, so
you can always ask for it fresh.

This skill is ENRICHMENT. The CORE prompt you were spawned with is self-sufficient;
read this when you want the deeper grammar.

## Grammar quick reference

```text
read
  show <id> [--log]                     the object + (with --log) its event stream
  list [--status|--assignee|--due|--tree]  no filter = the two-level tree
  search <keyword>
  inbox --assignee <me>                 products awaiting YOUR decision

write  (all accept --dry-run)
  create "<title>" [--parent --tracks --assignee --type -p --status
                    --cron "<expr>" --follow-up <date> --body-file f.md]
  update <id> k=v … [--note "<text>"] [--if-version N]
  note <id> "<text>"
  doc put <key> [--file f.md]           upsert (no create/update split)
  mirror add <kind> <coords>            an external-fact pointer (no bytes)

dispatch
  run <id>                              a manual run (the third dispatch entrance)
```

There is no `delete` (use `status=archived`), no `finish`/`report`/`close` (the
status IS the ending), and no `evolve`/`edit` verb (those are just tasks you
create and assign to a loop).

## Three standing rules

1. **Capture after planning.** Before you dive in, `note` the plan you settled on.
   A future pass reads that note to know your intent, not just your output.
2. **Update + note after progress.** When you advance the work, `update` the task
   (its body is the CURATED present — what the task is really about now) and leave
   a `note` (the running log). The body is yours to compress; events are never
   lost, so lean on the log for detail and keep the body clean.
3. **Nothing disappears silently.** Every decision, observation, and dead end goes
   into a note or an event. If you looked and found nothing, say "found nothing" —
   an empty run is an honest result, never a reason to manufacture activity.

## The artifact rule (file products by KIND)

A product you make lands in exactly one of three places, by its NATURE:

- **Has a lifecycle** (it will change, needs tracking, someone acts on it) →
  a **task** (`create` / `update`). Bugs, follow-ups, sub-goals.
- **Prose meant to be read inside the product** → a **doc** (`doc put <key>`).
  A report, a spec, a runbook. `doc put` is an upsert: same key overwrites.
- **Bytes that live somewhere else** (a PR, a URL, an external issue) →
  a **mirror** (`mirror add <kind> <coords>`). A mirror is an ADDRESS, not a
  cache — never copy the external bytes in.

An artifact with no lifecycle does not deserve a record of its own. Say what you
found in a `note` and move on.

## The shepherd rule (getting a human decision)

The loop never owes the human its attention — it owes them its PRODUCTS. To put a
product in front of a human for a decision, create a small **shepherd task** that
`--tracks` the doc or mirror and assign it to the person:

```text
loopany-kernel doc put q3-seo-verdict --file verdict.md
loopany-kernel create "Ship the SEO engine?" --tracks q3-seo-verdict --assignee alice@team
```

That task now appears in Alice's `inbox` (a query over `tracks` + assignee). One
shepherd = one decision = one inbox item; N objects needing decisions = N
shepherds. When Alice answers, she re-assigns the task back to you (`assignee=<loop>`,
`status=todo`), which dispatches a run — the human answer becomes your next wake.

## The session lifecycle (two commands)

Inside a run you were spawned with three env vars — `LOOPANY_TASK_ID`,
`LOOPANY_RUN_ID`, `LOOPANY_SESSION_ID`. The session id is how your callbacks are
attributed on the event stream (and how a future pass finds your transcript with
`find … <sessionId>.jsonl`). Your whole session is bracketed by two kernel calls:

1. **Open by reading.** `loopany-kernel show $LOOPANY_TASK_ID --log` — the body is
   the current understanding, the log is what happened, the sessionIds in it lead
   to prior transcripts.
2. **Close by writing status.** `loopany-kernel update $LOOPANY_TASK_ID status=<s>
   --note "<what changed>"`. There is NO terminal verb — the status you set IS the
   ending:
   - `done` — the goal is met (this disarms a recurring schedule).
   - `follow-up` with `--follow-up <date>` — look again later; set the date sooner
     if things are moving, later if quiet.
   - `in-progress` — a recurring loop simply continues.
   - `archived` — no longer relevant (there is no delete).

Between those two, note as you go (rule 2) and file products by kind (the artifact
rule). Then stop: one pass, no waiting for a reply.
