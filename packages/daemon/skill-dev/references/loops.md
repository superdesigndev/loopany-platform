# Production loops on the convergence stack

## Identity and standing brief

The production `loops` row is the live loop. A migrated kernel loop keeps the
same id verbatim, so task watchers, creators, mirrors and loop-keyed events need
no alias or rewrite. Its old kernel object remains only for history until S5.

The standing brief is an attached charter object. During a run, the daemon
materializes it at an absolute per-run path and exposes that path only through
`LOOPANY_CHARTER_FILE`:

```md
# Housekeeper

## Spec

Each run: inspect the repository, do one valuable chore, and report only what
changed. Nothing found is a clean stop.
```

The materialization is not in the workdir and is not a product artifact. Edit it
inside the run when standing knowledge changes; the daemon carries the change
back at finalization with conflict protection.

## Read, create and edit

```sh
loopany loops
loopany show loop-4c1d77
loopany new --json '<validated production loop config>' --charter-file <path>
loopany edit loop-4c1d77 --json '{"cron":"30 7 * * *"}'
loopany edit loop-4c1d77 --charter-file <path>
```

`loops` and `show` read production rows. `new` and `edit` use the production
owner API and preserve its validators, machine binding and schedule semantics.
Use `show --charter` and `edit --charter-file` for owner-authority charter reads
and replacements; do not call the old
kernel `loop create|evolve|update` verbs. Those commands intentionally return a
teaching pointer and write nothing.

## Schedule and pause

`enabled=false` pauses the cadence. A due task watched by that loop remains due
but queues nothing while paused; the first due scan after re-enable queues one
derived-id run for that follow-up instant.

```sh
loopany edit loop-4c1d77 --json '{"enabled":false}'
loopany edit loop-4c1d77 --json '{"enabled":true}'
```

Pausing never clears or closes attached tasks — a paused loop's tasks wait for
it and it acts on them the next time it runs. A deleted loop leaves a legal
dangling watcher that the workspace renders as a tombstone; there is no way to
re-point it, so close those tasks with a note and re-file the ones that still
matter at a live loop.

## Manual Run now

Use **Run now** on the production dashboard/workspace loop drawer. It queues an
ordinary production pending row, wakes the bound machine's parked poll, executes
in the loop's workdir and reports through the production run-token pipeline.

A PAUSED loop does fire once and stays paused. Pause governs the cadence, not the
button. Do not resume/fire/pause: that creates a real window in which cadence is
live. A second manual fire while an eligible pending row already represents the
work reports it as already queued rather than stacking a duplicate.

## Machine and workdir

The loop is bound to one production machine and has an explicit workdir as its
content home. The daemon's configured `LOOPANY_ROOTS` must contain the workdir.
If the directory is unavailable or outside the jail, fail loudly; never run the
brief in an empty lookalike directory.
