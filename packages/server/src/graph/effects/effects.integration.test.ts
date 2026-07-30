import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PROBE SUITE — EFFECT DELIVERY, over a REAL pglite database (migrations applied
 * in `beforeAll`, so this file is also the proof that migration 0005 applies
 * cleanly on a fresh DB).
 *
 * The thing under test is the whole path a verdict now takes to the outside
 * world, minus the outside world itself:
 *
 *   a human approves  →  applyTransition enqueues R3 actions against its OWN
 *                        human event as the approval
 *   the executor runs →  the handler writes an effect DIRECTIVE (it never calls
 *                        GitHub - the server holds no credentials)
 *   an agent claims   →  with a lease, and with the approval evidence attached
 *   an agent reports  →  done, or FAILED with a typed reason that becomes an
 *                        attention item
 *
 * Each block is one property that would cause a real incident if it stopped
 * holding, written the way the incident would find it:
 *
 *   1. the happy path        approve ⇒ exactly one comment directive, carrying a
 *                            human approval block and an idempotency marker
 *   2. exactly-once          the action executed twice ⇒ ONE directive
 *   3. merge intent          no intent ⇒ the merge stands down; intent ⇒ one merge
 *                            directive, and the comment is unaffected either way
 *   4. claim exclusivity     two agents claiming at once take DISJOINT sets
 *   5. lease expiry          an abandoned claim returns to `pending`; past the
 *                            budget it FAILS and surfaces in Attention
 *   6. the zombie report     a report from a reclaimed holder changes nothing
 *   7. guard refusals        a repo/default-branch refusal ⇒ failed + an attention
 *                            item that does NOT offer a retry
 *   8. the approval ceiling  a non-human approval never becomes a directive
 *   9. the bearer            an unset token admits nobody
 *
 * Every probe passes `now` explicitly - nothing in this path reads a clock - so
 * "the lease expired" is an assertion rather than a sleep.
 */

let tmp: string
let dbmod: typeof import('../../db/index.js')
let graph: typeof import('../../db/graphStore.js')
let at: typeof import('../applyTransition.js')
let exec: typeof import('../outbox/executor.js')
let attention: typeof import('../outbox/attention.js')
let channel: typeof import('./channel.js')
let cfg: typeof import('../agent/config.js')
let directive: typeof import('./directive.js')
let specs: typeof import('../workspace/specs.js')

const TEAM = 'team-effects'
const USER = 'u-probe-captain'
const NOW = '2026-07-30T09:00:00.000Z'
/** Comfortably past a 60s lease. */
const LATER = '2026-07-30T09:30:00.000Z'
/** Successive instants, each past the previous claim's lease, so a run of
 *  abandoned claims really does burn the attempt budget. `maxClaims()` is 3 and
 *  the first two claims are already spent by the time these run. */
const LEASE_CYCLE = ['2026-07-30T10:00:00.000Z', '2026-07-30T10:30:00.000Z', '2026-07-30T11:00:00.000Z']
/** Past every lease in the cycle - when the probe asks what became of it. */
const AFTER_CYCLE = '2026-07-30T12:00:00.000Z'

/** One PR mirror plus the `merge`-preset review that tracks it, parked in its
 *  gate exactly as the live flow leaves it: `submit` run by the agent run that
 *  opened the PR, its own actions settled. */
async function pendingReview(
  suffix: string,
  opts: { number: number; mergeIntent?: boolean },
): Promise<{ mirrorId: string; reviewId: string }> {
  const externalId = `acme/widgets/pull/${opts.number}`
  const { object: mirror } = await graph.getOrCreateMirror(undefined, {
    teamId: TEAM,
    externalSource: 'github',
    externalId,
    type: 'pull-request',
    status: 'open',
    title: `PR #${opts.number} · ${suffix}`,
    payload: { repo: 'acme/widgets', number: opts.number, state: 'open', merged: false, checks: 'passing', draft: false },
    now: NOW,
  })
  const review = await graph.createObject(undefined, {
    teamId: TEAM,
    archetype: 'task',
    type: 'review',
    status: 'queued',
    title: `merge review ${suffix}`,
    payload: {
      preset: 'merge',
      repo: 'acme/widgets',
      number: opts.number,
      // The GitHub accelerators are OPT-IN per instance since the collapse
      // (captain decisions 16 + 17): the comment always applies to a merge
      // review, the merge only when this instance asked for it.
      commentIntent: true,
      ...(opts.mergeIntent ? { mergeIntent: true } : {}),
    },
    now: NOW,
  })
  await graph.upsertEdge(undefined, { teamId: TEAM, kind: 'tracks', srcId: review.id, dstId: mirror.id, now: NOW })

  const submitted = await at.applyTransition({
    objectId: review.id,
    transition: 'submit',
    actor: { entrance: 'agent-run', actorId: `run-${suffix}` },
    now: NOW,
  })
  expect(submitted.ok).toBe(true)
  // Settle `submit`'s own consequences: `approve` is terminal, and an unsettled
  // action legitimately blocks a terminal transition.
  await exec.drainOutbox({ now: NOW, teamId: TEAM, maxPasses: 8 })
  return { mirrorId: mirror.id, reviewId: review.id }
}

/** Approve as a HUMAN would from the workspace, then let the executor settle the
 *  verdict's own consequences. */
async function approve(reviewId: string): Promise<import('../applyTransition.js').ApplyTransitionResult> {
  const r = await at.applyTransition({
    objectId: reviewId,
    transition: 'approve',
    actor: { entrance: 'human', actorId: USER },
    now: NOW,
  })
  if (r.ok) await exec.drainOutbox({ now: NOW, teamId: TEAM, maxPasses: 8 })
  return r
}

/**
 * Empty the pending queue so a probe about ONE directive is about one directive.
 *
 * The claim is by DUE-NESS, not by id (an agent asks "what is there?", never "give
 * me this one"), so earlier probes' unclaimed work would otherwise ride along in a
 * later probe's batch and make its assertions depend on file order.
 *
 * Written directly against the table on purpose, like `replayRows` in the outbox
 * suite: there is no production verb for "abandon everything in this queue", and
 * there should not be one.
 */
async function settleQueue(): Promise<void> {
  const { inArray } = await import('drizzle-orm')
  const schema = await import('../../db/graph-schema.js')
  const unsettled = (await graph.listDirectives(undefined, TEAM, 500)).filter(
    (d) => d.state === 'pending' || d.state === 'claimed',
  )
  if (!unsettled.length) return
  await dbmod.db
    .update(schema.effectDirectives)
    .set({ state: 'done', settledAt: NOW, leaseExpiresAt: null, result: { detail: 'probe setup' } })
    .where(inArray(schema.effectDirectives.id, unsettled.map((d) => d.id)))
}

async function armType(name: string, spec: import('../types.js').TypeSpec, archetype: 'task' | 'doc' | 'mirror') {
  await graph.proposeTypeVersion(undefined, {
    teamId: TEAM,
    name,
    archetype,
    version: 1,
    spec,
    rationale: `effects probe type ${name}`,
    now: NOW,
  })
  await graph.armTypeVersion(undefined, { teamId: TEAM, name, version: 1, now: NOW })
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-effects-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  graph = await import('../../db/graphStore.js')
  at = await import('../applyTransition.js')
  exec = await import('../outbox/executor.js')
  attention = await import('../outbox/attention.js')
  channel = await import('./channel.js')
  cfg = await import('../agent/config.js')
  directive = await import('./directive.js')
  specs = await import('../workspace/specs.js')

  await graph.seedBuiltinTypes(undefined, TEAM, NOW)
  // The REAL specs, not probe stand-ins: the point of this suite is that the
  // shipping review type reaches GitHub with the `merge` preset, so a
  // hand-written copy of it here would test the copy.
  await armType('review', specs.REVIEW_SPEC, 'task')
  await armType('pull-request', specs.PULL_REQUEST_SPEC, 'mirror')
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1 - the happy path: a verdict becomes a work order
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: approving a merge review produces ONE outward work order', () => {
  it('writes a github-comment directive carrying the human approval and a marker', async () => {
    const { mirrorId, reviewId } = await pendingReview('happy', { number: 101 })
    const verdict = await approve(reviewId)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.object.status).toBe('approved')

    const rows = (await graph.listDirectives(undefined, TEAM, 100)).filter((d) => d.objectId === mirrorId)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind).toBe('github-comment')
    expect(row.state).toBe('pending')
    expect(row.targetExternalId).toBe('acme/widgets/pull/101')

    // THE APPROVAL IS THIS VERY VERDICT. A human entered the transition, so its
    // own event is what the outward effect rests on - no second event, and no
    // way for a non-human entrance to reach here (probe 8).
    expect(row.approvalEvent).toBe(verdict.event.id)
    const approvalRow = await graph.getEvent(undefined, row.approvalEvent)
    expect(approvalRow?.entrance).toBe('human')
    expect(approvalRow?.actorId).toBe(USER)

    // The body is finished bytes with the idempotency marker in them, so the
    // agent interprets nothing.
    const payload = row.payload as Record<string, unknown>
    expect(String(payload.body)).toContain(directive.directiveMarker(row.id))
    expect(payload.marker).toBe(directive.directiveMarker(row.id))
    expect(String(payload.body)).toContain(verdict.event.id)

    // And the server did NOT touch GitHub to get here: the action is done, the
    // effect has not happened yet, and something else has to make it happen.
    expect((await graph.getAction(undefined, row.id))!.state).toBe('done')
  })

  it('carries the approval block to the agent on claim', async () => {
    const claimed = await channel.claimDirectives({ now: NOW, agent: 'agent-A', teamId: TEAM })
    const wire = claimed.directives.find((d) => d.target.externalId === 'acme/widgets/pull/101')
    expect(wire).toBeDefined()
    expect(wire!.approval?.entrance).toBe('human')
    expect(wire!.approval?.actorId).toBe(USER)
    expect(wire!.approval?.transition).toBe('approve')
    expect(wire!.leaseExpiresAt > NOW).toBe(true)

    const report = await channel.reportDirective({
      now: NOW,
      agent: 'agent-A',
      id: wire!.id,
      ok: true,
      result: { url: 'https://github.com/acme/widgets/pull/101#issuecomment-1', detail: 'commented' },
    })
    expect(report.ok).toBe(true)
    const settled = (await graph.getDirective(undefined, wire!.id))!
    expect(settled.state).toBe('done')
    expect((settled.result as Record<string, unknown>).url).toContain('issuecomment')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2 - exactly one work order, however many times the action runs
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: the same outward action executed twice produces ONE directive', () => {
  it('collides on the action id instead of queueing a second effect', async () => {
    const { mirrorId, reviewId } = await pendingReview('twice', { number: 102 })
    await approve(reviewId)
    const before = (await graph.listDirectives(undefined, TEAM, 200)).filter((d) => d.objectId === mirrorId)
    expect(before).toHaveLength(1)

    // FORCE the at-least-once boundary exactly as a crash between the effect and
    // the stamp would leave it: the row claimable again, its effect already
    // applied. Nothing about the second pass knows it is a replay.
    const { inArray } = await import('drizzle-orm')
    const schema = await import('../../db/graph-schema.js')
    await dbmod.db
      .update(schema.outboxActions)
      .set({ state: 'pending', deliveredAt: null, claimedAt: null, claimedBy: null, nextAttemptAt: null })
      .where(inArray(schema.outboxActions.id, [before[0]!.id]))

    const second = await exec.runOnce({ now: NOW, teamId: TEAM })
    expect(second.done).toBeGreaterThanOrEqual(1)
    expect(second.deadLettered).toBe(0)
    expect((await graph.listDirectives(undefined, TEAM, 200)).filter((d) => d.objectId === mirrorId)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3 - merge intent: the guarded effect stands down unless it was asked for
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a merge happens only when the review declares merge intent', () => {
  it('stands the merge down - cleanly, not as a stuck consequence - without intent', async () => {
    const { mirrorId, reviewId } = await pendingReview('comment-only', { number: 103 })
    await approve(reviewId)
    const kinds = (await graph.listDirectives(undefined, TEAM, 200))
      .filter((d) => d.objectId === mirrorId)
      .map((d) => d.kind)
    expect(kinds).toEqual(['github-comment'])

    // The stand-down is a SUCCESS. If it dead-lettered, every ordinary approval
    // would leave an attention item behind.
    const view = await attention.attentionView(TEAM)
    expect(view.items.filter((i) => i.objectId === mirrorId)).toEqual([])
    const actions = await graph.listPendingActions(undefined, { objectId: reviewId })
    expect(actions).toEqual([])
  })

  it('queues a github-merge alongside the comment when intent is declared', async () => {
    const { mirrorId, reviewId } = await pendingReview('merge-intent', { number: 104, mergeIntent: true })
    await approve(reviewId)
    const rows = (await graph.listDirectives(undefined, TEAM, 200)).filter((d) => d.objectId === mirrorId)
    expect(rows.map((d) => d.kind).sort()).toEqual(['github-comment', 'github-merge'])
    const merge = rows.find((d) => d.kind === 'github-merge')!
    expect((merge.payload as Record<string, unknown>).method).toBe('squash')
    expect(merge.approvalEvent).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 4 - two agents claiming at once take DISJOINT work
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: concurrent claims never hand the same work order to two agents', () => {
  it('splits the queue rather than duplicating it', async () => {
    const a = await pendingReview('race-a', { number: 105 })
    const b = await pendingReview('race-b', { number: 106 })
    await approve(a.reviewId)
    await approve(b.reviewId)

    const [first, second] = await Promise.all([
      channel.claimDirectives({ now: NOW, agent: 'agent-1', teamId: TEAM }),
      channel.claimDirectives({ now: NOW, agent: 'agent-2', teamId: TEAM }),
    ])
    const ids = [...first.directives.map((d) => d.id), ...second.directives.map((d) => d.id)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 5 - the lease: a dead agent's work comes back, and then gives up loudly
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an abandoned claim is recovered, and eventually surfaces', () => {
  it('returns an expired lease to pending, then FAILS it into Attention past the budget', async () => {
    await settleQueue()
    const { mirrorId, reviewId } = await pendingReview('lease', { number: 107 })
    await approve(reviewId)
    const id = (await graph.listDirectives(undefined, TEAM, 200)).find((d) => d.objectId === mirrorId)!.id

    // Claim it and then vanish. The row sits `claimed` with a lease nobody will
    // ever extend - which is what a laptop closing mid-effect looks like.
    const claimed = await channel.claimDirectives({ now: NOW, agent: 'agent-doomed', teamId: TEAM })
    expect(claimed.directives.some((d) => d.id === id)).toBe(true)
    expect((await graph.getDirective(undefined, id))!.state).toBe('claimed')

    // A poll at the SAME instant recovers nothing: the lease is still live, and
    // re-running work a possibly-alive agent holds would be the wrong recovery.
    const tooSoon = await channel.claimDirectives({ now: NOW, agent: 'agent-next', teamId: TEAM })
    expect(tooSoon.requeued).toBe(0)
    expect(tooSoon.directives.some((d) => d.id === id)).toBe(false)

    // Once the lease has passed, the work comes back - to whoever polls.
    const recovered = await channel.claimDirectives({ now: LATER, agent: 'agent-next', teamId: TEAM })
    expect(recovered.requeued).toBeGreaterThanOrEqual(1)
    expect(recovered.directives.some((d) => d.id === id)).toBe(true)
    expect((await graph.getDirective(undefined, id))!.attempts).toBe(2)

    // Keep vanishing, each time a lease later. The attempt budget is what turns
    // "recoverable" into "somebody needs to look at this" instead of an infinite
    // quiet retry - and note the clock has to MOVE for that to happen, which is
    // the honest model: a lease that has not expired is not a dead agent.
    for (const [i, t] of LEASE_CYCLE.entries()) {
      await channel.claimDirectives({ now: t, agent: `agent-doomed-${i}`, teamId: TEAM })
    }
    const dead = (await graph.getDirective(undefined, id))!
    expect(dead.state).toBe('failed')
    expect(dead.refusalCode).toBe('LEASE_EXPIRED')

    const view = await attention.attentionView(TEAM)
    const item = view.items.find((i) => i.ref === id)
    expect(item?.kind).toBe('directive-failed')
    expect(item?.reason).toBe('LEASE_EXPIRED')
    // An agent that went away IS worth another go once one is back.
    expect(item?.retryable).toBe(true)

    // And the human retry puts it back in the queue without acknowledging it, so
    // a second failure returns here rather than being silenced by the retry.
    const retried = await attention.resolveAttention({
      teamId: TEAM,
      kind: 'directive-failed',
      ref: id,
      verb: 'retry',
      now: AFTER_CYCLE,
      userId: USER,
    })
    expect(retried.ok).toBe(true)
    const requeued = (await graph.getDirective(undefined, id))!
    expect(requeued.state).toBe('pending')
    expect(requeued.attempts).toBe(0)
    expect((await attention.attentionView(TEAM)).items.some((i) => i.ref === id)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 6 - a zombie's report cannot overwrite its successor's outcome
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a report from a reclaimed holder changes nothing', () => {
  it('tells the late agent it lost the lease instead of accepting the outcome', async () => {
    await settleQueue()
    const { mirrorId, reviewId } = await pendingReview('zombie', { number: 108 })
    await approve(reviewId)
    const id = (await graph.listDirectives(undefined, TEAM, 200)).find((d) => d.objectId === mirrorId)!.id

    await channel.claimDirectives({ now: NOW, agent: 'agent-slow', teamId: TEAM })
    // The lease expires and somebody else takes the work.
    await channel.claimDirectives({ now: LATER, agent: 'agent-fast', teamId: TEAM })
    await channel.reportDirective({
      now: LATER,
      agent: 'agent-fast',
      id,
      ok: true,
      result: { detail: 'the effect that really happened' },
    })

    const late = await channel.reportDirective({
      now: LATER,
      agent: 'agent-slow',
      id,
      ok: false,
      refusalCode: 'AGENT_ERROR',
      error: 'I woke up an hour later',
    })
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.code).toBe('LEASE_LOST')
    const row = (await graph.getDirective(undefined, id))!
    expect(row.state).toBe('done')
    expect((row.result as Record<string, unknown>).detail).toBe('the effect that really happened')

    // A heartbeat from the same zombie is refused for the same reason.
    const beat = await channel.heartbeatDirective({ now: LATER, agent: 'agent-slow', id })
    expect(beat.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 7 - a guard refusal is terminal, visible, and offers no losing button
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a guard refusal reported by the agent becomes a non-retryable attention item', () => {
  it('records the typed reason and refuses to re-queue it', async () => {
    await settleQueue()
    const { mirrorId, reviewId } = await pendingReview('guard', { number: 109, mergeIntent: true })
    await approve(reviewId)
    const merge = (await graph.listDirectives(undefined, TEAM, 200)).find(
      (d) => d.objectId === mirrorId && d.kind === 'github-merge',
    )!

    await channel.claimDirectives({ now: NOW, agent: 'agent-guarded', teamId: TEAM })
    await channel.reportDirective({
      now: NOW,
      agent: 'agent-guarded',
      id: merge.id,
      ok: false,
      refusalCode: 'DEFAULT_BRANCH_REFUSED',
      error: 'this pull request targets "main", the repository\'s DEFAULT branch',
    })

    const row = (await graph.getDirective(undefined, merge.id))!
    expect(row.state).toBe('failed')
    expect(row.refusalCode).toBe('DEFAULT_BRANCH_REFUSED')

    const item = (await attention.attentionView(TEAM)).items.find((i) => i.ref === merge.id)!
    expect(item.kind).toBe('directive-failed')
    expect(item.title).toContain('acme/widgets/pull/109')
    expect(item.detail).toContain('DEFAULT branch')
    // NOT retryable: a branch does not stop being the default by being asked twice.
    expect(item.retryable).toBe(false)

    const refused = await attention.resolveAttention({
      teamId: TEAM,
      kind: 'directive-failed',
      ref: merge.id,
      verb: 'retry',
      now: NOW,
      userId: USER,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('NOT_RETRYABLE')

    // Acknowledging DOES clear it - "seen, this is not going to happen".
    const acked = await attention.resolveAttention({
      teamId: TEAM,
      kind: 'directive-failed',
      ref: merge.id,
      verb: 'acknowledge',
      now: NOW,
      userId: USER,
    })
    expect(acked.ok).toBe(true)
    expect((await attention.attentionView(TEAM)).items.some((i) => i.ref === merge.id)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 8 - the ceiling: a non-human approval never reaches a machine
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an outward action without a HUMAN approval never becomes a directive', () => {
  it('refuses the transition outright when a rule tries to run the verdict', async () => {
    const { reviewId } = await pendingReview('rule-verdict', { number: 110 })
    const r = await at.applyTransition({
      objectId: reviewId,
      transition: 'approve',
      actor: { entrance: 'rule', actorId: 'rule-autopilot' },
      now: NOW,
    })
    expect(r.ok).toBe(false)
    // The GATE guard fires first - a gate state's exit is a human's - and either
    // way nothing outward was enqueued, which is the property that matters.
    if (!r.ok) expect(['GATE_REQUIRES_HUMAN', 'APPROVAL_REQUIRED']).toContain(r.code)
    expect((await graph.listDirectives(undefined, TEAM, 200)).some((d) => d.targetExternalId.endsWith('/110'))).toBe(false)
  })

  it('dead-letters an R3 row whose approval resolves to a rule, writing no directive', async () => {
    // The schema CHECK is satisfied (the column is non-null) and the handler
    // exists now - so this is exactly the gap the EXECUTION-TIME re-check closes.
    const carrier = 'ev-effects-rule-approval'
    await graph.appendEvent(undefined, {
      id: carrier,
      teamId: TEAM,
      kind: 'rule-decision',
      origin: 'organic',
      entrance: 'rule',
      actorId: 'rule-autopilot',
      ts: NOW,
    })
    const { object: mirror } = await graph.getOrCreateMirror(undefined, {
      teamId: TEAM,
      externalSource: 'github',
      externalId: 'acme/widgets/pull/111',
      type: 'pull-request',
      status: 'open',
      title: 'PR #111',
      payload: { repo: 'acme/widgets', number: 111, state: 'open', merged: false, checks: 'none', draft: false },
      now: NOW,
    })
    const [action] = await graph.enqueueActions(undefined, {
      eventId: carrier,
      teamId: TEAM,
      objectId: mirror.id,
      actions: [{ kind: 'external-comment', payload: { via: 'self' }, approvalEvent: carrier }],
      now: NOW,
    })

    await exec.runOnce({ now: NOW, teamId: TEAM })
    const row = (await graph.getAction(undefined, action!.id))!
    expect(row.state).toBe('dead-letter')
    expect(row.refusalCode).toBe('APPROVAL_NOT_HUMAN')
    expect(await graph.getDirective(undefined, action!.id)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 9 - the bearer: an unconfigured channel admits nobody
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: the machine agent channel fails closed', () => {
  it('admits nobody when no token is configured', () => {
    delete process.env.LOOPANY_AGENT_TOKEN
    expect(cfg.agentChannelConfigured()).toBe(false)
    expect(cfg.agentTokenMatches('Bearer anything')).toBe(false)
    // Not even an empty bearer, which is the shape a misconfigured agent sends.
    expect(cfg.agentTokenMatches('Bearer ')).toBe(false)
    expect(cfg.agentTokenMatches(null)).toBe(false)
  })

  it('admits the configured token, in either bearer form, and nothing else', () => {
    process.env.LOOPANY_AGENT_TOKEN = 'shh-probe-secret'
    expect(cfg.agentTokenMatches('Bearer shh-probe-secret')).toBe(true)
    expect(cfg.agentTokenMatches('shh-probe-secret')).toBe(true)
    expect(cfg.agentTokenMatches('Bearer shh-probe-secreT')).toBe(false)
    expect(cfg.agentTokenMatches('Bearer shh')).toBe(false)
    delete process.env.LOOPANY_AGENT_TOKEN
  })
})
