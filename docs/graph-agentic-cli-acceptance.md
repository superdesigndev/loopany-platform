# Agentic CLI v1 — the acceptance run

The bar captain decision 15 sets is not "the verbs exist". It is: **a real
`claude -p` run drives the whole chain through them, repeatedly, and we can say
honestly how often it needed help.** This is that record.

Everything below happened against a live server on `127.0.0.1:3840`, a machine
agent whose executor was `claude -p`, and the real private sandbox repo
`superdesigndev/loopany-e2e-sandbox`. Three pull requests were opened and merged
for real (#9, #10, #11). No step was simulated.

## The chain, and who does each hop

```
clock fires                        the scheduler, nobody watching
  discovery run                    graph task create → artifact push → review request
    PERSON approves (UI)           the only human act: "Run it"
      fix run                      real work in the jail → real PR
                                   graph mirror track → review request → artifact push
        PERSON approves (UI)       "Approve", with merge intent on the instance
          real merge               machine agent, local credentials, guarded twice
            observation            sensing sees GitHub say merged → closes merge-wait
              watch run            graph wait answer --met --evidence "…"
                PERSON closes      task move → done, attested
```

The **platform declares none of that sequence.** Every arrow inside a run is the
agent reading its work order and choosing a command; every arrow between runs is
a person's verdict or the clock. The old spec-declared chains
(`escalate → enqueue-review`, `watch-prs → register-watch`) are deleted, and a
probe pins that no shipped type declares either action any more.

## Stability table

Three full legs, plus the decision-17 foreign-domain chain. "Intervention" means
a human did something the design does not ask a human to do.

| # | Leg | Attempt | Outcome | Intervention needed |
| --- | --- | --- | --- | --- |
| 1 | scheduled discovery → task + report + review | 1 | ✅ clean | none |
| 1 | fix run → real PR #9 → mirror track → merge review | 1 | ✅ clean | none |
| 1 | human approve → merge | 1 | ⚠️ refused | `DEFAULT_BRANCH_REFUSED` — the agent's own guard. Operator set `LOOPANY_AGENT_ALLOW_DEFAULT_BRANCH`, then a second merge review was approved. **Working as designed**, and the refusal named exactly what to set. |
| 1 | observation closes merge-wait | 1 | ✅ clean | none |
| 1 | watch run answers `verify-fix` | 1 | ✅ clean | none |
| 1 | attested close of the issue | 1 | ✅ clean | none (the close was correctly REFUSED first, while the wait was open) |
| 2 | scheduled discovery | 1 | ⚠️ duplicate | Two sweeps filed the same problem. See finding **A**. Human rejected the twin. |
| 2 | fix run → real PR #10 → merge review | 1 | ✅ clean | none |
| 2 | human approve → real merge → observation | 1 | ✅ clean | none |
| 2 | watch run answers `verify-fix` | 1 | ✅ clean | none |
| 2 | attested close | 1 | ✅ clean | none |
| 3 | scheduled discovery (after fix A) | 1 | ✅ clean | none — found a genuinely different defect, having read `context.alreadyRecorded` |
| 3 | fix run → real PR #11 → merge review | 1 | ✅ clean | none |
| 3 | human approve → real merge → observation | 1 | ✅ clean | none |
| 3 | watch run answers `verify-fix` | 1 | ✅ clean | none |
| 3 | attested close | 1 | ✅ clean | none |
| 4 | **non-GitHub**: post doc → review → approved agent effect (dry run) | 1 | ⚠️ refused to invent | See finding **C**. The run wrote a dry-run file saying *why* it could not produce the bytes rather than fabricating them. |
| 4 | same chain, after fix C | 2 | ✅ clean | none — produced the exact bytes from the approved draft |

**No-intervention completion: 15 of 18 hops on first attempt.** All three
interventions produced a fix (below); none of them was the agent misusing a verb,
and none was silent.

## What the runs got wrong, and what changed

### A. Two sweeps, one problem, two tasks

Runs at 15:48 and 15:53 both found the modifier-key defect and both filed it. The
work orders told them to "check reality before acting" — and gave them no way to
do it. A run cannot query the graph (by design: the agent never reads the
database), so "is this already tracked?" was unanswerable.

**Fixed** in `outbox/handlers.ts`: a dispatched work order now carries
`context.alreadyRecorded` — the tasks and reviews this object has already
produced, newest first, capped. Same principle as `context.waits`: the server is
the only side that can see the graph, so the facts ride the order. The discovery
workflow prose now names that field explicitly.

Leg 3's sweep read it and stopped short of a duplicate.

### B. The agent believed a stronger guarantee than it had

Leg 3's sweep reasoned, in its own report:

> `graph task create` returns an id that is a **content hash of the title**, so
> re-issuing it is genuinely a no-op on an existing node - the dedupe guarantee
> is real, not advisory.

It was right about the guarantee it wanted and wrong about the one it had: the id
was `sha256(actor, key)`, so it deduplicated within one run and not across runs of
the same loop.

**Fixed** in `graph/cli/verbs.ts`: the identity is now `sha256(owner, key)` — the
loop, not the run. That is the guarantee every work order's "check reality"
instruction implies. The result also states its scope out loud
(`identity: <owner> + "<key>"`), because a run that has to guess whether a retry
twins will guess.

### C. A run asked to act on a document it could not read

The foreign-domain run was approved to "post the approved draft" and had no verb
that could fetch the draft. It **refused to invent the bytes**, wrote a dry-run
file explaining precisely that, and named what a person would have to supply.
That is the correct behaviour and a gap in the work order, not in the run.

**Fixed**: a work order now carries `context.subject` — the object the review
tracks, with its content, bounded and with truncation stated rather than silent.
Round 2 produced the real post bytes from the approved draft.

## The domain-neutral chain (captain decision 17)

Leg 4 used **zero new platform code**: the same `artifact push` for a drafted
post, the same `review request` with the `dispatch` preset, the same standard
review Task, the same generic `dispatch-outward-run`. The Reddit-ness lives
entirely in one instance field (`consequence`, prose) and in what the agent did
with it. The work order's own intent contains the string "reddit" nowhere — a
probe asserts that.

The dry run's product, verbatim from the jail:

```
DRY RUN - NOTHING WAS POSTED. No network call was made, no credential was read.
These are the exact bytes that would have been sent to Reddit.

subreddit: r/programming
title:     What 40 agent loops taught us about scheduling
body:
Draft for r/programming. Three things we got wrong about cadence, and what the
data said instead.
```

## Reproducing it

```bash
pnpm graph:agentic                  # two live loops; their WORKFLOW is a field on the object
LOOPANY_DATA_DIR=… LOOPANY_PORT=3840 LOOPANY_GRAPH_WORKSPACE=on \
  LOOPANY_AGENT_TOKEN=… pnpm dev    # the workspace at /dev/workspace
pnpm agent                          # executor: claude -p, jailed, graph on PATH
```

The machine agent needs `LOOPANY_AGENT_GRAPH_BIN_DIR` pointing at the built
`graph` binary, and the repo on `LOOPANY_AGENT_ALLOWED_REPOS`. Merging into a
repo's default branch additionally needs `LOOPANY_AGENT_ALLOW_DEFAULT_BRANCH` —
as leg 1 found out, which is the guard doing its job.

Two agent processes were run against one queue for most of the acceptance: a long
`claude` run holds its pass, so a second instance keeps outward effects moving.
The lease makes that safe, and it is the shape a real fleet would take.
