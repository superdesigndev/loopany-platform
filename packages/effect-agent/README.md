# `@loopany/effect-agent`

The machine side of **effect delivery**: the process that turns an approved
in-workspace verdict into something that actually happens on GitHub.

## Why this is a separate process

The Loopany server **executes nothing outward**. That is not a stylistic
preference - it is the zero-exec invariant the whole product rests on, and an
approved R3 action does not get to bend it. So the server's job for an outward
action is to write a **directive** (a work order) into `effect_directives`, and
this agent's job is to claim it and perform it **with local credentials**.

Two consequences worth stating plainly:

- **The credentials never leave the machine.** This agent shells out to `gh`,
  which is already logged in as its operator. Nothing here reads, stores or
  forwards a token, and the server never holds one.
- **The safety boundary is set here, not there.** The repo allowlist and the
  default-branch refusal are read from THIS machine's environment, so a server
  bug - or a tampered directive row - cannot widen what this agent is willing to
  do.

## The wire

Three verbs against the server, bearer-authenticated with a shared secret:

```
POST /api/effects/claim      {agent, machine?, limit?}  → work orders + a lease
POST /api/effects/heartbeat  {agent, id}                → lease extended
POST /api/effects/report     {agent, id, ok, …}         → outcome recorded
```

A claim carries a **lease**, not a flag. While an effect is in flight the agent
heartbeats; if it dies, the lease expires, the server re-offers the work, and
after a bounded number of abandoned claims the directive **fails** into the
workspace's Attention list. An outward effect that silently never happened is the
worst failure this system can have, so there is no path where one is possible.

## The guards

Every one **fails closed** and returns a **typed** refusal, because the code is
what decides whether the resulting attention item offers a retry.

| Guard | What it checks | Refusal |
| --- | --- | --- |
| Approval | the work order's approval block exists, was entered by a `human`, and names a real actor | `APPROVAL_INVALID` |
| Repo allowlist | the target repo is in `LOOPANY_EFFECT_ALLOWED_REPOS`. **Unset allows nothing.** | `REPO_NOT_ALLOWED` |
| Default branch | a merge whose base is the repo's own default branch needs `LOOPANY_EFFECT_ALLOW_DEFAULT_BRANCH` on top of the allowlist | `DEFAULT_BRANCH_REFUSED` |
| Mergeability | GitHub says the PR is conflicting or closed-unmerged | `NOT_MERGEABLE` |
| Kind | this build does not implement the effect | `UNSUPPORTED_KIND` |

The approval check is the **third** time that fact is verified - after the schema
CHECK at enqueue and the executor's re-check at effect time. Three, because they
fail differently: a constraint cannot see whether an id resolves, the executor
cannot see whether the wire was tampered with, and the agent cannot see the graph.

## The two effects

- **`github-comment`** (the default, low-risk one) posts a comment on the PR
  naming the verdict it came from. Idempotent by a marker: the body carries
  `<!-- loopany-effect:<directive id> -->`, and the agent reads the PR's comments
  first and skips if it is already there.
- **`github-merge`** (guarded) merges the PR. Idempotent because GitHub is: an
  already-merged PR is reported as an already-done success. It only runs when the
  merge review declared explicit merge intent, and then only past the guards above.

## Running it

```bash
export LOOPANY_EFFECT_SERVER_URL=http://127.0.0.1:3770
export LOOPANY_EFFECT_AGENT_TOKEN=…            # same value the server has
export LOOPANY_EFFECT_ALLOWED_REPOS=owner/repo # EMPTY ALLOWS NOTHING
pnpm effects:agent            # from the repo root; --once for a single pass
```

`--once` runs one pass and exits, which is what a demo step or a check wants.
Full environment reference: `loopany-effects --help`.

## Testing

`pnpm --filter @loopany/effect-agent test`. Every probe injects a fake `gh`, so
the whole agent - guards, idempotency, refusals - is tested on a machine with no
`gh` at all and without touching a real repository.
