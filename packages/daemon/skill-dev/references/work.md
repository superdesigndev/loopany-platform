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

## Mirrors — what a task depends on outside the system

A **mirror** is a pointer to an external thing: a PR, an issue, a URL, a Search
Console property. It exists so that the next run reading a task can see which
external items it must go and check.

> **A mirror tells you WHERE to look, never WHAT state it is in.**

That is not advice. A mirror row has no `payload` and no `body`, so there is
physically nowhere to write `state: merged` — the DDL refuses it. A mirror
therefore can never be stale, and there is nothing to "sync". Go and look at the
external thing; record what you **found** on the task that owns the work.

Fields: `kind` (what sort of external thing), `coords` (its immutable identity),
a `note` (a human label), and the objects it is attached to.

### Attaching one

Two doors, and which one you use depends only on whether the reference already
existed.

**The ref is born from your own work** — the common case, so it is a one-liner
with no file:

```sh
loopany mirror attach task-7f3a91 --kind github-pr \
  --coords superdesigndev/loopany-platform#57 --note "seed article PR"
```

**The ref predates the object** — declare it in the front matter, and the object
and its mirrors are created in ONE transaction:

```md
---
title: Seed article bet
watcher: loop-4c1d77
mirrors:
  - kind: github-pr
    coords: superdesigndev/loopany-platform#57
    note: seed article PR
  - kind: url
    coords: https://example.com/brief
---
```

`mirrors:` is **create-only**. A mirror is its own object and the attachment
lives on the mirror side, so a whole-file update cannot rewrite the set — a file
that merely omitted one would silently detach it. `show --file` never emits the
block, which is why the round trip stays clean.

### Reading and moving them

```sh
loopany mirror list --attached-to task-7f3a91      # what this task depends on
loopany mirror list --kind github-pr --coords-like superdesigndev/
loopany mirror kinds                                # the vocabulary in use
loopany mirror detach mirror-3f9a21c04b7e --from task-7f3a91
```

`task show` / `doc show` / `loop show` already print the mirrors attached to that
object, so you rarely need `mirror list` inside a run.

- **Kinds are free-form**, lowercased and kebabbed on write, so `GitHub PR`,
  `github_pr` and `github-pr` are one kind. The canonical ones are **`github-pr`,
  `github-issue`, `url`, `gsc-property`**; a KNOWN kind also has its coords shape
  checked, and an unknown one is accepted as a plain string. Invent one when none
  fits — `mirror kinds` shows the next reader what this team already uses.
- **One external thing is ONE mirror.** Attaching the same coords from a second
  object shares the row rather than minting a twin, so `--note` set by the first
  attach is the label everyone sees (the response says so when yours differed).
- **Coords are IDENTITY and are never changed.** A different PR is a different
  mirror: detach this one and attach a new one. Only `--note` is editable.
- `--from` on detach is required: a mirror can hang on several objects, and
  guessing would remove somebody else's pointer. Detaching the last attachment is
  fine — nothing here is ever deleted.

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
scope, and your reply rides in its work order **verbatim**. If a run was already
queued for that loop, the answer **joins** it — one run, not two, and it pulls
both answered tasks when it claims. Every task names a watcher, so every answer
reaches a loop.

## `task tell` — the other direction

The inbox is the loop asking **you**. `task tell` is **you speaking first**: an
instruction on any open task, without waiting to be asked.

```sh
loopany task tell task-7f3a91 "Drop this bet — close the PR, delete the branch, then close the task."
```

It writes a human event on the task and queues one run for its watcher, exactly
like an answer does, with your words verbatim in the work order. Two things make
it a different verb rather than a flag on `answer`:

- **An answer replies to a question the loop framed; a directive arrives
  unframed.** The run is told which it is (`reason: directive`), because its first
  job is to work out what the instruction implies, not to slot a reply into a
  decision it already set up.
- **It is refused while a question is pending.** You already have the floor
  there, and an answer is free text — any instruction fits inside one.

**A directive is executed against REALITY first and this kernel's records last.**
"Drop this bet" means close the PR, clean up the branch, and *then* close the
task. Settling the record while the world it describes carries on unchanged is
the one outcome that is always wrong.

One queued run per loop still holds: a directive on a loop that already has a run
queued reports that run instead of stacking a twin. Nothing is lost — the
directive is on the task's timeline, which the queued run reads when it claims.

### Who closes a task

**Its watcher does.** That is the expected end of every task, either from the
loop's own workflow logic or in response to a directive. The web UI has no close
button for exactly this reason.

`loopany task close <id> --note "…"` still exists and is the **emergency hatch
for a broken watcher**: when the loop cannot act, this is the manual exit — and
you should expect to reconcile the external items yourself, because nothing else
will.

## The rhythm of a run

1. Read your worklist: `task list --watcher <your-loop-id> --due`. A run woken by
   a due task, an answer or a **directive** is told which one in its work order —
   start there. If a human's words are in your work order, **do what they say,
   against the outside world first**; the kernel's records are the last step.
2. Do the work in the loop's bound `workdir`. `task show` lists the **external
   items** the task depends on — go and check them; they are pointers, and none
   of them tells you what state the external thing is in.
3. Register products as they exist (`doc create`), and attach a mirror for
   anything external you create or start depending on (`mirror attach`).
4. Close what you verified, with a real note — **you are the one who closes your
   tasks**, and closing means the external world is settled too, not just the
   record. Push out what is not ready (`task update <id> --follow-up +3d`) — that
   date is what wakes you for it again, so a task with no `follow_up` waits for
   your cadence instead.
5. Need a decision? `task update <id> --needs-human "…"` — then **stop on that
   task**. Your job on it is done until a human replies.
6. Learned something the charter should carry? `loop evolve <your-loop-id>
   --file charter.md`. Cadence, workdir, lifecycle and creating other loops are
   NOT yours — propose them.

**Nothing found is a clean result.** An empty list is an answer; never
manufacture work to have something to report.
