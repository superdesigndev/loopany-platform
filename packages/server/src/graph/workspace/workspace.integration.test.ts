import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The Graph Engineering v1 workspace demo, over a REAL pglite database.
 *
 * The claim this suite defends is the whole reason the demo exists: every state
 * the workspace shows is the product of a real transition through the kernel, not
 * a fixture. So the assertions are mostly "can this be traced back to a row the
 * engine wrote" rather than "does it look right".
 */

let tmp: string
let seed: typeof import('./seed.js')
let read: typeof import('./read.js')
let graph: typeof import('../../db/graphStore.js')
let result: import('./seed.js').SeedResult

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-ws-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  const dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  seed = await import('./seed.js')
  read = await import('./read.js')
  graph = await import('../../db/graphStore.js')
  result = await seed.seedGraphDemo()
}, 120_000)

describe('the seed runs entirely through the real primitives', () => {
  it('applies every history step without a single refusal', () => {
    // A refusal here means the history script and the type specs disagree —
    // which would mean a demo state that no legal transition could produce.
    expect(result.refusals).toEqual([])
  })

  it('lands a populated workspace', () => {
    expect(result.objects).toBeGreaterThan(40)
    expect(result.edges).toBeGreaterThan(20)
    expect(result.events).toBeGreaterThan(60)
    expect(result.openObligations).toBeGreaterThan(0)
  })

  it('is re-runnable: a second seed converges instead of duplicating', async () => {
    const again = await seed.seedGraphDemo()
    expect(again.refusals).toEqual([])
    expect(again.objects).toBe(result.objects)
    expect(again.events).toBe(result.events)
    expect(again.openObligations).toBe(result.openObligations)
  }, 120_000)

  it('every non-planned status change carries a transition, a diff and provenance', async () => {
    const objects = await graph.listObjects(undefined, read.DEMO_TEAM_ID)
    const moved = objects.filter((o) => o.archetype !== 'mirror' && o.status !== 'planned' && o.status !== 'queued')
    expect(moved.length).toBeGreaterThan(20)
    for (const o of moved) {
      const events = await graph.listObjectEvents(undefined, o.id)
      const changes = events.filter((e) => e.kind === 'status-changed')
      expect(changes.length).toBeGreaterThan(0)
      for (const e of changes) {
        expect(e.transition).toBeTruthy()
        expect(e.diff?.['status']).toBeTruthy()
        expect(['human', 'agent-run', 'rule', 'clock']).toContain(e.entrance)
        expect(e.actorId).toBeTruthy()
      }
      // The object's CURRENT status is the newest status-change event's target.
      const last = changes[changes.length - 1]!
      expect(last.diff!['status']!.new).toBe(o.status)
    }
  })

  it('pull requests are mirrors with no our-side state machine', async () => {
    const objects = await graph.listObjects(undefined, read.DEMO_TEAM_ID)
    const mirrors = objects.filter((o) => o.archetype === 'mirror')
    expect(mirrors.length).toBeGreaterThan(0)
    for (const m of mirrors) {
      expect(m.externalSource).toBe('github')
      expect(m.externalId).toBeTruthy()
      // A mirror is never assignable or schedulable (schema CHECK, design §4).
      expect(m.cron).toBeNull()
      expect(m.assigneeUserId).toBeNull()
    }
  })
})

describe('the read projections derive from rows, not from fixtures', () => {
  it('derives every gate node from gate obligations', async () => {
    const system = await read.systemView()
    const gates = system.nodes.filter((n) => n.kind === 'gate')
    expect(gates.length).toBeGreaterThan(0)

    const open = await graph.listOpenObligations(undefined, read.DEMO_TEAM_ID, { class: 'human-verdict' })
    const waitingTotal = gates.reduce((sum, g) => sum + (g.waiting ?? 0), 0)
    expect(waitingTotal).toBe(open.length)

    // Every id a gate offers to open is a real object holding a real obligation.
    const openIds = new Set(open.map((o) => o.objectId))
    for (const gate of gates) for (const id of gate.artifactIds ?? []) expect(openIds.has(id)).toBe(true)
  })

  it('gives each band dense, collision-free columns', async () => {
    const system = await read.systemView()
    const seen = new Set<string>()
    for (const n of system.nodes) {
      const cell = `${n.band}:${n.yOffset ?? 0}:${n.rank}`
      expect(seen.has(cell)).toBe(false)
      seen.add(cell)
    }
  })

  it('renders artifact bodies from the STORED file, sanitized', async () => {
    const library = await read.libraryView()
    const docs = library.artifacts.filter((a) => a.kind === 'document')
    expect(docs.length).toBeGreaterThan(5)
    for (const doc of docs) {
      expect(doc.html).toBeTruthy()
      // Rendering is a projection of Markdown: no script, no style, no raw HTML.
      expect(doc.html).not.toMatch(/<script|<style|onerror=/i)
      expect(doc.html).toMatch(/<(p|h2|ul|ol|table)\b/)
    }
  })

  it('marks exactly the obligation-holding artifacts as needing a human', async () => {
    const library = await read.libraryView()
    const open = await graph.listOpenObligations(undefined, read.DEMO_TEAM_ID, { class: 'human-verdict' })
    const flagged = library.artifacts.filter((a) => a.needsHuman).map((a) => a.id).sort()
    expect(flagged).toEqual([...new Set(open.map((o) => o.objectId))].sort())
    expect(library.needsYou).toBe(flagged.length)
    // Each one names the transition that discharges it, resolved from the spec.
    for (const a of library.artifacts.filter((x) => x.needsHuman)) expect(a.verdict?.transition).toBeTruthy()
  })

  it('feeds the timeline straight off the event log, with provenance', async () => {
    const timeline = await read.timelineView()
    expect(timeline.events.length).toBeGreaterThan(20)
    expect(timeline.total).toBe(await graph.countEvents(undefined, read.DEMO_TEAM_ID))
    for (const e of timeline.events) {
      expect(['human', 'agent-run', 'rule', 'clock']).toContain(e.entrance)
      expect(e.actorId).toBeTruthy()
      expect(e.message).toBeTruthy()
    }
    // Newest first.
    const times = timeline.events.map((e) => Date.parse(e.ts))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('computes the inbox opened-minus-closed', async () => {
    const inbox = await read.inboxView()
    const open = await graph.listOpenObligations(undefined, read.DEMO_TEAM_ID, { class: 'human-verdict' })
    expect(inbox.items.length).toBe(open.length)
    for (const item of inbox.items) expect(item.class).toBe('human-verdict')
  })
})

describe('the write path is the transition seam, not a shortcut', () => {
  it('closes an obligation through applyTransition and records the event', async () => {
    await seed.seedGraphDemo() // fresh state, so this test is order-independent
    const before = await read.inboxView()
    const target = before.items.find((i) => i.verdict)!
    expect(target).toBeTruthy()

    const out = await read.recordVerdict({
      objectId: target.objectId,
      transition: target.verdict!.transition,
      now: '2026-07-30T09:00:00+08:00',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.closed.map((o) => o.key)).toContain(target.key)
    expect(out.event.entrance).toBe('human')
    expect(out.event.transition).toBe(target.verdict!.transition)

    const after = await read.inboxView()
    expect(after.items.length).toBe(before.items.length - 1)
    expect(after.items.some((i) => i.objectId === target.objectId && i.key === target.key)).toBe(false)
  }, 120_000)

  it('refuses a second verdict with a typed code instead of writing twice', async () => {
    const inbox = await read.inboxView()
    const target = inbox.items.find((i) => i.verdict)!
    const first = await read.recordVerdict({ objectId: target.objectId, transition: target.verdict!.transition, now: '2026-07-30T09:05:00+08:00' })
    expect(first.ok).toBe(true)
    const second = await read.recordVerdict({ objectId: target.objectId, transition: target.verdict!.transition, now: '2026-07-30T09:06:00+08:00' })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('ILLEGAL_FROM_STATE')
  }, 120_000)

  it('never auto-delivers an outward or governance action', async () => {
    await seed.seedGraphDemo()
    const objects = await graph.listObjects(undefined, read.DEMO_TEAM_ID)
    const holder = objects.find((o) => o.type === 'merge-review' && o.status === 'awaiting-verdict')!
    // Plant an R3 action on the object: the drain must leave it alone.
    await graph.appendEvent(undefined, {
      id: 'ev-test-approval',
      teamId: read.DEMO_TEAM_ID,
      kind: 'human-approval',
      origin: 'organic',
      entrance: 'human',
      actorId: 'u-demo-captain',
      ts: '2026-07-30T09:00:00+08:00',
    })
    await graph.enqueueActions(undefined, {
      eventId: 'ev-test-approval',
      teamId: read.DEMO_TEAM_ID,
      objectId: holder.id,
      actions: [{ kind: 'external-comment', approvalEvent: 'ev-test-approval' }],
      now: '2026-07-30T09:00:00+08:00',
    })

    const drained = await read.drainEngineLocalActions(holder.id, '2026-07-30T09:01:00+08:00')
    expect(drained).toBeGreaterThan(0)
    const stillPending = await graph.listPendingActions(undefined, { objectId: holder.id })
    expect(stillPending.map((a) => a.consequenceClass)).toEqual(['R3'])
  }, 120_000)
})
