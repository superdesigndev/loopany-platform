# Tasks, docs, and the human inbox

## Tasks

A task is a unit of work. Its lifecycle is `open → closed` — two states, no
third, no reopen — plus three facets that decide when and by whom it is seen:

- **`watcher`** — the loop that acts next. **Never empty.** A task you file is
  watched by YOUR loop unless you name another one; a task a human files must
  name one outright. It is handed on, never released.
- **`follow_up`** — when it should resurface. Its arrival **wakes the watcher**:
  the scheduler queues one run for that loop, scoped to this task, on the same
  clock that fires cadences. Still a **schedule, not an obligation** — closing
  before it is legal.
- **`needs_human`** — a question. Attaching one puts the task in the human inbox
  and **blocks `task close` until it is answered**.

### Creating one

Like every object, the file IS the task. Front-matter keys: `title`, `key`,
`follow_up`, `watcher`, `needs_human`, `payload`.

```md
---
title: Watch error rate after the retry change
key: err-rate-after-retry-2026-08-04
follow_up: +1d
payload:
  pr: 1204
  baseline: 0.4
---

Compare the error rate against the 0.4% baseline once PR 1204 has been live for a
day. If it is still elevated, ask for a decision rather than reverting.
```

```sh
loopany task create --file watch-err-rate.md                    # you watch it
loopany task create --file reply.md --needs-human "Post this reply?" --watcher loop-8e3311
```

**`--watcher` is a HAND-OFF, not a requirement.** Omit it and the task is yours,
which is right for anything you intend to follow up. Name another loop only when
that loop is genuinely the one that should act next.

`title`, `key` and `payload` have **no flags** — they belong in the file, so a
retry replays byte-identically. The three facet flags exist because a run often
decides them at the moment it acts. **A flag and a front-matter key supplying the
same field is refused, with both values printed** — there is no precedence rule
to memorize, and the silent version routes a future human answer to the wrong
loop.

`payload` is machine-executed content: the verdict UI renders it **verbatim**, so
put anything that will actually be executed or posted there, not in prose.

### Reading and moving them

```sh
loopany task list --watcher loop-4c1d77 --due             # what you owe, now
loopany task list --watcher loop-4c1d77                   # everything you owe
loopany task list --creator loop-4c1d77 --closed --since 14d
loopany task show task-7f3a91
loopany task update task-7f3a91 --watcher loop-4c1d77     # hand it to another loop
loopany task update task-7f3a91 --payload-merge '{"merged_at":"2026-08-04T11:31:00+08:00"}'
loopany task close task-7f3a91 --note "error rate back to baseline; no action needed"
```

- Predicates compose as AND. `--since` takes a **bare, unsigned** duration
  (`14d`, `12h`) and looks backward — never `-14d`.
- `--follow-up` takes RFC 3339 with an offset, or a relative `+3d` / `+12h`;
  `null` clears it. Prefer the relative form: it is what you actually mean, and it
  needs no clock arithmetic.
- `--payload-merge` is a shallow top-level merge of one inline JSON object; a
  `null` value deletes a key. It cannot be combined with `--file` (a file
  replaces payload wholesale — the two cannot both be the truth).
- **`--note` on close is required.** It lands on the closing event and is the
  only record of why this closed. One sentence is enough.
- There is **no `--mine`, no `self`**. `--watcher <id>` is what you owe;
  `--creator <id>` is what you made.
- **There is no release.** `--watcher null` is refused: a task always names the
  loop that acts next, so the only watcher write is a transfer to another loop.

## Docs

A doc is a product: created from a file, rewritten in place, keeping its id so
everything citing it follows.

```sh
loopany doc create --file weekly-summary.md
loopany doc show doc-2b8e04 --file > d.md      # start an edit from the current text
loopany doc update doc-2b8e04 --file d.md
```

Register a product **as soon as it exists** — a partial product survives a dead
run, an unregistered one does not. Cite it from a task by putting `doc: doc-…`
under `payload:` and naming the id in the body.

## The inbox and `answer`

The inbox is the **safety floor**: it has no filters, because a filter could hide
an arm of it. One arm today — an open task carrying `needs_human`.

It used to have three. The other two caught work with no loop on the hook
(a due task nobody watched; an unwatched task older than 48h). Neither can happen
now: every task names a watcher, and a due one **wakes that watcher** instead of
being escalated to a person. Bringing a question to a human is the only thing
left that genuinely needs one.

```sh
loopany inbox
loopany answer task-7f3a91 "(b) give it one more day, check tomorrow night"
```

Both are **human-only** and are refused inside a run — a run's worklist is
`task list --watcher <your-loop-id> --due`.

The answer is **free text**. Approve, reject and instructions are all just the
answer; the kernel parses nothing. A reason is what lets the loop converge next
time — "no" alone teaches it nothing.

Answering **wakes the watcher**: one run is queued for that loop with the task in
scope, and it reads the answer with `task show`. If a run was already queued for
that loop, the answer **joins** it — one run, not two, and it pulls both answered
tasks when it claims. Every task names a watcher, so every answer reaches a loop.

## The rhythm of a run

1. Read your worklist: `task list --watcher <your-loop-id> --due`. A run woken by
   a due task is told which one in its work order — start there.
2. Do the work in the loop's bound `workdir`.
3. Register products as they exist (`doc create`).
4. Close what you verified, with a real note. Push out what is not ready
   (`task update <id> --follow-up +3d`) — that date is what wakes you for it
   again, so a task with no `follow_up` waits for your cadence instead.
5. Need a decision? `task update <id> --needs-human "…"` — then **stop on that
   task**. Your job on it is done until a human replies.
6. Learned something the charter should carry? `loop evolve <your-loop-id>
   --file charter.md`. Cadence, workdir, lifecycle and creating other loops are
   NOT yours — propose them.

**Nothing found is a clean result.** An empty list is an answer; never
manufacture work to have something to report.
