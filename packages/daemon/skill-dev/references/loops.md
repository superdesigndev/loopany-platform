# Loops — the artifact, the cadence, the lifecycle

## The file IS the loop

A loop is created and read back as one markdown **artifact**: a front-matter
block of flat scalars, then a body that is the **charter**.

```md
---
title: Housekeeper
key: housekeeper-local
cron: "0 7 * * *"
workdir: /Users/you/Workspace/your-repo
---

You are the housekeeper for this repository.

Each run: read the open worklist, pick the single highest-value chore, do it in a
fresh worktree off main, and land it as one PR. Nothing found is a clean stop —
never manufacture work.
```

```sh
loopany loop create --file housekeeper.md      # `--file -` reads stdin
```

The closed key set is **`title`, `key`, `cron`, `workdir`, `payload`**. Anything
else is refused with a did-you-mean, so do not invent keys. The **body is the
charter** — the prompt every run of this loop receives.

- **`title`** — required, the display name.
- **`key`** — the idempotency key. Creating twice with the same key returns the
  EXISTING loop (`created: false`) and **does not apply your changes**; the
  response says so and names what differs. Change a loop with `evolve`/`update`
  or the loop page, never by re-creating it.
- **`cron`** — five fields (minute hour day-of-month month day-of-week). Present
  ⇒ the loop is **armed at birth**: `next_fire` is the first occurrence after
  now. **Omitted ⇒ the loop has no cadence and never fires on its own** — it is
  an on-demand loop you drive with `loop run-now`. That is a legitimate shape,
  not a mistake, but it must be the shape you meant: a loop that silently never
  runs is the one failure this format can hand you.
- **`workdir`** — **an ABSOLUTE path that must already exist on the machine that
  executes the run**, and must be inside that daemon's allowed roots
  (`LOOPANY_ROOTS`). Give one for any loop that touches a real checkout.
  - It is **never created for you.** No machine is bound to a loop — any machine
    of the team claims a run — so a claiming machine that lacks the directory
    **fails the run loudly** naming the path and the host, rather than running
    the charter against an empty lookalike of the repo it names.
  - A relative or `~`-form path is refused at the artifact seam. Absolute only:
    the claiming machine is unknown at write time, so "relative to what?" has no
    answer the server could give.
  - Omitted ⇒ runs get the daemon's own per-loop scratch dir. Fine for a smoke
    loop, wrong for anything that must see your code.
- **`payload`** — a free mapping the kernel never inspects.

Round-tripping is real: `loop show <id> --file > charter.md` emits a valid input
file. Edit it, then apply it with `loop evolve`.

## Reading the roster

```sh
loopany loop list                     # everything, retired included
loopany loop list --status active     # active | paused | retired
loopany loop show loop-4c1d77         # cadence, workdir, charter, event tail
loopany loop show loop-4c1d77 --full  # do not truncate the charter
```

A blank `next_fire` is never printed bare — the row says WHY it is blank
(`paused`, `retired — terminal`, or `no cadence — runs on demand only`), which is
the whole answer to "why is this loop not running?".

## Two zones: the charter is free, the cadence is keyed

- **`loop evolve <id> --file <path>` is the free zone.** A run rewrites its OWN
  loop's charter with no approval. The server computes the diff; the next run
  receives the new charter as its prompt.
- **`loop update <id> --cron "…" --workdir … --approval ev-…` is governance.**
  Cadence and workdir are WHEN and WHERE, and both sit behind a human approval
  event. An `evolve` whose file carries a differing `cron:` or `workdir:` is
  refused `APPROVAL_REQUIRED` — the rest of the file is not applied either.

The approval protocol, in full, because there is no other way to discover it:

1. the run proposes — `loopany task create --file p.md --needs-human "propose this cadence: …" --watcher <its own loop id>`;
2. a human answers in the inbox; one run is queued for that loop with the task in scope;
3. that run reads the verdict event id (`loopany task show <task-id>`) and passes it as `--approval`;
4. the run closes the proposal task with a note.

The kernel checks the key exists, is human, and hangs on your loop's task — not
that it matches the change you are making.

## Lifecycle, and what pause actually means

```sh
loopany loop pause  loop-4c1d77 --note "muted while the migration lands"
loopany loop resume loop-4c1d77
loopany loop retire loop-4c1d77 --note "the experiment is over"
```

- **`pause` disarms the CADENCE**: `next_fire` is cleared, so the clock can never
  select this loop — including for a task of its own that comes due, which simply
  stays due and fires on the next tick after `resume`. Time never un-pauses it —
  `resume` is the only exit (including from a failure auto-pause). Everything it
  created stays open and readable; pausing a loop does not close its tasks.
- **`resume` re-arms to the NEXT occurrence.** A week paused owes exactly one
  fire, not a week of them.
- **`retire` is terminal.** The charter freezes, `evolve` and `update` are
  refused for good, `run-now` is refused, and there is no un-retire. Retired
  loops stay listed on purpose.
- **Retire WARNS, it never blocks.** Retiring a loop that still watches open
  tasks succeeds, and the response names the count: those tasks keep pointing at
  a loop that will never be woken again. Hand each to a live loop
  (`task update <id> --watcher <loop-id>`) or close it.
- Repeating any of them is a **success that changed nothing** (`changed: false`),
  so a retry after a dropped connection costs nothing. Only a move OUT of
  `retired` refuses.

## `loop run-now` — the manual fire

```sh
loopany loop run-now loop-4c1d77
```

Human-only, no flags and no body: the loop already says what it does, so an
off-cadence run is a button, not a form.

- **A PAUSED loop DOES fire, and stays paused.** Pause governs the clock, not
  this button. The fire does not resume the cadence — `next_fire` stays cleared,
  the status stays `paused` — so it is one run, and then quiet again. Do not read
  a successful fire as a resume, and do not "resume, fire, pause": that dance
  leaves a real window in which the cadence is live.
- **A RETIRED loop is refused** (`RETIRED`). It is ended, not parked, and the
  difference is the point.
- **One queued run per loop.** A second fire while one is already queued reports
  that run (`already queued`) instead of minting a twin.
- Nothing waits for the run. A machine of the team claims it on its next poll;
  watch it land with `loop show <id>`.

This is also what makes staging a risky loop safe: create it with the daemon
down and pause it in the same breath, and it is autonomously inert — nothing runs
unless a human presses `run-now`.
