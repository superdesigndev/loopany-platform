import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PROBE SUITE — the OUTBOX EXECUTOR, over a REAL pglite database (migrations
 * applied in `beforeAll`, so this file is also the proof that migration 0004
 * applies cleanly on a fresh DB).
 *
 * Each block is one property the design names as load-bearing, written the way a
 * production failure would find it rather than the way the code is structured:
 *
 *   1. exactly-once effect    the same action executed twice ⇒ ONE effect (both handlers)
 *   2. crash recovery         kill mid-batch, restart ⇒ no duplicates, no losses
 *   3. approval ceiling       R3 without a HUMAN approval event ⇒ refused + dead-letter
 *                             + visible in the attention list
 *   4. chain budget           a rule chain that spawns rules stops at the budget,
 *                             with an attention item
 *   5. dead-letter surfacing  retries exhausted ⇒ dead-letter in Attention, retryable
 *   6. attested close         a task with an open obligation refuses to finish, and
 *                             the refusal becomes an attention item
 *
 * Every probe passes `now` explicitly - the executor never reads a clock - so
 * "kill it mid-batch" is a real assertion rather than a timing hope.
 */

let tmp: string
let dbmod: typeof import('../../db/index.js')
let schema: typeof import('../../db/graph-schema.js')
let graph: typeof import('../../db/graphStore.js')
let at: typeof import('../applyTransition.js')
let exec: typeof import('./executor.js')
let handlers: typeof import('./handlers.js')
let attention: typeof import('./attention.js')
let ids: typeof import('../ids.js')

const TEAM = 'team-outbox'
const NOW = '2026-07-30T09:00:00.000Z'
/** Far enough past `NOW` that a scheduled retry is due, without touching a real clock. */
const LATER = '2026-07-30T12:00:00.000Z'

/**
 * A doc-like content object plus a review type around it - the minimum shape the
 * `enqueue-review` handler needs. `notify-source` is a task whose one transition
 * declares BOTH v1 handlers, so a single transition exercises the pair.
 */
function sourceSpec(): import('../types.js').TypeSpec {
  return {
    states: ['idle', 'handed-off'],
    initialState: 'idle',
    transitions: [
      {
        name: 'hand-off',
        from: ['idle'],
        to: 'handed-off',
        actions: [
          { kind: 'notify', payload: { channel: 'inbox', title: 'Something needs a look', body: 'from the probe' } },
          {
            kind: 'enqueue-review',
            payload: { queue: 'probe', review: 'probe-review', via: 'produces', select: { type: 'probe-doc' } },
          },
        ],
      },
    ],
  }
}

function reviewSpec(): import('../types.js').TypeSpec {
  return {
    states: ['queued', 'awaiting-verdict', 'approved'],
    initialState: 'queued',
    gateStates: ['awaiting-verdict'],
    terminalStates: ['approved'],
    transitions: [
      {
        name: 'ready',
        from: ['queued'],
        to: 'awaiting-verdict',
        opens: [{ key: 'probe-verdict', class: 'human-verdict', label: 'Probe verdict' }],
      },
      {
        name: 'approve',
        from: ['awaiting-verdict'],
        to: 'approved',
        entrance: 'human',
        closes: ['probe-verdict'],
        actions: [{ kind: 'update-fields', payload: { via: 'tracks', set: { published: true } } }],
      },
    ],
  }
}

/** A content type with no state machine - `applyTransition` refuses it, which is
 *  the point: the REVIEW carries the lifecycle, the content does not. */
function docSpec(): import('../types.js').TypeSpec {
  return { states: ['current'], initialState: 'current', transitions: [], fields: { published: 'boolean' } }
}

/**
 * The CHAIN BOMB type. `relay` is a rule-entrance self-transition whose
 * `enqueue-review` creates a fresh relay task and runs `relay` on it - so each
 * generation is one more link in a real transition→action→transition chain. This
 * is what makes the budget probe genuine: the depth is plumbed by the engine, not
 * fabricated by the test.
 */
function relaySpec(): import('../types.js').TypeSpec {
  return {
    states: ['queued', 'relaying'],
    initialState: 'queued',
    gateStates: ['relaying'],
    transitions: [
      {
        name: 'relay',
        from: ['queued'],
        to: 'relaying',
        opens: [{ key: 'relay-verdict', class: 'human-verdict', label: 'Relay' }],
        // Its own gate-opening transition spawns the NEXT relay, pointed at the
        // same content - a self-feeding rule chain, which is exactly the runaway
        // the chain budget exists to stop.
        actions: [{ kind: 'enqueue-review', payload: { queue: 'relay', review: 'relay', via: 'tracks' } }],
      },
    ],
  }
}

/** An R3 outward action needs an approval event id by schema CHECK. This is the
 *  minimum that satisfies the CHECK while being the WRONG kind of approval. */
async function nonHumanApproval(label: string): Promise<string> {
  const id = `ev-rule-approval-${label}`
  await graph.appendEvent(undefined, {
    id,
    teamId: TEAM,
    kind: 'rule-decision',
    origin: 'organic',
    entrance: 'rule', // ← not a human. The whole point of the probe.
    actorId: 'rule-autopilot',
    ts: NOW,
  })
  return id
}

/**
 * FORCE the at-least-once boundary. A crash between a handler's effect and its
 * stamp is indistinguishable from a crash before it, so the row is left claimable
 * with its effect already applied. There is no production verb for "un-stamp a
 * delivered action" and there should not be one, so the probe writes the row
 * directly - the point being that the SECOND execution goes through the real
 * executor with no idea it is a replay.
 */
async function replayRows(rowIds: string[]): Promise<void> {
  const { inArray } = await import('drizzle-orm')
  await dbmod.db
    .update(schema.outboxActions)
    .set({ state: 'pending', deliveredAt: null, claimedAt: null, claimedBy: null, nextAttemptAt: null })
    .where(inArray(schema.outboxActions.id, rowIds))
}

async function armType(name: string, spec: import('../types.js').TypeSpec, archetype: 'task' | 'doc' = 'task') {
  await graph.proposeTypeVersion(undefined, {
    teamId: TEAM,
    name,
    archetype,
    version: 1,
    spec,
    rationale: `outbox probe type ${name}`,
    now: NOW,
  })
  await graph.armTypeVersion(undefined, { teamId: TEAM, name, version: 1, now: NOW })
}

/** A source task that `produces` one unpublished doc - the pair the review
 *  handler fans out over. */
async function newSourceWithDoc(suffix: string) {
  const source = await graph.createObject(undefined, {
    teamId: TEAM,
    archetype: 'task',
    type: 'probe-source',
    status: 'idle',
    title: `source ${suffix}`,
    now: NOW,
  })
  const doc = await graph.createObject(undefined, {
    teamId: TEAM,
    archetype: 'doc',
    type: 'probe-doc',
    status: 'current',
    title: `doc ${suffix}`,
    payload: { published: false },
    now: NOW,
  })
  await graph.upsertEdge(undefined, { teamId: TEAM, kind: 'produces', srcId: source.id, dstId: doc.id, now: NOW })
  return { source, doc }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-outbox-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  schema = await import('../../db/graph-schema.js')
  graph = await import('../../db/graphStore.js')
  at = await import('../applyTransition.js')
  exec = await import('./executor.js')
  handlers = await import('./handlers.js')
  attention = await import('./attention.js')
  ids = await import('../ids.js')

  await graph.seedBuiltinTypes(undefined, TEAM, NOW)
  await armType('probe-source', sourceSpec())
  await armType('probe-review', reviewSpec())
  await armType('probe-doc', docSpec(), 'doc')
  await armType('relay', relaySpec())
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1 - exactly one effect, however many times the row is executed
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: the same action executed twice produces exactly ONE effect', () => {
  it('holds for notify AND enqueue-review', async () => {
    const { source, doc } = await newSourceWithDoc('once')
    const out = await at.applyTransition({
      objectId: source.id,
      transition: 'hand-off',
      actor: { entrance: 'agent-run', actorId: 'run-probe-1' },
      now: NOW,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.actions.map((a) => a.kind)).toEqual(['notify', 'enqueue-review'])

    const first = await exec.runOnce({ now: NOW, teamId: TEAM })
    expect(first.done).toBe(2)
    expect(first.deadLettered).toBe(0)

    const notifyId = ids.outboxActionId(out.event.id, 0)
    const reviewId = ids.outboxActionId(out.event.id, 1)
    const shepherdId = ids.reviewObjectId(reviewId, doc.id)

    const afterFirst = await graph.listNotifications(undefined, TEAM, 100)
    expect(afterFirst.filter((n) => n.id === notifyId)).toHaveLength(1)
    const shepherd = await graph.getObject(undefined, shepherdId)
    expect(shepherd?.status).toBe('awaiting-verdict')
    expect(shepherd?.type).toBe('probe-review')

    // FORCE the at-least-once boundary: put both rows back to `pending` exactly as
    // a crash between the effect and the stamp would have left them, then drain
    // again. Nothing about the second pass knows it is a replay.
    await replayRows([notifyId, reviewId])
    const second = await exec.runOnce({ now: NOW, teamId: TEAM })
    expect(second.claimed).toBe(2)
    expect(second.done).toBe(2)

    // ONE notification, ONE shepherd, ONE gate obligation. Identity did the work.
    expect((await graph.listNotifications(undefined, TEAM, 100)).filter((n) => n.id === notifyId)).toHaveLength(1)
    const reviews = (await graph.listObjects(undefined, TEAM, { type: 'probe-review' })).filter(
      (o) => (o.payload as Record<string, unknown> | null)?.reviews === doc.id,
    )
    expect(reviews).toHaveLength(1)
    expect(await graph.countOpenObligations(undefined, shepherdId)).toBe(1)
  })

  it('holds for update-fields: the verdict publishes the doc once', async () => {
    const { source, doc } = await newSourceWithDoc('publish')
    const handoff = await at.applyTransition({
      objectId: source.id,
      transition: 'hand-off',
      actor: { entrance: 'agent-run', actorId: 'run-probe-2' },
      now: NOW,
    })
    expect(handoff.ok).toBe(true)
    if (!handoff.ok) return
    await exec.runOnce({ now: NOW, teamId: TEAM })

    const shepherdId = ids.reviewObjectId(ids.outboxActionId(handoff.event.id, 1), doc.id)
    const verdict = await at.applyTransition({
      objectId: shepherdId,
      transition: 'approve',
      actor: { entrance: 'human', actorId: 'u-probe' },
      now: NOW,
    })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return

    const fieldWrite = ids.outboxActionId(verdict.event.id, 0)
    await exec.runOnce({ now: NOW, teamId: TEAM })
    expect(((await graph.getObject(undefined, doc.id))!.payload as Record<string, unknown>).published).toBe(true)

    // Re-execute. A field write is naturally idempotent, and the event it records
    // is derived from the action id - so the audit trail does not double either.
    await replayRows([fieldWrite])
    await exec.runOnce({ now: NOW, teamId: TEAM })
    const written = (await graph.listObjectEvents(undefined, doc.id)).filter((e) => e.kind === 'fields-written')
    expect(written).toHaveLength(1)
    expect(((await graph.getObject(undefined, doc.id))!.payload as Record<string, unknown>).published).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2 - kill mid-batch, restart: no duplicates, no losses
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an executor killed mid-batch loses nothing and duplicates nothing', () => {
  it('recovers the crashed claim and lands each effect exactly once', async () => {
    const { source, doc } = await newSourceWithDoc('crash')
    const out = await at.applyTransition({
      objectId: source.id,
      transition: 'hand-off',
      actor: { entrance: 'agent-run', actorId: 'run-probe-3' },
      now: NOW,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const notifyId = ids.outboxActionId(out.event.id, 0)
    const reviewId = ids.outboxActionId(out.event.id, 1)

    // THE KILL. Claim the batch, then die before any handler runs - which is what
    // the rows look like when the process is SIGKILLed halfway through: `executing`,
    // one attempt burned, no effect.
    const claimed = await graph.claimActions(undefined, {
      limit: 25,
      now: NOW,
      owner: 'exec-doomed',
      staleBefore: '2026-07-30T08:00:00.000Z',
      teamId: TEAM,
    })
    expect(claimed.map((a) => a.id).sort()).toEqual([notifyId, reviewId].sort())
    expect(claimed.every((a) => a.state === 'executing')).toBe(true)
    expect(await graph.listNotifications(undefined, TEAM, 200).then((n) => n.some((x) => x.id === notifyId))).toBe(false)

    // A restart at the SAME instant claims nothing: the rows are held, and re-running
    // them immediately would be racing a process that might still be alive.
    const tooSoon = await exec.runOnce({ now: NOW, teamId: TEAM })
    expect(tooSoon.claimed).toBe(0)

    // Once the claim is stale (the crashed executor is provably gone), the next pass
    // picks the work up. NOTHING WAS LOST - this is the assertion that matters.
    const recovered = await exec.runOnce({ now: LATER, teamId: TEAM })
    expect(recovered.claimed).toBe(2)
    expect(recovered.done).toBe(2)

    // And nothing was duplicated: one notification, one shepherd.
    expect((await graph.listNotifications(undefined, TEAM, 200)).filter((n) => n.id === notifyId)).toHaveLength(1)
    const shepherdId = ids.reviewObjectId(reviewId, doc.id)
    expect((await graph.getObject(undefined, shepherdId))?.status).toBe('awaiting-verdict')
    // Attempts is 2 (one burned by the crash, one by the recovery), which is the
    // honest record - and it is why a handler that kills the process cannot retry
    // forever.
    expect((await graph.getAction(undefined, notifyId))!.attempts).toBe(2)
    expect((await graph.getAction(undefined, notifyId))!.state).toBe('done')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3 - the approval ceiling, re-checked at execution time
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an R3 action without a HUMAN approval is refused and dead-lettered', () => {
  it('refuses a rule-entrance approval, dead-letters it, and shows it in Attention', async () => {
    const approval = await nonHumanApproval('r3')
    const holder = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'task',
      type: 'probe-source',
      status: 'idle',
      title: 'outward holder',
      now: NOW,
    })
    // The schema CHECK is satisfied: `approval_event` is non-null. That is exactly
    // the gap the execution-time re-check exists to close - a non-null column is
    // not an approval.
    const [action] = await graph.enqueueActions(undefined, {
      eventId: approval,
      teamId: TEAM,
      objectId: holder.id,
      actions: [{ kind: 'external-comment', approvalEvent: approval }],
      now: NOW,
    })

    const r = await exec.runOnce({ now: NOW, teamId: TEAM })
    expect(r.deadLettered).toBe(1)
    const row = (await graph.getAction(undefined, action!.id))!
    expect(row.state).toBe('dead-letter')
    expect(row.refusalCode).toBe('APPROVAL_NOT_HUMAN')
    expect(row.deliveredAt).toBeNull()

    const view = await attention.attentionView(TEAM)
    const item = view.items.find((i) => i.ref === action!.id)
    expect(item?.kind).toBe('dead-letter')
    expect(item?.reason).toBe('APPROVAL_NOT_HUMAN')
    // NOT retryable: no amount of waiting turns a rule into a person.
    expect(item?.retryable).toBe(false)
  })

  it('refuses an approval event id that names no row at all', async () => {
    const holder = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'task',
      type: 'probe-source',
      status: 'idle',
      title: 'phantom approval holder',
      now: NOW,
    })
    const carrier = 'ev-phantom-carrier'
    await graph.appendEvent(undefined, {
      id: carrier,
      teamId: TEAM,
      kind: 'rule-decision',
      origin: 'organic',
      entrance: 'rule',
      actorId: 'rule-autopilot',
      ts: NOW,
    })
    const [action] = await graph.enqueueActions(undefined, {
      eventId: carrier,
      teamId: TEAM,
      objectId: holder.id,
      actions: [{ kind: 'external-close', approvalEvent: 'ev-does-not-exist' }],
      now: NOW,
    })

    await exec.runOnce({ now: NOW, teamId: TEAM })
    const row = (await graph.getAction(undefined, action!.id))!
    expect(row.state).toBe('dead-letter')
    expect(row.refusalCode).toBe('APPROVAL_MISSING')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 4 - the chain-depth bomb stops at the budget
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a rule chain that spawns rules stops at the chain budget', () => {
  it('walks depth 1..budget, then refuses with an attention item - and the depth was plumbed by the engine', async () => {
    const content = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'doc',
      type: 'probe-doc',
      status: 'current',
      title: 'bomb target',
      payload: { published: false },
      now: NOW,
    })
    const first = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'task',
      type: 'relay',
      status: 'queued',
      title: 'relay 0',
      now: NOW,
    })
    await graph.upsertEdge(undefined, { teamId: TEAM, kind: 'tracks', srcId: first.id, dstId: content.id, now: NOW })

    const start = await at.applyTransition({
      objectId: first.id,
      transition: 'relay',
      actor: { entrance: 'rule', actorId: 'rule-bomb' },
      now: NOW,
    })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    // The FIRST link: a transition at depth 0 enqueues its action at depth 1.
    expect(start.actions[0]!.chainDepth).toBe(1)

    // Let it run. Each pass creates the next relay and enqueues the next action one
    // level deeper, until a row lands past the budget and is refused.
    const drained = await exec.drainOutbox({ now: NOW, teamId: TEAM, maxPasses: 40 })
    expect(drained.deadLettered).toBeGreaterThan(0)

    const dead = (await graph.listDeadLetters(undefined, TEAM)).filter(
      (a) => a.refusalCode === 'CHAIN_BUDGET_EXCEEDED',
    )
    expect(dead).toHaveLength(1)
    // The chain got exactly one step past the budget and no further - which is the
    // proof the depth was incremented at every rule-entrance hop.
    expect(dead[0]!.chainDepth).toBe(at.DEFAULT_CHAIN_BUDGET + 1)

    const view = await attention.attentionView(TEAM)
    expect(view.items.some((i) => i.ref === dead[0]!.id && i.reason === 'CHAIN_BUDGET_EXCEEDED')).toBe(true)

    // BOUNDED, not merely slowed: the relays created stop at the budget, so the
    // bomb produced a finite graph.
    const relays = await graph.listObjects(undefined, TEAM, { type: 'relay' })
    expect(relays.length).toBeLessThanOrEqual(at.DEFAULT_CHAIN_BUDGET + 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 5 - retries exhausted ⇒ dead-letter in Attention, never a silent drop
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a handler that keeps failing dead-letters instead of vanishing', () => {
  it('burns the bounded retry budget, then surfaces as a RETRYABLE attention item', async () => {
    const holder = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'task',
      type: 'probe-source',
      status: 'idle',
      title: 'flaky notify holder',
      now: NOW,
    })
    const carrier = 'ev-flaky-carrier'
    await graph.appendEvent(undefined, {
      id: carrier,
      teamId: TEAM,
      kind: 'rule-decision',
      origin: 'organic',
      entrance: 'rule',
      actorId: 'rule-probe',
      ts: NOW,
    })
    const [action] = await graph.enqueueActions(undefined, {
      eventId: carrier,
      teamId: TEAM,
      objectId: holder.id,
      actions: [{ kind: 'set-follow-up-date', payload: {} }],
      now: NOW,
    })

    // A handler that always throws - the shape of a transient dependency that is
    // actually broken. Registered through the test seam so the REAL executor drives
    // the real ladder.
    let calls = 0
    const restore = handlers.registerHandler('set-follow-up-date', async () => {
      calls++
      throw new Error('dependency down')
    })
    try {
      // Each pass must be at a LATER instant than the last backoff, or the row is
      // (correctly) not yet due - which is itself the assertion that backoff works.
      let when = Date.parse(NOW)
      for (let i = 0; i < exec.MAX_ATTEMPTS; i++) {
        const r = await exec.runOnce({ now: new Date(when).toISOString(), teamId: TEAM })
        expect(r.claimed).toBeGreaterThanOrEqual(1)
        const row = (await graph.getAction(undefined, action!.id))!
        if (i < exec.MAX_ATTEMPTS - 1) {
          expect(row.state).toBe('failed')
          expect(row.nextAttemptAt).not.toBeNull()
          when = Date.parse(row.nextAttemptAt!)
        } else {
          expect(row.state).toBe('dead-letter')
        }
      }
    } finally {
      restore()
    }
    expect(calls).toBe(exec.MAX_ATTEMPTS)

    const row = (await graph.getAction(undefined, action!.id))!
    expect(row.refusalCode).toBe('RETRIES_EXHAUSTED')
    expect(row.lastError).toContain('dependency down')
    expect(row.deliveredAt).toBeNull()

    const view = await attention.attentionView(TEAM)
    const item = view.items.find((i) => i.ref === action!.id)
    expect(item?.kind).toBe('dead-letter')
    // Transient exhaustion IS worth another go, so this one offers a retry.
    expect(item?.retryable).toBe(true)

    // A human retry re-queues it WITHOUT acknowledging - so if it fails again it
    // comes back. That is the property an "acknowledge on retry" would destroy.
    const resolved = await attention.resolveAttention({
      teamId: TEAM,
      kind: 'dead-letter',
      ref: action!.id,
      verb: 'retry',
      now: LATER,
      userId: 'u-probe',
    })
    expect(resolved.ok).toBe(true)
    const requeued = (await graph.getAction(undefined, action!.id))!
    expect(requeued.state).toBe('pending')
    expect(requeued.attempts).toBe(0)
    expect((await attention.attentionView(TEAM)).items.some((i) => i.ref === action!.id)).toBe(false)

    // Let it fail all the way down again and confirm it RE-SURFACES.
    const restore2 = handlers.registerHandler('set-follow-up-date', async () => {
      throw new Error('still down')
    })
    try {
      let when = Date.parse(LATER)
      for (let i = 0; i < exec.MAX_ATTEMPTS; i++) {
        await exec.runOnce({ now: new Date(when).toISOString(), teamId: TEAM })
        const row2 = (await graph.getAction(undefined, action!.id))!
        if (row2.nextAttemptAt) when = Date.parse(row2.nextAttemptAt)
      }
    } finally {
      restore2()
    }
    expect((await graph.getAction(undefined, action!.id))!.state).toBe('dead-letter')
    expect((await attention.attentionView(TEAM)).items.some((i) => i.ref === action!.id)).toBe(true)

    // Acknowledging DOES clear it, and does so with a human-entrance event.
    const ack = await attention.resolveAttention({
      teamId: TEAM,
      kind: 'dead-letter',
      ref: action!.id,
      verb: 'acknowledge',
      now: LATER,
      userId: 'u-probe',
    })
    expect(ack.ok).toBe(true)
    if (!ack.ok) return
    const ackEvent = (await graph.getEvent(undefined, ack.eventId))!
    expect(ackEvent.entrance).toBe('human')
    expect(ackEvent.actorId).toBe('u-probe')
    expect((await attention.attentionView(TEAM)).items.some((i) => i.ref === action!.id)).toBe(false)
    // The row itself is untouched: acknowledging is a decision about the item, not
    // a rewrite of what happened to it.
    expect((await graph.getAction(undefined, action!.id))!.state).toBe('dead-letter')
  })

  it('dead-letters a kind with no handler rather than marking it done', async () => {
    const holder = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'task',
      type: 'probe-source',
      status: 'idle',
      title: 'unhandled holder',
      now: NOW,
    })
    const carrier = 'ev-unhandled-carrier'
    await graph.appendEvent(undefined, {
      id: carrier,
      teamId: TEAM,
      kind: 'rule-decision',
      origin: 'organic',
      entrance: 'rule',
      actorId: 'rule-probe',
      ts: NOW,
    })
    const [action] = await graph.enqueueActions(undefined, {
      eventId: carrier,
      teamId: TEAM,
      objectId: holder.id,
      // `set-follow-up-date` is an R1 kind this build declares and does NOT
      // implement - which is the point: an unimplemented consequence must stay
      // visible. (This probe used `register-watch` until the sensing unit gave it a
      // handler; the assertion is about the ABSENCE of a handler, so it moved to a
      // kind that still has none rather than being weakened.)
      actions: [{ kind: 'set-follow-up-date', payload: {} }],
      now: NOW,
    })
    await exec.runOnce({ now: NOW, teamId: TEAM })
    const row = (await graph.getAction(undefined, action!.id))!
    expect(row.state).toBe('dead-letter')
    expect(row.refusalCode).toBe('NO_HANDLER')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 6 - the attested close
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: attested close refuses to finish a task that still owes something', () => {
  it('refuses on an open obligation and records the refusal as an attention item', async () => {
    const { source, doc } = await newSourceWithDoc('attest')
    const handoff = await at.applyTransition({
      objectId: source.id,
      transition: 'hand-off',
      actor: { entrance: 'agent-run', actorId: 'run-probe-attest' },
      now: NOW,
    })
    expect(handoff.ok).toBe(true)
    if (!handoff.ok) return
    await exec.runOnce({ now: NOW, teamId: TEAM })
    const shepherdId = ids.reviewObjectId(ids.outboxActionId(handoff.event.id, 1), doc.id)

    // `approve` is terminal AND closes the obligation, so it is legal. Plant a
    // SECOND, independent obligation the transition does not close - the "an object
    // can hold several waits at once" case a status column could never represent.
    await graph.openObligation(undefined, {
      objectId: shepherdId,
      key: 'independent-wait',
      teamId: TEAM,
      class: 'human-verdict',
      label: 'something else entirely',
      openedByEvent: handoff.event.id,
      now: NOW,
    })

    const refused = await at.applyTransition({
      objectId: shepherdId,
      transition: 'approve',
      actor: { entrance: 'human', actorId: 'u-probe' },
      now: NOW,
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('OPEN_OBLIGATIONS')
    // The object did NOT move: a refused close is not a partial close.
    expect((await graph.getObject(undefined, shepherdId))!.status).toBe('awaiting-verdict')

    const view = await attention.attentionView(TEAM)
    const item = view.items.find((i) => i.kind === 'close-refused' && i.objectId === shepherdId)
    expect(item).toBeDefined()
    expect(item!.detail).toContain('independent-wait')
    expect(item!.retryable).toBe(false)
  })

  it('refuses while an action is still unsettled, and succeeds once the queue is clear', async () => {
    const { source, doc } = await newSourceWithDoc('unsettled')
    const handoff = await at.applyTransition({
      objectId: source.id,
      transition: 'hand-off',
      actor: { entrance: 'agent-run', actorId: 'run-probe-unsettled' },
      now: NOW,
    })
    expect(handoff.ok).toBe(true)
    if (!handoff.ok) return
    await exec.runOnce({ now: NOW, teamId: TEAM })
    const shepherdId = ids.reviewObjectId(ids.outboxActionId(handoff.event.id, 1), doc.id)

    // Plant an UNSETTLED action on the shepherd itself. The gate's own
    // `enqueue-review` is already done, so this is the "a consequence is still in
    // flight" half of the attestation rather than the obligation half.
    await graph.appendEvent(undefined, {
      id: 'ev-unsettled-carrier',
      teamId: TEAM,
      kind: 'rule-decision',
      origin: 'organic',
      entrance: 'rule',
      actorId: 'rule-probe',
      ts: NOW,
    })
    const [pending] = await graph.enqueueActions(undefined, {
      eventId: 'ev-unsettled-carrier',
      teamId: TEAM,
      objectId: shepherdId,
      actions: [{ kind: 'notify', payload: { channel: 'inbox', title: 'in flight' } }],
      now: NOW,
    })

    const refused = await at.applyTransition({
      objectId: shepherdId,
      transition: 'approve',
      actor: { entrance: 'human', actorId: 'u-probe' },
      now: NOW,
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('PENDING_ACTIONS')
    expect(
      (await attention.attentionView(TEAM)).items.some(
        (i) => i.kind === 'close-refused' && i.objectId === shepherdId && i.reason === 'PENDING_ACTIONS',
      ),
    ).toBe(true)

    // Drain the queue, then the SAME verdict lands. The attestation was a real
    // precondition, not a permanent block.
    await exec.runOnce({ now: NOW, teamId: TEAM })
    expect((await graph.getAction(undefined, pending!.id))!.state).toBe('done')
    const ok = await at.applyTransition({
      objectId: shepherdId,
      transition: 'approve',
      actor: { entrance: 'human', actorId: 'u-probe' },
      now: LATER,
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect((ok.event.payload as Record<string, unknown>).attested).toEqual({ openObligations: 0, pendingActions: 0 })
  })
})
