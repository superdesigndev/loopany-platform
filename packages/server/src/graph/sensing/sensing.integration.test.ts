import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * PROBE SUITE - LIVE INGESTION, pipe 1 (the GitHub PR mirror poller), over a REAL
 * pglite database.
 *
 * The unit is only worth anything if re-polling forever is free and a restart
 * cannot duplicate or lose anything. Those are not properties you can eyeball, so
 * each block below is one of them, and each is asserted against real rows through
 * the real seam - never a mock of the thing under test. The FETCHER is the only
 * fake: a sweep that reached GitHub could not assert "the same facts twice change
 * nothing", because the facts would be free to move underneath the assertion.
 *
 *   1. double-poll        no upstream change ⇒ zero new events, zero field churn
 *   2. one real change    ⇒ exactly one derived event per moved field + the write;
 *                           replaying the same observation ⇒ no-op
 *   3. kill mid-sweep     ⇒ no dupes, no gaps after the next sweep
 *   4. external-wait      a matching observation closes it (closed_by = the
 *                           observation); a non-matching one leaves it open
 *   5. unknown PR ref     ⇒ exactly ONE mirror, under concurrency
 *
 * Probe 3 is the one worth reading twice: the poller has no cursor, so "recovery"
 * is not a code path that could be wrong - it is the dedup invariant. The probe
 * proves that by aborting a sweep halfway and letting the next one run.
 */

let tmp: string
let dbmod: typeof import('../../db/index.js')
let graph: typeof import('../../db/graphStore.js')
let observe: typeof import('./observe.js')
let poller: typeof import('./poller.js')
let handlers: typeof import('../outbox/handlers.js')
let exec: typeof import('../outbox/executor.js')
let pr: typeof import('./pr.js')
let schema: typeof import('../../db/graph-schema.js')

const TEAM = 'team-sensing-probe'
const NOW = '2026-07-30T09:00:00.000Z'
const LATER = '2026-07-30T09:05:00.000Z'
const REPO = 'superdesigndev/loopany-platform'

/** The mirror type spec the probes arm - the shipped one, so a probe cannot pass
 *  against a state machine the product does not have. */
async function armTypes(): Promise<void> {
  const { PULL_REQUEST_SPEC } = await import('../workspace/specs.js')
  await graph.seedBuiltinTypes(undefined, TEAM, NOW)
  await graph.proposeTypeVersion(undefined, {
    teamId: TEAM,
    name: 'pull-request',
    archetype: 'mirror',
    version: 1,
    spec: PULL_REQUEST_SPEC,
    now: NOW,
  })
  await graph.armTypeVersion(undefined, { teamId: TEAM, name: 'pull-request', version: 1, now: NOW })
}

function observed(number: number, over: Partial<import('./pr.js').ObservedPr> = {}): import('./pr.js').ObservedPr {
  return {
    repo: REPO,
    number,
    state: 'open',
    merged: false,
    checks: 'pending',
    title: `PR ${number} title`,
    draft: false,
    ...over,
  }
}

/** A fetcher over a fixed table of facts, counting its calls. The ONLY fake in
 *  the suite: the facts have to hold still for "the same observation twice" to
 *  mean anything. */
function fakeFetcher(facts: Map<number, import('./pr.js').ObservedPr>) {
  const calls: { repo: string; numbers: number[] }[] = []
  return {
    calls,
    fetcher: {
      async fetch(repo: string, numbers: number[]) {
        calls.push({ repo, numbers: [...numbers] })
        const out = new Map<number, import('./pr.js').ObservedPr>()
        const missing: { number: number; why: string }[] = []
        for (const n of numbers) {
          const f = facts.get(n)
          if (f) out.set(n, f)
          else missing.push({ number: n, why: 'not in the probe fixture' })
        }
        return { observed: out, missing, rateLimitRemaining: 4000 }
      },
    },
  }
}

async function mirrorFor(number: number, over: Record<string, unknown> = {}) {
  const { object } = await graph.getOrCreateMirror(undefined, {
    teamId: TEAM,
    externalSource: 'github',
    externalId: pr.prExternalId({ repo: REPO, number }),
    type: 'pull-request',
    status: 'observed',
    title: `PR #${number}`,
    payload: { repo: REPO, number, ...over },
    now: NOW,
  })
  return object
}

/** Every event the workspace holds for one mirror. */
async function eventsFor(objectId: string) {
  return graph.listObjectEvents(undefined, objectId)
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-sensing-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  graph = await import('../../db/graphStore.js')
  observe = await import('./observe.js')
  poller = await import('./poller.js')
  handlers = await import('../outbox/handlers.js')
  exec = await import('../outbox/executor.js')
  pr = await import('./pr.js')
  schema = await import('../../db/graph-schema.js')

  await armTypes()
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Each block starts from a clean team so counts are absolute, not relative. */
beforeEach(async () => {
  const { eq } = await import('drizzle-orm')
  await dbmod.db.delete(schema.gateObligations).where(eq(schema.gateObligations.teamId, TEAM))
  await dbmod.db.delete(schema.outboxActions).where(eq(schema.outboxActions.teamId, TEAM))
  await dbmod.db.delete(schema.events).where(eq(schema.events.teamId, TEAM))
  await dbmod.db.delete(schema.edges).where(eq(schema.edges.teamId, TEAM))
  await dbmod.db.delete(schema.objects).where(eq(schema.objects.teamId, TEAM))
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1 - re-polling is free
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a second poll with no upstream change writes nothing', () => {
  it('sweeps twice and the second sweep produces zero events and zero field churn', async () => {
    const mirror = await mirrorFor(1291)
    const { fetcher, calls } = fakeFetcher(new Map([[1291, observed(1291)]]))

    const first = await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    expect(first.mirrors).toBe(1)
    expect(first.changed).toBe(1)
    expect(first.events).toBeGreaterThan(0)

    const afterFirst = (await graph.getObject(undefined, mirror.id))!
    const eventsAfterFirst = await eventsFor(mirror.id)

    const second = await poller.sweepOnce({ now: LATER, teamId: TEAM, fetcher })
    // The sweep RAN - it fetched again, it just found no news.
    expect(calls).toHaveLength(2)
    expect(second.changed).toBe(0)
    expect(second.events).toBe(0)

    const afterSecond = (await graph.getObject(undefined, mirror.id))!
    expect(await eventsFor(mirror.id)).toHaveLength(eventsAfterFirst.length)
    // Zero FIELD churn: the payload, the status and - critically - the instant the
    // status last changed are all untouched. A re-poll that bumped
    // `statusChangedAt` would corrupt every stuck-time aggregate in the product.
    expect(afterSecond.payload).toEqual(afterFirst.payload)
    expect(afterSecond.status).toBe(afterFirst.status)
    expect(afterSecond.statusChangedAt).toBe(afterFirst.statusChangedAt)
    // Freshness DOES move - "when did we last look?" is a different question from
    // "when did it last move?", and both have to be answerable.
    expect(afterSecond.externalObservedAt).toBe(LATER)
    expect(afterFirst.externalObservedAt).toBe(NOW)
  })

  it('stays free over many polls', async () => {
    await mirrorFor(1291)
    const { fetcher } = fakeFetcher(new Map([[1291, observed(1291)]]))
    await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    const baseline = await graph.countEvents(undefined, TEAM)
    for (let i = 0; i < 10; i++) {
      await poller.sweepOnce({ now: `2026-07-30T10:${String(i).padStart(2, '0')}:00.000Z`, teamId: TEAM, fetcher })
    }
    // Ten more sweeps, not one row. This is the property that lets the poller run
    // on a cadence forever instead of needing a window to forget with.
    expect(await graph.countEvents(undefined, TEAM)).toBe(baseline)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2 - one real change, one event
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a real state change is exactly one derived event per moved field', () => {
  it('records the change, updates the mirror, and replays as a no-op', async () => {
    const mirror = await mirrorFor(1291)
    const facts = new Map([[1291, observed(1291)]])
    const { fetcher } = fakeFetcher(facts)
    await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    const before = await eventsFor(mirror.id)

    // The PR merges upstream. Three facts move (`state`, `merged`, the projected
    // `status`); `checks` and `title` do not.
    facts.set(1291, observed(1291, { state: 'merged', merged: true }))
    const sweep = await poller.sweepOnce({ now: LATER, teamId: TEAM, fetcher })
    expect(sweep.changed).toBe(1)
    expect(sweep.events).toBe(3)

    const fresh = (await eventsFor(mirror.id)).filter((e) => !before.some((b) => b.id === e.id))
    expect(fresh.map((e) => (e.payload as Record<string, unknown>).field).sort()).toEqual(['merged', 'state', 'status'])
    for (const e of fresh) {
      // Provenance on every row: a rule did this, and the rule is named.
      expect(e.kind).toBe('external-changed')
      expect(e.origin).toBe('derived')
      expect(e.entrance).toBe('rule')
      expect(e.actorId).toBe(pr.PR_POLLER_ACTOR)
      // An event says what happened ON ITS OWN (decision 1's payload sufficiency).
      expect(e.diff).toBeTruthy()
    }
    const statusEvent = fresh.find((e) => (e.payload as Record<string, unknown>).field === 'status')!
    expect(statusEvent.diff!['status']).toEqual({ old: 'open', new: 'merged' })

    const after = (await graph.getObject(undefined, mirror.id))!
    expect(after.status).toBe('merged')
    expect((after.payload as Record<string, unknown>).merged).toBe(true)
    // The display title follows the observed one, so a Library row improves the
    // moment the poller looks.
    expect(after.title).toBe('PR #1291 · PR 1291 title')

    // REPLAY: the same observation again, at yet another instant, by a different
    // actor. Same facts ⇒ same ids ⇒ nothing lands.
    const eventCount = await graph.countEvents(undefined, TEAM)
    const replay = await observe.recordObservation({
      objectId: mirror.id,
      observed: observed(1291, { state: 'merged', merged: true }),
      now: '2026-08-30T23:59:00.000Z',
      actorId: 'rule-some-other-sweep',
    })
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    expect(replay.changed).toEqual([])
    expect(replay.events).toEqual([])
    expect(await graph.countEvents(undefined, TEAM)).toBe(eventCount)
  })

  it('re-deriving the SAME change against a rolled-back mirror inserts nothing new', async () => {
    // The direct form of the invariant: hand `recordObservation` the same change
    // twice with the stored facts reset in between, so the diff is non-empty both
    // times. The first call writes; the second derives identical ids, collides,
    // and is reported as a replay that applied nothing.
    const mirror = await mirrorFor(1291)
    const facts = observed(1291, { state: 'merged', merged: true })
    const first = await observe.recordObservation({ objectId: mirror.id, observed: facts, now: NOW })
    expect(first.ok && first.replay).toBe(false)
    const count = await graph.countEvents(undefined, TEAM)

    await graph.recordMirrorObservation(undefined, { id: mirror.id, status: 'observed', payload: { repo: REPO, number: 1291 }, now: NOW })
    const again = await observe.recordObservation({ objectId: mirror.id, observed: facts, now: LATER })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.changed.length).toBeGreaterThan(0) // it really did see a change
    expect(again.replay).toBe(true) //  … and every event for it already existed
    expect(await graph.countEvents(undefined, TEAM)).toBe(count)
  })

  it('refuses to write an observation onto anything that is not a mirror', async () => {
    // The chokepoint's other half: `applyTransition` refuses a mirror, and the
    // observation path refuses everything else. Neither is a softer door into the
    // other's status column.
    const task = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'task',
      type: 'task',
      status: 'open',
      title: 'not a mirror',
      now: NOW,
    })
    const r = await observe.recordObservation({ objectId: task.id, observed: observed(1), now: NOW })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('NOT_A_MIRROR')
    expect((await graph.getObject(undefined, task.id))!.status).toBe('open')

    // And the store function underneath it cannot be talked into it either.
    expect(
      await graph.recordMirrorObservation(undefined, { id: task.id, status: 'merged', now: NOW }),
    ).toBeUndefined()
    expect((await graph.getObject(undefined, task.id))!.status).toBe('open')
  })

  it('refuses an observation aimed at the wrong mirror', async () => {
    // A fetcher bug that mismatched a batch response to its request would write
    // one PR's facts onto another PR's mirror. A WRONG observation is worse than a
    // missing one, so the identity is re-checked at the seam.
    const mirror = await mirrorFor(1291)
    const r = await observe.recordObservation({ objectId: mirror.id, observed: observed(1292), now: NOW })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('IDENTITY_MISMATCH')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3 - crash-safety by construction
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: killing a sweep mid-flight leaves no dupes and no gaps', () => {
  it('resumes cleanly on the next sweep', async () => {
    const numbers = [1, 2, 3, 4, 5, 6]
    for (const n of numbers) await mirrorFor(n)
    const facts = new Map(numbers.map((n) => [n, observed(n, { state: 'merged', merged: true })]))

    // A fetcher that dies partway through the batch, taking the whole repo's
    // response with it - a process killed, or a connection dropped, before
    // anything committed. (The next test covers the other half: killed AFTER some
    // mirrors had already landed.)
    let fail = true
    const dying = {
      async fetch(repo: string, nums: number[]) {
        const out = new Map<number, import('./pr.js').ObservedPr>()
        for (const n of nums) {
          if (fail && out.size === 3) throw new Error('killed mid-sweep')
          const f = facts.get(n)
          if (f) out.set(n, f)
        }
        return { observed: out, missing: [] }
      },
    }

    await expect(poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher: dying })).resolves.toBeTruthy()
    // A repo whose fetch threw is reported, not swallowed: every number in it comes
    // back unresolved so the sweep's own report is honest about the gap.
    const partial = await graph.countEvents(undefined, TEAM)
    expect(partial).toBe(0)

    // Now the process is back. Same facts, full sweep.
    fail = false
    const complete = await poller.sweepOnce({ now: LATER, teamId: TEAM, fetcher: dying })
    expect(complete.changed).toBe(6)
    const total = await graph.countEvents(undefined, TEAM)

    // NO GAPS: every mirror carries the merge.
    for (const n of numbers) {
      const m = (await graph.getObject(undefined, pr.prMirrorId(TEAM, { repo: REPO, number: n })))!
      expect(m.status).toBe('merged')
    }
    // NO DUPES: a third sweep over the same facts adds nothing. There is no cursor
    // to have advanced wrongly - the diff is the whole recovery story.
    await poller.sweepOnce({ now: '2026-07-30T09:10:00.000Z', teamId: TEAM, fetcher: dying })
    expect(await graph.countEvents(undefined, TEAM)).toBe(total)
  })

  it('a sweep interrupted AFTER some mirrors committed does not re-event them', async () => {
    const numbers = [10, 11, 12]
    for (const n of numbers) await mirrorFor(n)
    const facts = new Map(numbers.map((n) => [n, observed(n, { checks: 'passing' })]))

    // Observe the first mirror only - the state a kill between two mirrors leaves.
    await observe.recordObservation({
      objectId: pr.prMirrorId(TEAM, { repo: REPO, number: 10 }),
      observed: facts.get(10)!,
      now: NOW,
    })
    const afterPartial = await graph.countEvents(undefined, TEAM)
    expect(afterPartial).toBeGreaterThan(0)

    const { fetcher } = fakeFetcher(facts)
    const resumed = await poller.sweepOnce({ now: LATER, teamId: TEAM, fetcher })
    // Only the two that had not landed produced events; the committed one is a
    // no-op even though the sweep re-read and re-diffed it.
    expect(resumed.changed).toBe(2)
    expect(await graph.countEvents(undefined, TEAM)).toBe(afterPartial * 3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 4 - the external wait closes itself
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an external-wait closes on the matching observation and only that one', () => {
  /** Open a `merge-wait` on a mirror the way the engine does: a `register-watch`
   *  action, executed by the real outbox executor. */
  async function watch(mirrorId: string, key = 'merge-wait', nonce = 'a'): Promise<string> {
    const carrier = `ev-watch-${mirrorId}-${key}-${nonce}`
    await graph.appendEvent(undefined, {
      id: carrier,
      teamId: TEAM,
      objectId: mirrorId,
      kind: 'rule-decision',
      origin: 'organic',
      entrance: 'rule',
      actorId: 'rule-probe',
      ts: NOW,
    })
    await graph.enqueueActions(undefined, {
      eventId: carrier,
      teamId: TEAM,
      objectId: mirrorId,
      actions: [{ kind: 'register-watch', payload: { via: 'self', wait: key } }],
      now: NOW,
    })
    const r = await exec.runOnce({ now: NOW, teamId: TEAM })
    expect(r.deadLettered).toBe(0)
    return carrier
  }

  it('a merge observation closes the wait, with the OBSERVATION as the closing event', async () => {
    const mirror = await mirrorFor(1291)
    await watch(mirror.id)
    const open = await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })
    expect(open).toHaveLength(1)
    expect(open[0]!.objectId).toBe(mirror.id)
    // A passive wait carries a bounded resurface stamp so it cannot rot invisibly.
    expect(open[0]!.nextReminderAt).toBeTruthy()

    const facts = new Map([[1291, observed(1291, { checks: 'passing' })]])
    const { fetcher } = fakeFetcher(facts)

    // A NON-MATCHING observation: checks went green, which is a real change and a
    // real event - and leaves the merge wait exactly where it was.
    const nonMatching = await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    expect(nonMatching.events).toBeGreaterThan(0)
    expect(nonMatching.waitsClosed).toBe(0)
    expect(await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })).toHaveLength(1)

    // The MATCHING one.
    facts.set(1291, observed(1291, { state: 'merged', merged: true, checks: 'passing' }))
    const matching = await poller.sweepOnce({ now: LATER, teamId: TEAM, fetcher })
    expect(matching.waitsClosed).toBe(1)
    expect(await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })).toHaveLength(0)

    const closed = (await graph.listObjectObligations(undefined, mirror.id))[0]!
    expect(closed.closedAt).toBe(LATER)
    // The obligation points at the OBSERVATION that discharged it - not at a
    // synthetic close event - so the audit trail names the fact.
    const closer = (await graph.getEvent(undefined, closed.closedByEvent!))!
    expect(closer.kind).toBe('external-changed')
    expect(closer.entrance).toBe('rule')
    expect((closer.payload as Record<string, unknown>).field).toBe('status')
    expect((closer.payload as Record<string, unknown>).to).toBe('merged')
  })

  it('a wait on a different condition is untouched by a merge', async () => {
    const mirror = await mirrorFor(1300)
    await watch(mirror.id, 'ci-wait:checks-green')
    const facts = new Map([[1300, observed(1300, { state: 'merged', merged: true, checks: 'failing' })]])
    const { fetcher } = fakeFetcher(facts)
    const sweep = await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    // Merged, but the wait was for green CI - which is still failing. The condition
    // is read off the KEY, so a sweep cannot close a wait it did not satisfy.
    expect(sweep.waitsClosed).toBe(0)
    expect(await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })).toHaveLength(1)
  })

  it('does not open a wait for something already true upstream', async () => {
    // A wait for an already-satisfied condition could never be closed by an
    // observation (no change ⇒ no event to close it with) and would sit open
    // forever looking like a stuck watch. Not opening it is the honest answer.
    const mirror = await mirrorFor(1301)
    const { fetcher } = fakeFetcher(new Map([[1301, observed(1301, { state: 'merged', merged: true })]]))
    await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    await watch(mirror.id)
    expect(await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })).toHaveLength(0)
  })

  it('never opens a watch on a non-mirror, and never dead-letters for trying', async () => {
    // `merge-review.submit` declares this action for the live flow where it tracks
    // a PR mirror; in the replayed history the same type tracks a plain doc. An
    // inapplicable declaration must be a clean no-op, not an attention item.
    const doc = await graph.createObject(undefined, {
      teamId: TEAM,
      archetype: 'doc',
      type: 'doc',
      status: 'current',
      title: 'a document',
      now: NOW,
    })
    const carrier = 'ev-watch-doc'
    await graph.appendEvent(undefined, {
      id: carrier,
      teamId: TEAM,
      objectId: doc.id,
      kind: 'rule-decision',
      origin: 'organic',
      entrance: 'rule',
      actorId: 'rule-probe',
      ts: NOW,
    })
    const [action] = await graph.enqueueActions(undefined, {
      eventId: carrier,
      teamId: TEAM,
      objectId: doc.id,
      actions: [{ kind: 'register-watch', payload: { via: 'self', wait: 'merge-wait' } }],
      now: NOW,
    })
    await exec.runOnce({ now: NOW, teamId: TEAM })
    expect((await graph.getAction(undefined, action!.id))!.state).toBe('done')
    expect(await graph.countOpenObligations(undefined, doc.id)).toBe(0)
  })

  it('re-registering the same watch opens nothing new', async () => {
    const mirror = await mirrorFor(1302)
    await watch(mirror.id)
    const first = (await graph.listObjectObligations(undefined, mirror.id))[0]!
    // A genuinely SECOND action (its own carrier event, so the handler really runs
    // again). `(objectId, key)` is the obligation's identity, so nothing new opens
    // and the ORIGINAL opener stands rather than being rewritten by the replay.
    await watch(mirror.id, 'merge-wait', 'b')
    const all = await graph.listObjectObligations(undefined, mirror.id)
    expect(all).toHaveLength(1)
    expect(all[0]!.openedByEvent).toBe(first.openedByEvent)
    expect(handlers.handledKinds()).toContain('register-watch')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 5 - discovery converges on ONE mirror
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a reference to an unmirrored PR creates exactly one mirror', () => {
  it('creates it once, even when several sweeps discover it at the same instant', async () => {
    const seed = await mirrorFor(1291)
    const facts = new Map([
      [1291, observed(1291, { references: [{ repo: REPO, number: 999 }] })],
    ])
    const { fetcher } = fakeFetcher(facts)

    // Eight sweeps racing on the same discovery. The upsert is the mechanism -
    // `getOrCreateMirror` is a deterministic-id insert with ON CONFLICT DO
    // NOTHING, never a read-then-write - so nothing here depends on ordering.
    const sweeps = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        poller.sweepOnce({ now: `2026-07-30T09:0${i}:00.000Z`, teamId: TEAM, fetcher }),
      ),
    )
    expect(sweeps.reduce((n, s) => n + s.discovered, 0)).toBe(1)

    const mirrors = await graph.listMirrors(undefined, TEAM, { externalSource: 'github', type: 'pull-request' })
    expect(mirrors.filter((m) => m.externalId === `${REPO}/pull/999`)).toHaveLength(1)
    expect(mirrors).toHaveLength(2)

    const discovered = mirrors.find((m) => m.id !== seed.id)!
    // It lands UNOBSERVED: we learned the PR exists, we did not read its state.
    // Claiming `open` here would be inventing an observation.
    expect(discovered.status).toBe('observed')
    expect((discovered.payload as Record<string, unknown>).discoveredBy).toBe('cross-reference')

    // And the NEXT sweep observes it, because scope is derived from the table -
    // the discovery is what widened it, not a config change.
    facts.set(999, observed(999, { state: 'closed' }))
    const next = await poller.sweepOnce({ now: LATER, teamId: TEAM, fetcher })
    expect(next.mirrors).toBe(2)
    expect((await graph.getObject(undefined, discovered.id))!.status).toBe('closed')
  })

  it('does not re-create a mirror that already exists', async () => {
    await mirrorFor(1291)
    await mirrorFor(999)
    const { fetcher } = fakeFetcher(
      new Map([
        [1291, observed(1291, { references: [{ repo: REPO, number: 999 }] })],
        [999, observed(999)],
      ]),
    )
    const sweep = await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    expect(sweep.discovered).toBe(0)
    expect(await graph.listMirrors(undefined, TEAM, { externalSource: 'github', type: 'pull-request' })).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// the sweep's own shape
// ─────────────────────────────────────────────────────────────────────────────

describe('the sweep batches by repo and reports what it could not resolve', () => {
  it('asks each repo once, for all of its PRs', async () => {
    for (const n of [1, 2, 3]) await mirrorFor(n)
    const { object: other } = await graph.getOrCreateMirror(undefined, {
      teamId: TEAM,
      externalSource: 'github',
      externalId: 'superdesigndev/superdesign-prompts/pull/41',
      type: 'pull-request',
      status: 'observed',
      now: NOW,
    })
    expect(other.id).toBeTruthy()

    const { fetcher, calls } = fakeFetcher(new Map([1, 2, 3].map((n) => [n, observed(n)])))
    const sweep = await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })

    // Two repos, two calls - not four calls for four PRs.
    expect(calls).toHaveLength(2)
    expect(calls.find((c) => c.repo === REPO)!.numbers).toEqual([1, 2, 3])
    expect(sweep.repos).toBe(2)
    // The PR the fixture has no facts for is REPORTED, never silently dropped: a
    // mirror that stopped resolving is a fact about the world too.
    expect(sweep.unresolved).toEqual([
      { externalId: 'superdesigndev/superdesign-prompts/pull/41', why: 'not in the probe fixture' },
    ])
  })

  it('ignores a mirror whose external id is not a pull request', async () => {
    await graph.getOrCreateMirror(undefined, {
      teamId: TEAM,
      externalSource: 'github',
      externalId: 'superdesigndev/loopany-platform/issues/7',
      type: 'pull-request',
      status: 'observed',
      now: NOW,
    })
    const { fetcher, calls } = fakeFetcher(new Map())
    const sweep = await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    expect(sweep.mirrors).toBe(1)
    // In scope as a row, but not addressable as a PR - so nothing is fetched and
    // nothing is guessed.
    expect(calls).toHaveLength(0)
    expect(sweep.repos).toBe(0)
  })

  it('is a clean no-op on an empty workspace', async () => {
    const { fetcher, calls } = fakeFetcher(new Map())
    const sweep = await poller.sweepOnce({ now: NOW, teamId: TEAM, fetcher })
    expect(sweep).toMatchObject({ mirrors: 0, repos: 0, changed: 0, events: 0 })
    expect(calls).toHaveLength(0)
  })
})
