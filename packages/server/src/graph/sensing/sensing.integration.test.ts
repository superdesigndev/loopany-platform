import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * PROBE SUITE - LIVE INGESTION, pipe 1 (the GitHub PR mirror pipe), over a REAL
 * pglite database.
 *
 * ── what changed, and what deliberately did not ─────────────────────────────
 *
 * Captain decision 10 moved the FETCH LOOP to the machine agent: the server keeps a
 * watch-list API and the observation seam, and holds no GitHub transport at all. So
 * these probes drive the SEAM the agent talks to (`watchList` +
 * `ingestObservations`) instead of an in-server sweep - and every behavioural claim
 * the old suite made is asserted again, unchanged, because the transport moved and
 * the meaning did not. That is the whole point of the migration probe: if any of
 * these had to be relaxed, identity was not really content-derived.
 *
 *   1. double-report      no upstream change ⇒ zero new events, zero field churn
 *   2. one real change    ⇒ exactly one derived event per moved field + the write;
 *                           replaying the same observation ⇒ no-op
 *   3. kill mid-sweep     ⇒ no dupes, no gaps after the next report
 *   4. external-wait      a matching observation closes it (closed_by = the
 *                           observation); a non-matching one leaves it open
 *   5. unknown PR ref     ⇒ exactly ONE mirror, under concurrency
 *   6. the watch list     scope is our own tables; a non-PR mirror is never offered
 *   7. NO FETCH PATH      the server source contains no GitHub transport, and the
 *                           deleted poller/fetcher modules are really gone
 *
 * Probe 3 is the one worth reading twice: there is no cursor, so "recovery" is not a
 * code path that could be wrong - it is the dedup invariant. The probe proves that by
 * reporting half a sweep and then reporting the whole of it.
 *
 * `sweepViaSeam` stands in for the agent: watch list → resolve facts from a fixture →
 * report. The FIXTURE is the only fake, and it has to be: a sweep that reached GitHub
 * could not assert "the same facts twice change nothing", because the facts would be
 * free to move underneath the assertion.
 */

let tmp: string
let dbmod: typeof import('../../db/index.js')
let graph: typeof import('../../db/graphStore.js')
let observe: typeof import('./observe.js')
let watch: typeof import('./watch.js')
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

/**
 * WHAT THE MACHINE AGENT DOES, in-process: pull the watch list, look each entry up in
 * a fixture, report what it "read". This is deliberately a thin stand-in rather than
 * an import of the agent package - the agent's own batching, rate-limit stop and
 * cross-reference parsing are probed in `packages/machine-agent`, and what THIS suite
 * is about is the server seam those reports land on.
 */
async function sweepViaSeam(
  facts: Map<number, import('./pr.js').ObservedPr>,
  now: string,
  options: { only?: number[] } = {},
): Promise<{ ingest: Awaited<ReturnType<typeof watch.ingestObservations>>; asked: number[] }> {
  const list = await watch.watchList({ teamId: TEAM })
  const asked: number[] = []
  const observations: import('./pr.js').ObservedPr[] = []
  const unresolved: { externalId: string; why: string }[] = []
  for (const item of list.items) {
    if (options.only && !options.only.includes(item.number)) continue
    asked.push(item.number)
    const f = facts.get(item.number)
    if (f) observations.push(f)
    else unresolved.push({ externalId: item.externalId, why: 'not in the probe fixture' })
  }
  const ingest = await watch.ingestObservations({ now, teamId: TEAM, observations, unresolved })
  return { ingest, asked }
}

/** Every event the workspace holds for one mirror. */
async function eventsFor(objectId: string) {
  return graph.listObjectEvents(undefined, objectId)
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

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-sensing-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  graph = await import('../../db/graphStore.js')
  observe = await import('./observe.js')
  watch = await import('./watch.js')
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
// PROBE 1 - re-reporting is free
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a second report with no upstream change writes nothing', () => {
  it('reports twice and the second report produces zero events and zero field churn', async () => {
    const mirror = await mirrorFor(1291)
    const facts = new Map([[1291, observed(1291)]])

    const first = await sweepViaSeam(facts, NOW)
    expect(first.ingest.mirrors).toBe(1)
    expect(first.ingest.changed).toBe(1)
    expect(first.ingest.events).toBeGreaterThan(0)

    const afterFirst = (await graph.getObject(undefined, mirror.id))!
    const eventsAfterFirst = await eventsFor(mirror.id)

    const second = await sweepViaSeam(facts, LATER)
    // The sweep RAN - it asked for the mirror again, it just found no news.
    expect(second.asked).toEqual([1291])
    expect(second.ingest.changed).toBe(0)
    expect(second.ingest.events).toBe(0)

    const afterSecond = (await graph.getObject(undefined, mirror.id))!
    expect(await eventsFor(mirror.id)).toHaveLength(eventsAfterFirst.length)
    // Zero FIELD churn: the payload, the status and - critically - the instant the
    // status last changed are all untouched. A re-report that bumped
    // `statusChangedAt` would corrupt every stuck-time aggregate in the product.
    expect(afterSecond.payload).toEqual(afterFirst.payload)
    expect(afterSecond.status).toBe(afterFirst.status)
    expect(afterSecond.statusChangedAt).toBe(afterFirst.statusChangedAt)
    // Freshness DOES move - "when did we last look?" is a different question from
    // "when did it last move?", and both have to be answerable.
    expect(afterSecond.externalObservedAt).toBe(LATER)
    expect(afterFirst.externalObservedAt).toBe(NOW)
  })

  it('stays free over many reports', async () => {
    await mirrorFor(1291)
    const facts = new Map([[1291, observed(1291)]])
    await sweepViaSeam(facts, NOW)
    const baseline = await graph.countEvents(undefined, TEAM)
    for (let i = 0; i < 10; i++) {
      await sweepViaSeam(facts, `2026-07-30T10:${String(i).padStart(2, '0')}:00.000Z`)
    }
    // Ten more sweeps, not one row. This is the property that lets the agent sweep on
    // a cadence forever instead of needing a window to forget with.
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
    await sweepViaSeam(facts, NOW)
    const before = await eventsFor(mirror.id)

    // The PR merges upstream. Three facts move (`state`, `merged`, the projected
    // `status`); `checks` and `title` do not.
    facts.set(1291, observed(1291, { state: 'merged', merged: true }))
    const sweep = await sweepViaSeam(facts, LATER)
    expect(sweep.ingest.changed).toBe(1)
    expect(sweep.ingest.events).toBe(3)

    const fresh = (await eventsFor(mirror.id)).filter((e) => !before.some((b) => b.id === e.id))
    expect(fresh.map((e) => (e.payload as Record<string, unknown>).field).sort()).toEqual(['merged', 'state', 'status'])
    for (const e of fresh) {
      // PROVENANCE IS UNCHANGED BY THE TRANSPORT MOVE. Still a rule, still the poller
      // actor - a freshness sweep is the engine's own declarative service, not the
      // agent run that happened to carry its bytes.
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
    // The display title follows the observed one, so a Library row improves the moment
    // the agent looks.
    expect(after.title).toBe('PR #1291 · PR 1291 title')

    // REPLAY: the same observation again, at yet another instant, by a different
    // actor. Same facts ⇒ same ids ⇒ nothing lands. Asserted through the SEAM the
    // agent uses, which is exactly the claim the transport move has to make good on.
    const eventCount = await graph.countEvents(undefined, TEAM)
    const replay = await watch.ingestObservations({
      now: '2026-08-30T23:59:00.000Z',
      teamId: TEAM,
      observations: [observed(1291, { state: 'merged', merged: true })],
      actorId: 'rule-some-other-sweep',
    })
    expect(replay.changed).toBe(0)
    expect(replay.events).toBe(0)
    expect(await graph.countEvents(undefined, TEAM)).toBe(eventCount)
  })

  it('re-deriving the SAME change against a rolled-back mirror inserts nothing new', async () => {
    // The direct form of the invariant: hand the seam the same change twice with the
    // stored facts reset in between, so the diff is non-empty both times. The first
    // call writes; the second derives identical ids, collides, and is reported as a
    // replay that applied nothing.
    const mirror = await mirrorFor(1291)
    const facts = observed(1291, { state: 'merged', merged: true })
    const first = await observe.recordObservation({ objectId: mirror.id, observed: facts, now: NOW })
    expect(first.ok && first.replay).toBe(false)
    const count = await graph.countEvents(undefined, TEAM)

    await graph.recordMirrorObservation(undefined, {
      id: mirror.id,
      status: 'observed',
      payload: { repo: REPO, number: 1291 },
      now: NOW,
    })
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
    // A transport bug that mismatched a batch response to its request would write one
    // PR's facts onto another PR's mirror. A WRONG observation is worse than a missing
    // one, so the identity is re-checked at the seam - and now that the transport runs
    // on somebody else's machine, that check matters MORE, not less.
    const mirror = await mirrorFor(1291)
    const r = await observe.recordObservation({ objectId: mirror.id, observed: observed(1292), now: NOW })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('IDENTITY_MISMATCH')
  })

  it('drops a reported fact for a mirror this team does not hold', async () => {
    // A report is not a discovery channel. An agent reporting whatever it likes must
    // not be able to widen the graph's scope - new mirrors arrive only through a
    // cross-reference inside a PR we already watch.
    await mirrorFor(1291)
    const r = await watch.ingestObservations({
      now: NOW,
      teamId: TEAM,
      observations: [observed(1291), observed(4242)],
    })
    expect(r.unknown).toBe(1)
    expect(r.changed).toBe(1)
    const mirrors = await graph.listMirrors(undefined, TEAM, { externalSource: 'github', type: 'pull-request' })
    expect(mirrors).toHaveLength(1)
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

    // An agent that died partway through the sweep: it read three PRs and never
    // reported the rest. That is the honest shape of a killed process here - the
    // fetch happens off-server, so what the server sees is a PARTIAL report.
    const partial = await sweepViaSeam(facts, NOW, { only: [1, 2, 3] })
    expect(partial.ingest.changed).toBe(3)
    const afterPartial = await graph.countEvents(undefined, TEAM)
    expect(afterPartial).toBeGreaterThan(0)

    // Now the process is back. Same facts, full sweep.
    const complete = await sweepViaSeam(facts, LATER)
    // Only the three that had not landed produced events; the committed ones are
    // no-ops even though the sweep re-read and re-reported them.
    expect(complete.ingest.changed).toBe(3)
    const total = await graph.countEvents(undefined, TEAM)

    // NO GAPS: every mirror carries the merge.
    for (const n of numbers) {
      const m = (await graph.getObject(undefined, pr.prMirrorId(TEAM, { repo: REPO, number: n })))!
      expect(m.status).toBe('merged')
    }
    // NO DUPES: a third sweep over the same facts adds nothing. There is no cursor to
    // have advanced wrongly - the diff is the whole recovery story.
    await sweepViaSeam(facts, '2026-07-30T09:10:00.000Z')
    expect(await graph.countEvents(undefined, TEAM)).toBe(total)
  })

  it('an unreadable mirror is reported unresolved, never guessed at', async () => {
    await mirrorFor(1291)
    await mirrorFor(1292)
    // The fixture knows one of the two. The other comes back as unresolved rather
    // than as a fabricated `closed`.
    const sweep = await sweepViaSeam(new Map([[1291, observed(1291)]]), NOW)
    expect(sweep.ingest.unresolved).toEqual([
      { externalId: `${REPO}/pull/1292`, why: 'not in the probe fixture' },
    ])
    expect((await graph.getObject(undefined, pr.prMirrorId(TEAM, { repo: REPO, number: 1292 })))!.status).toBe('observed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 4 - the external wait closes itself
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an external-wait closes on the matching observation and only that one', () => {
  /** Open a `merge-wait` on a mirror the way the engine does: a `register-watch`
   *  action, executed by the real outbox executor. */
  async function watchFor(mirrorId: string, key = 'merge-wait', nonce = 'a'): Promise<string> {
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
    await watchFor(mirror.id)
    const open = await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })
    expect(open).toHaveLength(1)
    expect(open[0]!.objectId).toBe(mirror.id)
    // A passive wait carries a bounded resurface stamp so it cannot rot invisibly.
    expect(open[0]!.nextReminderAt).toBeTruthy()

    const facts = new Map([[1291, observed(1291, { checks: 'passing' })]])

    // A NON-MATCHING observation: checks went green, which is a real change and a real
    // event - and leaves the merge wait exactly where it was.
    const nonMatching = await sweepViaSeam(facts, NOW)
    expect(nonMatching.ingest.events).toBeGreaterThan(0)
    expect(nonMatching.ingest.waitsClosed).toBe(0)
    expect(await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })).toHaveLength(1)

    // The MATCHING one.
    facts.set(1291, observed(1291, { state: 'merged', merged: true, checks: 'passing' }))
    const matching = await sweepViaSeam(facts, LATER)
    expect(matching.ingest.waitsClosed).toBe(1)
    expect(await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })).toHaveLength(0)

    const closed = (await graph.listObjectObligations(undefined, mirror.id))[0]!
    expect(closed.closedAt).toBe(LATER)
    // The obligation points at the OBSERVATION that discharged it - not at a synthetic
    // close event - so the audit trail names the fact.
    const closer = (await graph.getEvent(undefined, closed.closedByEvent!))!
    expect(closer.kind).toBe('external-changed')
    expect(closer.entrance).toBe('rule')
    expect((closer.payload as Record<string, unknown>).field).toBe('status')
    expect((closer.payload as Record<string, unknown>).to).toBe('merged')
  })

  it('a wait on a different condition is untouched by a merge', async () => {
    const mirror = await mirrorFor(1300)
    await watchFor(mirror.id, 'ci-wait:checks-green')
    const sweep = await sweepViaSeam(
      new Map([[1300, observed(1300, { state: 'merged', merged: true, checks: 'failing' })]]),
      NOW,
    )
    // Merged, but the wait was for green CI - which is still failing. The condition is
    // read off the KEY, so a sweep cannot close a wait it did not satisfy.
    expect(sweep.ingest.waitsClosed).toBe(0)
    expect(await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })).toHaveLength(1)
  })

  it('does not open a wait for something already true upstream', async () => {
    // A wait for an already-satisfied condition could never be closed by an
    // observation (no change ⇒ no event to close it with) and would sit open forever
    // looking like a stuck watch. Not opening it is the honest answer.
    const mirror = await mirrorFor(1301)
    await sweepViaSeam(new Map([[1301, observed(1301, { state: 'merged', merged: true })]]), NOW)
    await watchFor(mirror.id)
    expect(await graph.listOpenObligations(undefined, TEAM, { class: 'external-wait' })).toHaveLength(0)
  })

  it('never opens a watch on a non-mirror, and never dead-letters for trying', async () => {
    // `merge-review.submit` declares this action for the live flow where it tracks a
    // PR mirror; in the replayed history the same type tracks a plain doc. An
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
    await watchFor(mirror.id)
    const first = (await graph.listObjectObligations(undefined, mirror.id))[0]!
    // A genuinely SECOND action (its own carrier event, so the handler really runs
    // again). `(objectId, key)` is the obligation's identity, so nothing new opens and
    // the ORIGINAL opener stands rather than being rewritten by the replay.
    await watchFor(mirror.id, 'merge-wait', 'b')
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
  it('creates it once, even when several reports discover it at the same instant', async () => {
    const seed = await mirrorFor(1291)
    const facts = new Map([[1291, observed(1291, { references: [{ repo: REPO, number: 999 }] })]])

    // Eight reports racing on the same discovery. The upsert is the mechanism -
    // `getOrCreateMirror` is a deterministic-id insert with ON CONFLICT DO NOTHING,
    // never a read-then-write - so nothing here depends on ordering.
    const reports = await Promise.all(
      Array.from({ length: 8 }, (_, i) => sweepViaSeam(facts, `2026-07-30T09:0${i}:00.000Z`)),
    )
    expect(reports.reduce((n, r) => n + r.ingest.discovered, 0)).toBe(1)

    const mirrors = await graph.listMirrors(undefined, TEAM, { externalSource: 'github', type: 'pull-request' })
    expect(mirrors.filter((m) => m.externalId === `${REPO}/pull/999`)).toHaveLength(1)
    expect(mirrors).toHaveLength(2)

    const discovered = mirrors.find((m) => m.id !== seed.id)!
    // It lands UNOBSERVED: we learned the PR exists, we did not read its state.
    // Claiming `open` here would be inventing an observation.
    expect(discovered.status).toBe('observed')
    expect((discovered.payload as Record<string, unknown>).discoveredBy).toBe('cross-reference')

    // And the NEXT sweep observes it, because the WATCH LIST is derived from the table
    // - the discovery is what widened the agent's scope, not a config change.
    facts.set(999, observed(999, { state: 'closed' }))
    const next = await sweepViaSeam(facts, LATER)
    expect(next.asked).toContain(999)
    expect((await graph.getObject(undefined, discovered.id))!.status).toBe('closed')
  })

  it('does not re-create a mirror that already exists', async () => {
    await mirrorFor(1291)
    await mirrorFor(999)
    const sweep = await sweepViaSeam(
      new Map([
        [1291, observed(1291, { references: [{ repo: REPO, number: 999 }] })],
        [999, observed(999)],
      ]),
      NOW,
    )
    expect(sweep.ingest.discovered).toBe(0)
    expect(await graph.listMirrors(undefined, TEAM, { externalSource: 'github', type: 'pull-request' })).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 6 - the watch list is scoped by our own tables
// ─────────────────────────────────────────────────────────────────────────────

describe('the watch list offers exactly the mirrors this team holds', () => {
  it('lists every PR mirror with its identity and its freshness', async () => {
    for (const n of [1, 2, 3]) await mirrorFor(n)
    const list = await watch.watchList({ teamId: TEAM })
    expect(list.source).toBe('github')
    expect(list.truncated).toBe(false)
    expect(list.items.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 2, 3])
    for (const item of list.items) {
      expect(item.repo).toBe(REPO)
      expect(item.externalId).toBe(`${REPO}/pull/${item.number}`)
      // Never observed yet, and the list says so rather than omitting the field - an
      // agent prioritising the stalest entries needs to be able to tell.
      expect(item.observedAt).toBeNull()
    }

    await sweepViaSeam(new Map([[1, observed(1)]]), NOW)
    const after = await watch.watchList({ teamId: TEAM })
    expect(after.items.find((i) => i.number === 1)!.observedAt).toBe(NOW)
  })

  it('never offers a mirror whose external id is not a pull request', async () => {
    await graph.getOrCreateMirror(undefined, {
      teamId: TEAM,
      externalSource: 'github',
      externalId: 'superdesigndev/loopany-platform/issues/7',
      type: 'pull-request',
      status: 'observed',
      now: NOW,
    })
    // In scope as a row, but not addressable as a PR - so it is never handed to an
    // agent and nothing about it is guessed.
    expect((await watch.watchList({ teamId: TEAM })).items).toHaveLength(0)
  })

  it('is a clean no-op on an empty workspace', async () => {
    const list = await watch.watchList({ teamId: TEAM })
    expect(list.items).toHaveLength(0)
    const ingest = await watch.ingestObservations({ now: NOW, teamId: TEAM, observations: [] })
    expect(ingest).toMatchObject({ mirrors: 0, reported: 0, changed: 0, events: 0, discovered: 0 })
  })

  it('reports sensing freshness from the observation stamps themselves', async () => {
    // The workspace's own answer to "is anybody sensing?". Computed from rows, so it
    // cannot claim freshness the data does not have - which is the whole reason the
    // deleted poller's "I am running" indicator was not a good enough replacement.
    await mirrorFor(1291)
    const cold = await watch.sensingHealth({ now: NOW, teamId: TEAM })
    expect(cold).toMatchObject({ mirrors: 1, unobserved: 1, stale: 0, lastObservedAt: null })

    await sweepViaSeam(new Map([[1291, observed(1291)]]), NOW)
    const warm = await watch.sensingHealth({ now: LATER, teamId: TEAM })
    expect(warm).toMatchObject({ mirrors: 1, unobserved: 0, stale: 0, lastObservedAt: NOW })

    const later = new Date(Date.parse(NOW) + watch.STALE_AFTER_MS + 60_000).toISOString()
    expect((await watch.sensingHealth({ now: later, teamId: TEAM })).stale).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 7 - the server holds NO GitHub fetch path (captain decision 10)
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: the server contains no GitHub fetch path at all', () => {
  /** Every `.ts`/`.tsx` file under the server's source tree, tests excluded: a probe
   *  may legitimately mention `gh`, production code may not. */
  function serverSources(): string[] {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const out: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        if (/\.test\.tsx?$/.test(entry.name)) continue
        out.push(full)
      }
    }
    walk(root)
    return out
  }

  it('has no module that spawns `gh` or issues a GitHub GraphQL query', () => {
    // The invariant captain decision 10 turns on, pinned by a source scan because it
    // is exactly the kind of thing that erodes one convenient import at a time. The
    // agent package holds the transport; this package must hold none of it.
    const offenders: string[] = []
    for (const file of serverSources()) {
      const text = fs.readFileSync(file, 'utf8')
      const rel = path.relative(fileURLToPath(new URL('../..', import.meta.url)), file)
      if (/\bapi\s+graphql\b/.test(text)) offenders.push(`${rel}: issues a \`gh api graphql\` call`)
      if (/api\.github\.com/.test(text)) offenders.push(`${rel}: talks to api.github.com`)
      if (/LOOPANY_GH_BIN/.test(text)) offenders.push(`${rel}: resolves a \`gh\` binary`)
    }
    expect(offenders).toEqual([])
  })

  it('no graph module imports node:child_process', () => {
    // Stronger and simpler than grepping for `gh`: the server executes NOTHING for the
    // graph engine, so the graph tree has no business importing a process spawner at
    // all. A future "just shell out to X" lands here first.
    const graphRoot = fileURLToPath(new URL('..', import.meta.url))
    const offenders = serverSources()
      .filter((f) => f.startsWith(graphRoot))
      .filter((f) => /child_process/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(graphRoot, f))
    expect(offenders).toEqual([])
  })

  it('the in-server poller and fetcher modules are gone, not merely unused', async () => {
    // An unimported module is a module somebody re-imports. Both are deleted, and a
    // dynamic import is the only way to assert absence without a compile error.
    await expect(import('./poller.js' as string)).rejects.toThrow()
    await expect(import('./fetch-gh.js' as string)).rejects.toThrow()
  })
})
