import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PROBE SUITE - the Graph Engineering v3 kernel invariants, over a REAL pglite
 * database (migrations applied in `beforeAll`, so this file is also the proof
 * that migration 0003 applies cleanly on a fresh DB).
 *
 * Each describe block is one invariant from the design that had to be decided at
 * SCHEMA time because it cannot be retrofitted:
 *
 *   1. dedup             a re-derived fact is one event row, at any history length
 *   2. mirror uniqueness concurrent get-or-create converges on ONE object
 *   3. payload sufficiency + provenance
 *                        a state-change event ALONE names the transition, every
 *                        changed field's {old,new}, and who/how it was entered
 *   4. gates             obligations open and close by events; the inbox is
 *                        computed opened-minus-closed
 *   5. outbox            an R3/R4 action cannot exist without an approval event
 *
 * The chokepoint-enforcement probes (direct write / patch-around-schema /
 * raw-event smuggle) ship with the enforcement branch - the mechanism (trigger
 * token vs grants) is a pending captain decision, see `applyTransition.ts`.
 */

let tmp: string
let dbmod: typeof import('../db/index.js')
let graph: typeof import('../db/graphStore.js')
let at: typeof import('./applyTransition.js')
let schema: typeof import('../db/graph-schema.js')
let T: typeof import('./types.js')

const TEAM = 'team-probe'
const NOW = '2026-07-29T09:00:00.000Z'

/** A task-family custom type exercising gates, an outward action and a terminal
 *  close - the M1 defect spine in miniature (design §11). */
function defectSpec(): import('./types.js').TypeSpec {
  return {
    states: ['reproducing', 'fixing', 'awaiting-merge', 'observing', 'closed'],
    initialState: 'reproducing',
    // A gate state's outgoing transition is executed by a HUMAN in the product
    // (design §12 item 5). Waiting for the world to reflect it is an
    // `external-wait` obligation, NOT a gate.
    gateStates: ['awaiting-merge'],
    terminalStates: ['closed'],
    transitions: [
      { name: 'fix', from: ['reproducing'], to: 'fixing' },
      {
        name: 'submit',
        from: ['fixing'],
        to: 'awaiting-merge',
        opens: [
          { key: 'merge-verdict', class: 'human-verdict', label: 'Approve the merge' },
          { key: 'pr-merged', class: 'external-wait', label: 'PR observed merged' },
        ],
        actions: [{ kind: 'notify', payload: { channel: 'inbox' } }],
      },
      {
        name: 'approve-merge',
        from: ['awaiting-merge'],
        to: 'observing',
        closes: ['merge-verdict'],
        // R3 - an outward effect. Structurally non-auto-approvable.
        actions: [{ kind: 'external-comment', payload: { body: 'merging' } }],
      },
      { name: 'observe-merged', from: ['observing'], to: 'closed', closes: ['pr-merged'] },
    ],
  }
}

async function newDefect(suffix: string) {
  const spec = defectSpec()
  return graph.createObject(undefined, {
    teamId: TEAM,
    archetype: 'task',
    type: 'defect',
    typeVersion: 1,
    status: spec.initialState,
    title: `defect ${suffix}`,
    now: NOW,
  })
}

/** An organic event standing in for a recorded human approval. */
async function approvalEvent(label: string): Promise<string> {
  const id = `ev-approval-${label}`
  await graph.appendEvent(undefined, {
    id,
    teamId: TEAM,
    kind: 'human-approval',
    origin: 'organic',
    entrance: 'human',
    actorId: 'u_captain',
    payload: { label },
    ts: NOW,
  })
  return id
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-graph-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  dbmod = await import('../db/index.js')
  await dbmod.runMigrations()
  graph = await import('../db/graphStore.js')
  at = await import('./applyTransition.js')
  schema = await import('../db/graph-schema.js')
  T = await import('./types.js')

  await graph.seedBuiltinTypes(undefined, TEAM, NOW)
  // The custom type must be PROPOSED then ARMED - arming is the only promotion.
  await graph.proposeTypeVersion(undefined, {
    teamId: TEAM,
    name: 'defect',
    archetype: 'task',
    version: 1,
    spec: defectSpec(),
    rationale: 'the M1 defect spine',
    now: NOW,
  })
  await graph.armTypeVersion(undefined, { teamId: TEAM, name: 'defect', version: 1, now: NOW })
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1 - dedup: identity, never a window
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: dedup rests on identity, never on a window', () => {
  it('derives the same external fact twice and gets exactly one event row - across a >200-event history', async () => {
    const fact = { source: 'github', entity: 'org/repo/pull/77', field: 'state', value: 'merged' }
    const id = (await import('./ids.js')).derivedEventId(fact)

    const row = {
      id,
      teamId: TEAM,
      kind: 'external-changed',
      origin: 'derived' as const,
      entrance: 'agent-run' as const,
      actorId: 'run-sense-1',
      payload: fact,
      ts: '2026-07-29T09:00:00.000Z',
    }

    const first = await graph.appendEvent(undefined, row)
    expect(first.inserted).toBe(true)

    // Bury it under a long history. A "recent N" / time-window dedup would have
    // let the re-derivation through by now - that is precisely the v2 blocker
    // this invariant replaces, so the probe has to outrun any plausible window.
    for (let i = 0; i < 250; i++) {
      const filler = { source: 'github', entity: `org/repo/pull/${i}`, field: 'state', value: 'open' }
      await graph.appendEvent(undefined, {
        id: (await import('./ids.js')).derivedEventId(filler),
        teamId: TEAM,
        kind: 'external-changed',
        origin: 'derived',
        entrance: 'agent-run',
        actorId: 'run-sense-1',
        payload: filler,
        ts: `2026-07-29T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
      })
    }
    expect(await graph.countEvents(undefined, TEAM)).toBeGreaterThan(250)

    // Re-derive the ORIGINAL fact, much later, with a different timestamp and a
    // different reporting run. Same fact ⇒ same id ⇒ still one row.
    const again = await graph.appendEvent(undefined, {
      ...row,
      actorId: 'run-sense-2',
      ts: '2026-08-30T23:59:00.000Z',
    })
    expect(again.inserted).toBe(false)
    expect(await graph.countEventsById(undefined, id)).toBe(1)
    // The FIRST derivation is the one that stands (append-only; no overwrite).
    expect(again.event.actorId).toBe('run-sense-1')
  })

  it('a re-derived TRANSITION is a no-op replay, not a second state change', async () => {
    const obj = await newDefect('replay')
    const seed = { observed: 'issue-reproduced', at: 'commit-abc' }
    const first = await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'agent-run', actorId: 'run-42' },
      now: NOW,
      derivedFrom: seed,
    })
    expect(first.ok && first.replay).toBe(false)

    const second = await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'agent-run', actorId: 'run-99' },
      now: '2026-08-01T00:00:00.000Z',
      derivedFrom: seed,
    })
    expect(second.ok).toBe(true)
    expect(second.ok && second.replay).toBe(true)

    // Exactly one status-changed event, and the status moved exactly once.
    const events = (await graph.listObjectEvents(undefined, obj.id)).filter((e) => e.kind === 'status-changed')
    expect(events).toHaveLength(1)
    expect((await graph.getObject(undefined, obj.id))!.status).toBe('fixing')
  })

  it('an ORGANIC transition is never deduped (two human verdicts are two events)', async () => {
    const obj = await newDefect('organic')
    for (const t of ['fix'] as const) {
      await at.applyTransition({
        objectId: obj.id,
        transition: t,
        actor: { entrance: 'human', actorId: 'u_alice' },
        now: NOW,
      })
    }
    const other = await newDefect('organic-2')
    await at.applyTransition({
      objectId: other.id,
      transition: 'fix',
      actor: { entrance: 'human', actorId: 'u_alice' },
      now: NOW,
    })
    const a = (await graph.listObjectEvents(undefined, obj.id))[0]!
    const b = (await graph.listObjectEvents(undefined, other.id))[0]!
    expect(a.id).not.toBe(b.id)
    expect(a.origin).toBe('organic')
  })

  it('edges are deterministic and idempotent', async () => {
    const spine = await newDefect('spine')
    const mirror = await graph.getOrCreateMirror(undefined, {
      teamId: TEAM,
      externalSource: 'github',
      externalId: 'org/repo/issues/1291',
      now: NOW,
    })
    const first = await graph.upsertEdge(undefined, {
      teamId: TEAM,
      kind: 'tracks',
      srcId: spine.id,
      dstId: mirror.object.id,
      now: NOW,
    })
    const second = await graph.upsertEdge(undefined, {
      teamId: TEAM,
      kind: 'tracks',
      srcId: spine.id,
      dstId: mirror.object.id,
      meta: { note: 'annotating does not fork the edge' },
      now: NOW,
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.edge.id).toBe(first.edge.id)
    expect(await graph.edgesFrom(undefined, spine.id, 'tracks')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2 - mirror global uniqueness
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: mirror identity is globally unique per team', () => {
  it('concurrent get-or-create for the same (team, source, external id) yields ONE object', async () => {
    const identity = { teamId: TEAM, externalSource: 'github', externalId: 'org/repo/pull/1291' }
    // Eight workflows discovering the same PR at once. The upsert is the whole
    // mechanism - no read-then-write, so nothing here depends on ordering.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => graph.getOrCreateMirror(undefined, { ...identity, now: NOW })),
    )
    const ids = new Set(results.map((r) => r.object.id))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)

    const all = await graph.listObjects(undefined, TEAM, { type: 'mirror' })
    expect(all.filter((o) => o.externalId === identity.externalId)).toHaveLength(1)
  })

  it('the partial UNIQUE index refuses a duplicate identity even under a different id', async () => {
    // The deterministic primary key makes get-or-create cheap; the INDEX is what
    // makes the invariant hold against any other write path.
    await expect(
      dbmod.db.insert(schema.objects).values({
        id: 'obj-smuggled',
        teamId: TEAM,
        archetype: 'mirror',
        type: 'mirror',
        status: 'observed',
        statusChangedAt: NOW,
        externalSource: 'github',
        externalId: 'org/repo/pull/1291',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow()
  })

  it('different teams observing the same external entity get their own mirrors', async () => {
    const a = await graph.getOrCreateMirror(undefined, {
      teamId: 'team-other',
      externalSource: 'github',
      externalId: 'org/repo/pull/1291',
      now: NOW,
    })
    expect(a.created).toBe(true)
  })

  it('a mirror has no our-side state machine - applyTransition refuses it', async () => {
    const m = await graph.getOrCreateMirror(undefined, {
      teamId: TEAM,
      externalSource: 'github',
      externalId: 'org/repo/pull/2000',
      now: NOW,
    })
    const r = await at.applyTransition({
      objectId: m.object.id,
      transition: 'anything',
      actor: { entrance: 'agent-run', actorId: 'run-1' },
      now: NOW,
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('ARCHETYPE_HAS_NO_STATE_MACHINE')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3 - payload sufficiency + provenance
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a state-change event is sufficient on its own', () => {
  it('names the transition, every changed field {old,new}, and its provenance - with NO DB peeking', async () => {
    const obj = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'task',
      type: 'defect',
      status: 'reproducing',
      title: 'sufficiency',
      payload: { branch: null, attempts: 0, unchanged: 'same' },
      now: NOW,
    })
    const r = await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'agent-run', actorId: 'run-sufficiency' },
      now: NOW,
      fields: { branch: 'fix/1291', attempts: 1, unchanged: 'same' },
      columns: { assigneeUserId: 'u_bob' },
    })
    expect(r.ok).toBe(true)

    // From here on: ONLY the event row. Nothing else is consulted.
    const event = (await graph.getEvent(undefined, (r as { event: { id: string } }).event.id))!

    expect(event.kind).toBe('status-changed')
    expect(event.transition).toBe('fix')

    // Provenance: which entrance produced it + the concrete actor behind it.
    expect(event.entrance).toBe('agent-run')
    expect(event.actorId).toBe('run-sufficiency')

    const diff = event.diff!
    expect(diff.status).toEqual({ old: 'reproducing', new: 'fixing' })
    expect(diff['payload.branch']).toEqual({ old: null, new: 'fix/1291' })
    expect(diff['payload.attempts']).toEqual({ old: 0, new: 1 })
    expect(diff.assigneeUserId).toEqual({ old: null, new: 'u_bob' })
    // Unchanged fields are absent - the diff answers "what changed".
    expect(diff['payload.unchanged']).toBeUndefined()

    // Reconstruct the before AND after states from the event alone.
    const before = Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.old]))
    const after = Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.new]))
    expect(before.status).toBe('reproducing')
    expect(after.status).toBe('fixing')

    // Only NOW do we check reality agrees - the point is that we did not need to.
    const live = (await graph.getObject(undefined, obj.id))!
    expect(live.status).toBe(after.status)
    expect((live.payload as Record<string, unknown>).branch).toBe('fix/1291')
    expect(live.assigneeUserId).toBe('u_bob')
  })

  it('the DB refuses a state-change event with no transition name or no diff', async () => {
    const base = {
      teamId: TEAM,
      objectId: 'obj-whatever',
      kind: 'status-changed',
      origin: 'organic' as const,
      entrance: 'human' as const,
      actorId: 'u_alice',
      ts: NOW,
    }
    await expect(
      dbmod.db.insert(schema.events).values({ ...base, id: 'ev-no-transition', diff: { status: { old: 'a', new: 'b' } } }),
    ).rejects.toThrow()
    await expect(
      dbmod.db.insert(schema.events).values({ ...base, id: 'ev-no-diff', transition: 'fix' }),
    ).rejects.toThrow()
  })

  it('provenance is NOT NULL on every event, not just state changes', async () => {
    await expect(
      dbmod.db.insert(schema.events).values({
        id: 'ev-anonymous',
        teamId: TEAM,
        kind: 'external-changed',
        origin: 'derived',
        ts: NOW,
      } as never),
    ).rejects.toThrow()
  })

  it('a content write cannot smuggle a state change', async () => {
    const obj = await newDefect('no-smuggle')
    await expect(
      graph.updateObjectFields(undefined, obj.id, { status: 'closed' } as never, NOW),
    ).rejects.toThrow(/applyTransition/)
    expect((await graph.getObject(undefined, obj.id))!.status).toBe('reproducing')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 4 - gate obligations and the computed inbox
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: obligations open and close by events; the inbox is opened-minus-closed', () => {
  it('carries several independent waits on ONE object and closes them one at a time', async () => {
    const obj = await newDefect('gates')
    await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'agent-run', actorId: 'run-g' },
      now: NOW,
    })

    const submitted = await at.applyTransition({
      objectId: obj.id,
      transition: 'submit',
      actor: { entrance: 'agent-run', actorId: 'run-g' },
      now: NOW,
      nextReminderAt: '2026-07-30T09:00:00.000Z',
    })
    expect(submitted.ok).toBe(true)
    const submitEvent = (submitted as { event: { id: string } }).event.id

    // TWO independent obligations - a single status column could not express this.
    let inbox = await graph.listOpenObligations(undefined, TEAM, { objectId: obj.id })
    expect(inbox.map((o) => o.key).sort()).toEqual(['merge-verdict', 'pr-merged'])
    // Every obligation names the event that opened it.
    expect(inbox.every((o) => o.openedByEvent === submitEvent)).toBe(true)
    // The passive class re-surfaces on a bounded schedule; the active one does not.
    expect(inbox.find((o) => o.key === 'pr-merged')!.nextReminderAt).toBe('2026-07-30T09:00:00.000Z')
    expect(inbox.find((o) => o.key === 'merge-verdict')!.nextReminderAt).toBeNull()

    // STRICT GATE SEMANTICS: only a human walks out of a gate state.
    const byAgent = await at.applyTransition({
      objectId: obj.id,
      transition: 'approve-merge',
      actor: { entrance: 'agent-run', actorId: 'run-g' },
      now: NOW,
      approvals: { 0: await approvalEvent('agent-try') },
    })
    expect(byAgent.ok).toBe(false)
    expect(!byAgent.ok && byAgent.code).toBe('GATE_REQUIRES_HUMAN')

    const approved = await at.applyTransition({
      objectId: obj.id,
      transition: 'approve-merge',
      actor: { entrance: 'human', actorId: 'u_captain' },
      now: NOW,
      approvals: { 0: await approvalEvent('merge') },
    })
    expect(approved.ok).toBe(true)
    const approveEvent = (approved as { event: { id: string } }).event.id

    // Opened minus closed: one obligation discharged, one still open.
    inbox = await graph.listOpenObligations(undefined, TEAM, { objectId: obj.id })
    expect(inbox.map((o) => o.key)).toEqual(['pr-merged'])

    const all = await graph.listObjectObligations(undefined, obj.id)
    const verdict = all.find((o) => o.key === 'merge-verdict')!
    expect(verdict.closedByEvent).toBe(approveEvent)
    expect(verdict.closedAt).toBe(NOW)

    // The computed inbox equals opened − closed, by construction.
    const openedMinusClosed = all.filter((o) => o.closedByEvent === null)
    expect(openedMinusClosed.map((o) => o.key)).toEqual(inbox.map((o) => o.key))
  })

  it('re-running the opening transition re-opens nothing (keyed identity)', async () => {
    const obj = await newDefect('gate-idem')
    await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
    })
    const seed = { submitted: obj.id }
    await at.applyTransition({
      objectId: obj.id,
      transition: 'submit',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
      derivedFrom: seed,
    })
    await at.applyTransition({
      objectId: obj.id,
      transition: 'submit',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
      derivedFrom: seed,
    })
    expect(await graph.countOpenObligations(undefined, obj.id)).toBe(2)
  })

  it('the inbox filters by class (the two carry different alarm cadences)', async () => {
    const human = await graph.listOpenObligations(undefined, TEAM, { class: 'human-verdict' })
    const external = await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })
    expect(human.length).toBeGreaterThan(0)
    expect(external.length).toBeGreaterThan(0)
    expect(human.every((o) => o.class === 'human-verdict')).toBe(true)
  })

  it('entering a terminal state requires an attested "no open obligations, no pending actions"', async () => {
    const obj = await newDefect('attested-close')
    await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
    })
    await at.applyTransition({
      objectId: obj.id,
      transition: 'submit',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
    })
    await at.applyTransition({
      objectId: obj.id,
      transition: 'approve-merge',
      actor: { entrance: 'human', actorId: 'u_captain' },
      now: NOW,
      approvals: { 0: await approvalEvent(`close-${obj.id}`) },
    })

    // Two actions are still pending (the notify and the external comment).
    const blocked = await at.applyTransition({
      objectId: obj.id,
      transition: 'observe-merged',
      actor: { entrance: 'agent-run', actorId: 'run-sense' },
      now: NOW,
    })
    expect(blocked.ok).toBe(false)
    expect(!blocked.ok && blocked.code).toBe('PENDING_ACTIONS')

    for (const a of await graph.listPendingActions(undefined, { objectId: obj.id })) {
      await graph.markActionDone(undefined, a.id, NOW)
    }

    const closed = await at.applyTransition({
      objectId: obj.id,
      transition: 'observe-merged',
      actor: { entrance: 'agent-run', actorId: 'run-sense' },
      now: NOW,
    })
    expect(closed.ok).toBe(true)
    // The attestation is RECORDED on the closing event, not merely implied.
    const ev = (await graph.getEvent(undefined, (closed as { event: { id: string } }).event.id))!
    expect((ev.payload as Record<string, unknown>).attested).toEqual({ openObligations: 0, pendingActions: 0 })
    expect(await graph.countOpenObligations(undefined, obj.id)).toBe(0)
  })

  it('exceeding the chain budget parks the object in a human-verdict gate', async () => {
    const obj = await newDefect('parked')
    const r = await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'rule', actorId: 'rule-autofix' },
      now: NOW,
      chainDepth: 99,
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('CHAIN_BUDGET_EXCEEDED')
    // Terminal-until-verdict: the object is parked and the status did NOT move.
    expect((await graph.getObject(undefined, obj.id))!.status).toBe('reproducing')
    const open = await graph.listOpenObligations(undefined, TEAM, { objectId: obj.id })
    expect(open.map((o) => o.key)).toEqual([at.CHAIN_PARK_KEY])
    expect(open[0]!.class).toBe('human-verdict')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 5 - outbox consequence classes
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an R3/R4 action cannot be enqueued without an approval event', () => {
  it('refuses the WHOLE transition when an outward action has no approval', async () => {
    const obj = await newDefect('r3-refused')
    await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
    })
    await at.applyTransition({
      objectId: obj.id,
      transition: 'submit',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
    })

    const r = await at.applyTransition({
      objectId: obj.id,
      transition: 'approve-merge',
      actor: { entrance: 'human', actorId: 'u_captain' },
      now: NOW,
      // no approvals - the R3 `external-comment` has nothing authorizing it
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('APPROVAL_REQUIRED')
    // Nothing landed: the state did not move and no event was written, so an
    // unauthorized outward effect can never be "already half applied".
    expect((await graph.getObject(undefined, obj.id))!.status).toBe('awaiting-merge')
    const events = (await graph.listObjectEvents(undefined, obj.id)).filter((e) => e.transition === 'approve-merge')
    expect(events).toHaveLength(0)
  })

  it('enqueues the outward action once an approval event authorizes it', async () => {
    const obj = await newDefect('r3-approved')
    for (const t of ['fix', 'submit'] as const) {
      await at.applyTransition({
        objectId: obj.id,
        transition: t,
        actor: { entrance: 'agent-run', actorId: 'r' },
        now: NOW,
      })
    }
    const approval = await approvalEvent(`ok-${obj.id}`)
    const r = await at.applyTransition({
      objectId: obj.id,
      transition: 'approve-merge',
      actor: { entrance: 'human', actorId: 'u_captain' },
      now: NOW,
      approvals: { 0: approval },
    })
    expect(r.ok).toBe(true)
    const actions = (r as { actions: Array<Record<string, unknown>> }).actions
    expect(actions).toHaveLength(1)
    expect(actions[0]!.kind).toBe('external-comment')
    expect(actions[0]!.consequenceClass).toBe('R3')
    expect(actions[0]!.approvalEvent).toBe(approval)
    // Action ids are <eventId>-<seq>, which is what makes the executor's
    // dedup-by-id work across replays.
    expect(actions[0]!.id).toBe(`${(r as { event: { id: string } }).event.id}-0`)
  })

  it('an R2 action needs no approval (the ceiling applies only to R3/R4)', async () => {
    const obj = await newDefect('r2')
    await at.applyTransition({
      objectId: obj.id,
      transition: 'fix',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
    })
    const r = await at.applyTransition({
      objectId: obj.id,
      transition: 'submit',
      actor: { entrance: 'agent-run', actorId: 'r' },
      now: NOW,
    })
    const actions = (r as { actions: Array<Record<string, unknown>> }).actions
    expect(actions[0]!.kind).toBe('notify')
    expect(actions[0]!.consequenceClass).toBe('R2')
    expect(actions[0]!.approvalEvent).toBeNull()
  })

  it('the consequence class is DERIVED from the action kind, never declared', async () => {
    expect(T.consequenceOf('external-close')).toBe('R3')
    expect(T.consequenceOf('arm-type')).toBe('R4')
    expect(T.consequenceOf('create-edge')).toBe('R0')
    // A caller cannot supply a class at all - `enqueueActions` takes only a kind.
    await expect(
      graph.enqueueActions(undefined, {
        eventId: 'ev-direct',
        teamId: TEAM,
        actions: [{ kind: 'external-close' }],
        now: NOW,
      }),
    ).rejects.toThrow(/cannot be auto-approved/)
  })

  it('the DB CHECK refuses an unapproved R3/R4 row on ANY write path', async () => {
    for (const consequenceClass of ['R3', 'R4'] as const) {
      await expect(
        dbmod.db.insert(schema.outboxActions).values({
          id: `oa-smuggled-${consequenceClass}`,
          eventId: 'ev-smuggled',
          seq: 0,
          teamId: TEAM,
          kind: 'external-close',
          consequenceClass,
          createdAt: NOW,
        }),
      ).rejects.toThrow()
    }
    // R0–R2 are unaffected.
    await expect(
      dbmod.db.insert(schema.outboxActions).values({
        id: 'oa-fine',
        eventId: 'ev-fine',
        seq: 0,
        teamId: TEAM,
        kind: 'notify',
        consequenceClass: 'R2',
        createdAt: NOW,
      }),
    ).resolves.toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Type registry - proposed vs effective (captain decision 4)
// ─────────────────────────────────────────────────────────────────────────────

describe('type registry: proposed vs effective, arm is the only promotion', () => {
  it('a proposal is invisible to every reader until it is armed', async () => {
    const spec = { ...defectSpec(), states: [...defectSpec().states, 'triaging'] }
    await graph.proposeTypeVersion(undefined, {
      teamId: TEAM,
      name: 'defect',
      archetype: 'task',
      version: 2,
      spec,
      rationale: 'add a triage state',
      now: NOW,
    })
    const effective = await graph.getEffectiveType(undefined, TEAM, 'defect')
    expect(effective!.version).toBe(1)
    expect((await graph.listTypeVersions(undefined, TEAM, 'defect')).map((v) => [v.version, v.state])).toEqual([
      [2, 'proposed'],
      [1, 'effective'],
    ])
  })

  it('arming promotes exactly one version and retires the previous', async () => {
    await graph.armTypeVersion(undefined, {
      teamId: TEAM,
      name: 'defect',
      version: 2,
      armedByEvent: await approvalEvent('arm-v2'),
      now: NOW,
    })
    const effective = await graph.getEffectiveType(undefined, TEAM, 'defect')
    expect(effective!.version).toBe(2)
    expect(effective!.armedAt).toBe(NOW)
    const versions = await graph.listTypeVersions(undefined, TEAM, 'defect')
    expect(versions.filter((v) => v.state === 'effective')).toHaveLength(1)
    expect(versions.find((v) => v.version === 1)!.state).toBe('retired')
  })

  it('the partial UNIQUE index makes two effective versions unrepresentable', async () => {
    await expect(
      dbmod.db.insert(schema.typeRegistry).values({
        id: 'type-smuggled',
        teamId: TEAM,
        name: 'defect',
        archetype: 'task',
        version: 99,
        state: 'effective',
        spec: defectSpec(),
        proposedAt: NOW,
        armedAt: NOW,
      }),
    ).rejects.toThrow()
  })

  it('a transition on a type with no effective version is refused', async () => {
    const obj = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'task',
      type: 'never-armed',
      status: 'open',
      now: NOW,
    })
    const r = await at.applyTransition({
      objectId: obj.id,
      transition: 'start',
      actor: { entrance: 'human', actorId: 'u_alice' },
      now: NOW,
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('NO_EFFECTIVE_TYPE')
  })

  it('the built-in archetypes resolve through the registry like any other type', async () => {
    const task = await graph.getEffectiveType(undefined, TEAM, 'task')
    expect(task!.state).toBe('effective')
    expect(task!.spec.initialState).toBe(T.BUILTIN_TYPE_SPECS.task.initialState)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Guard validation
// ─────────────────────────────────────────────────────────────────────────────

describe('transition guards', () => {
  it('refuses an unknown transition and an illegal source state', async () => {
    const obj = await newDefect('guards')
    const unknown = await at.applyTransition({
      objectId: obj.id,
      transition: 'teleport',
      actor: { entrance: 'human', actorId: 'u_alice' },
      now: NOW,
    })
    expect(!unknown.ok && unknown.code).toBe('UNKNOWN_TRANSITION')

    const illegal = await at.applyTransition({
      objectId: obj.id,
      transition: 'approve-merge',
      actor: { entrance: 'human', actorId: 'u_alice' },
      now: NOW,
      approvals: { 0: await approvalEvent(`guard-${obj.id}`) },
    })
    expect(!illegal.ok && illegal.code).toBe('ILLEGAL_FROM_STATE')
    expect((await graph.getObject(undefined, obj.id))!.status).toBe('reproducing')
  })

  it('refuses an unknown object', async () => {
    const r = await at.applyTransition({
      objectId: 'obj-nope',
      transition: 'fix',
      actor: { entrance: 'human', actorId: 'u_alice' },
      now: NOW,
    })
    expect(!r.ok && r.code).toBe('UNKNOWN_OBJECT')
  })

  it('serializes concurrent transitions on ONE object and re-validates the loser against post-commit state', async () => {
    // ACTOR-MAILBOX SEMANTICS. Two callers request the same transition at the
    // same instant. The object's row lock serializes them; the loser then reads
    // the COMMITTED result and finds its guard no longer satisfied, so it is
    // REFUSED with a typed code rather than overwriting the winner's decision.
    //
    // NB on the harness: pglite is a single connection whose `transaction()`
    // holds an internal mutex, so it serializes these regardless. What the probe
    // pins is the OUTCOME contract - exactly one winner, a typed refusal for the
    // loser, one status-changed event, and no lost update. On real Postgres the
    // `SELECT … FOR UPDATE` in `getObjectForUpdate` is what produces that same
    // outcome across connections.
    const obj = await newDefect('mailbox')
    const results = await Promise.all([
      at.applyTransition({
        objectId: obj.id,
        transition: 'fix',
        actor: { entrance: 'agent-run', actorId: 'run-a' },
        now: NOW,
      }),
      at.applyTransition({
        objectId: obj.id,
        transition: 'fix',
        actor: { entrance: 'agent-run', actorId: 'run-b' },
        now: NOW,
      }),
    ])

    const winners = results.filter((r) => r.ok)
    const losers = results.filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    // Loud and typed - the loser is told exactly why, and nothing was retried.
    expect((losers[0] as { code: string }).code).toBe('ILLEGAL_FROM_STATE')

    // No lost update: one status change, one event, one consistent end state.
    const changes = (await graph.listObjectEvents(undefined, obj.id)).filter((e) => e.kind === 'status-changed')
    expect(changes).toHaveLength(1)
    expect(changes[0]!.diff!.status).toEqual({ old: 'reproducing', new: 'fixing' })
    expect((await graph.getObject(undefined, obj.id))!.status).toBe('fixing')
  })

  it('serialization is PER OBJECT - distinct objects never contend', async () => {
    const objs = await Promise.all(['m1', 'm2', 'm3', 'm4'].map((s) => newDefect(s)))
    const results = await Promise.all(
      objs.map((o) =>
        at.applyTransition({
          objectId: o.id,
          transition: 'fix',
          actor: { entrance: 'agent-run', actorId: `run-${o.id}` },
          now: NOW,
        }),
      ),
    )
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('a refusal never applies a partial change and is never retried inside the module', async () => {
    // The chokepoint seam is the only path to a status write, so counting its
    // invocations proves both halves: a refused transition never reaches it, and
    // a successful one reaches it EXACTLY once (no internal retry loop).
    const begins: string[] = []
    at.setStatusWriteAuthorizer({
      async begin(_tx, ctx) {
        begins.push(ctx.transition)
      },
      async end() {},
    })
    try {
      const obj = await newDefect('no-retry')
      const refused = await at.applyTransition({
        objectId: obj.id,
        transition: 'approve-merge', // illegal from `reproducing`
        actor: { entrance: 'human', actorId: 'u_alice' },
        now: NOW,
        approvals: { 0: await approvalEvent(`no-retry-${obj.id}`) },
      })
      expect(refused.ok).toBe(false)
      expect(begins).toEqual([])

      await at.applyTransition({
        objectId: obj.id,
        transition: 'fix',
        actor: { entrance: 'agent-run', actorId: 'r' },
        now: NOW,
      })
      expect(begins).toEqual(['fix'])
    } finally {
      at.setStatusWriteAuthorizer(null)
    }
  })

  it('every status write goes through the chokepoint seam', async () => {
    // The DB-level enforcement is a pending decision; until it lands, this proves
    // the seam is on the ONLY code path that moves a status, so either option
    // drops in without hunting for stray writers.
    const seen: string[] = []
    at.setStatusWriteAuthorizer({
      async begin(_tx, ctx) {
        seen.push(`begin:${ctx.transition}`)
      },
      async end(_tx, ctx) {
        seen.push(`end:${ctx.transition}`)
      },
    })
    try {
      const obj = await newDefect('seam')
      await at.applyTransition({
        objectId: obj.id,
        transition: 'fix',
        actor: { entrance: 'agent-run', actorId: 'r' },
        now: NOW,
      })
      expect(seen).toEqual(['begin:fix', 'end:fix'])
    } finally {
      at.setStatusWriteAuthorizer(null)
    }
  })
})
