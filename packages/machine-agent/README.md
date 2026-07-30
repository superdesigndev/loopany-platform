# `@loopany/machine-agent`

The machine side of the graph engine: the process that **observes** the outside
world and **acts** on it, with local credentials, so the server never has to.

## Why this is a separate process

The Loopany server **executes nothing and fetches nothing**. That is not a
stylistic preference - it is the zero-exec invariant the whole product rests on,
and two captain decisions make it explicit in both directions:

- **Decision 10 (sensing is daemon-side).** All external observation runs where
  the credentials live. There is no server-side fetch loop anywhere, and no
  dev-mode exception - a local demo runs the real topology, with this process
  alongside the dev server.
- **Decision 12 (agents execute effects).** The default path for every external
  effect is "an agent does it from an instruction". Coded handlers
  (`github-comment`, `github-merge`) remain only as earned accelerators for two
  hot actions.

Two consequences worth stating plainly:

- **The credentials never leave the machine.** This agent shells out to `gh`,
  which is already logged in as its operator, and to whatever executor its
  operator configured. Nothing here reads, stores or forwards a token, and the
  server never holds one.
- **The safety boundary is set here, not there.** The repo allowlist, the
  default-branch refusal, the run root and the never-execute list are read from
  THIS machine's environment, so a server bug - or a tampered directive row -
  cannot widen what this agent is willing to do.

## The wire

All bearer-authenticated with one shared secret, because acting and observing are
one trust boundary:

```
POST /api/agent/effects/claim        {agent, machine?, limit?}   → work orders + a lease
POST /api/agent/effects/heartbeat    {agent, id}                 → lease extended
POST /api/agent/effects/report       {agent, id, ok, …}          → outcome recorded

POST /api/agent/sensing/watchlist    {agent, teamId?}            → the mirrors to keep fresh
POST /api/agent/sensing/observations {agent, observations[], …}   → facts ingested

POST /api/agent/runs/started         {agent, directive}          → run-started
POST /api/agent/runs/finished        {agent, directive, outcome} → run-finished + the task advances
```

A claim carries a **lease**, not a flag. While work is in flight the agent
heartbeats; if it dies, the lease expires, the server re-offers the work, and
after a bounded number of abandoned claims the directive **fails** into the
workspace's Attention list. An outward effect that silently never happened is the
worst failure this system can have, so there is no path where one is possible.

## Sensing

The freshness half of design §7, moved here whole:

1. pull the **watch list** ("these are the pull-request mirrors this team holds" -
   a query over the server's own tables, so scope can never widen on its own);
2. **batch by repo** and fetch with local `gh` credentials - one GraphQL query per
   repo-chunk, small fixed concurrency, stopping early below a rate-limit floor;
3. **report** the observations back through the server's observation seam.

Read-only by construction: the only statement on this path is a GraphQL `query`,
and there is no mutation text in it at all.

Crash-safety needs nothing. Derived event ids are content-derived server-side, so
who fetched the bytes is invisible to dedup: re-reporting the same facts inserts
zero rows, and a sweep killed halfway costs nothing because the next one observes
the same facts and collides. There is no cursor to get wrong.

## Instruction runs

A `run-task` work order is a **generic instruction**: intent (prose, addressed to
an agent) + context (structured facts resolved from the graph) + scope (where it
may work, what it may touch, how long it has). The agent does not branch on what
kind of work it is - a PR comment, an Intercom reply and an investigation are the
same three fields, which is what makes this the default path rather than a special
case that grew.

The **guard sandwich** rides the directive, not a handler:

| Stage | What runs |
| --- | --- |
| Before | the R3 human-approval re-check, then the scope/allowlist/jail checks - all deterministic |
| During | the configured executor, fixed argv, instruction on **stdin**, in a jailed workdir, bounded time and output, killed as a process group |
| After | the **observation** layer confirming reality - a merge is believed because sensing sees GitHub say so, never because a run said it did |

Agent-side idempotency is instruction **discipline**: every composed prompt says
"this may be delivered more than once, check reality before acting", with
observation as the consistency backstop.

## The guards

Every one **fails closed** and returns a **typed** refusal, because the code is
what decides whether the resulting attention item offers a retry.

| Guard | What it checks | Refusal |
| --- | --- | --- |
| Approval | the work order's approval block exists, was entered by a `human`, and names a real actor | `APPROVAL_INVALID` |
| Repo allowlist | the target repo is in `LOOPANY_AGENT_ALLOWED_REPOS`. **Unset allows nothing.** | `REPO_NOT_ALLOWED` |
| Default branch | a merge whose base is the repo's own default branch needs `LOOPANY_AGENT_ALLOW_DEFAULT_BRANCH` on top of the allowlist | `DEFAULT_BRANCH_REFUSED` |
| Mergeability | GitHub says the PR is conflicting or closed-unmerged | `NOT_MERGEABLE` |
| Executor | an executor is configured, is not on the never-execute list, and a run root exists | `RUN_NOT_PERMITTED` |
| Run scope | the instruction's declared repos are inside this machine's allowlist; its workdir resolves inside the run root | `RUN_NOT_PERMITTED` |
| Kind | this build does not implement the effect | `UNSUPPORTED_KIND` |

The approval check is the **third** time that fact is verified - after the schema
CHECK at enqueue and the executor's re-check at effect time. Three, because they
fail differently: a constraint cannot see whether an id resolves, the executor
cannot see whether the wire was tampered with, and the agent cannot see the graph.

**`NEVER_EXECUTE` is a hard floor under the configuration.** `loopany` and this
agent's own binaries can never be the instruction executor, whatever the
environment says, and the check is on the resolved basename so a path cannot walk
around it. A live daemon runs somebody's real scheduled work; an instruction
runner must not be able to touch it.

## Running it

```bash
export LOOPANY_AGENT_SERVER_URL=http://127.0.0.1:3780
export LOOPANY_AGENT_TOKEN=…                     # same value the server has
export LOOPANY_AGENT_ALLOWED_REPOS=owner/repo    # EMPTY ALLOWS NOTHING
export LOOPANY_AGENT_RUN_ROOT=/tmp/loopany-runs  # the jail; UNSET RUNS NOTHING
export LOOPANY_AGENT_EXEC_COMMAND=claude         # the instruction executor
export LOOPANY_AGENT_EXEC_ARGS='-p'
pnpm agent            # from the repo root; --once for a single pass, --sense to sweep only
```

Full environment reference: `loopany-agent --help`.

## Testing

`pnpm --filter @loopany/machine-agent test`. The GitHub client is always faked, so
guards, idempotency, batching and rate-limit behaviour are tested on a machine with
no `gh` at all and without touching a real repository. The **spawn** probes use a
real child process in a temp directory - that is the only way "a timeout kills the
process group" and "the instruction never appears in argv" are claims rather than
hopes.
