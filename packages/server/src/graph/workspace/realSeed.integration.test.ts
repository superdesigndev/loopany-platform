import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The production REPLAY, over a real pglite and a synthetic-but-realistically
 * shaped snapshot.
 *
 * The snapshot fixture here is hand-built on purpose: this suite must run in CI
 * with no production access, and the safety rule for the real puller is that it
 * never runs anywhere except a developer's own machine. What it pins is the part
 * that can silently go wrong - the MAPPING: that a run becomes the right
 * transitions with the right provenance, that a real front-matter `type` becomes
 * the right gate, and that nothing is invented for a row that does not map.
 */

let tmp: string
let seedReal: typeof import('./seed-real.js')
let read: typeof import('./read.js')
let graph: typeof import('../../db/graphStore.js')
let snapshot: import('./pull-prod.js').ProdSnapshot

function makeSnapshot(): import('./pull-prod.js').ProdSnapshot {
  return {
    pulledAt: '2026-07-29T08:00:00.000Z',
    source: 'loopany-production',
    team: { id: 'team-fixture', name: 'Fixture' },
    window: { days: 14, maxRuns: 900, maxFilesPerLoop: 20 },
    machines: 2,
    loops: [
      {
        id: 'loop-support',
        name: 'Support Inbox Triage',
        cron: '7 * * * *',
        timezone: 'UTC',
        enabled: true,
        agent: 'claude-code',
        goal: null,
        completedAt: null,
        completionReason: null,
        taskFile: 'support/README.md',
        taskFileContent: '# Support triage\n\n## Spec\n\nWatch the inbox.\n',
        state: { needs_human: 2, handled: 40 },
        machineId: 'm-1',
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-29T07:00:00.000Z',
        runCount: 924,
      },
      {
        id: 'loop-closed',
        name: 'PR #1085 edit-correction impact',
        cron: '0 */6 * * *',
        timezone: 'UTC',
        enabled: false,
        agent: 'claude-code',
        goal: 'measure the correction impact',
        completedAt: '2026-07-25T10:00:00.000Z',
        completionReason: 'goal met: recovery rate stable',
        taskFile: null,
        taskFileContent: null,
        state: null,
        machineId: 'm-2',
        createdAt: '2026-07-02T09:00:00.000Z',
        updatedAt: '2026-07-25T10:00:00.000Z',
        runCount: 36,
      },
    ],
    runs: [
      // a normal successful exec
      { id: 'r1', loopId: 'loop-support', phase: 'done', role: 'exec', ts: '2026-07-28T10:00:00.000Z', outcome: 'exec', status: 'new', message: 'Handled 4 conversations.', error: null, durationMs: 60_000, costUsd: 0.2, state: { handled: 4 }, sessionId: 's1' },
      // a quiet one
      { id: 'r2', loopId: 'loop-support', phase: 'done', role: 'exec', ts: '2026-07-28T11:00:00.000Z', outcome: 'silent', status: 'nothing-new', message: null, error: null, durationMs: 30_000, costUsd: 0.1, state: null, sessionId: 's2' },
      // a failure
      { id: 'r3', loopId: 'loop-support', phase: 'error', role: 'exec', ts: '2026-07-28T12:00:00.000Z', outcome: 'error', status: null, message: null, error: 'API error', durationMs: null, costUsd: null, state: null, sessionId: null },
      // machine asleep
      { id: 'r4', loopId: 'loop-support', phase: 'canceled', role: 'exec', ts: '2026-07-28T13:00:00.000Z', outcome: 'skipped', status: null, message: 'skipped - the machine was unreachable', error: null, durationMs: null, costUsd: null, state: null, sessionId: null },
      // an evolve pass
      { id: 'r5', loopId: 'loop-support', phase: 'done', role: 'evolve', ts: '2026-07-28T14:00:00.000Z', outcome: 'evolve', status: null, message: 'Tightened the workflow.', error: null, durationMs: 20_000, costUsd: 0.3, state: null, sessionId: 's5' },
      // never claimed - nothing to replay
      { id: 'r6', loopId: 'loop-support', phase: 'pending', role: 'exec', ts: '2026-07-29T07:00:00.000Z', outcome: null, status: null, message: null, error: null, durationMs: null, costUsd: null, state: null, sessionId: null },
      // a run that referenced a real PR
      { id: 'r7', loopId: 'loop-closed', phase: 'done', role: 'exec', ts: '2026-07-24T10:00:00.000Z', outcome: 'exec', status: 'new', message: 'Shipped https://github.com/acme/widgets/pull/42 for review.', error: null, durationMs: 45_000, costUsd: 0.4, state: { recovery_rate_pct: 91 }, sessionId: 's7' },
    ],
    files: [
      { loopId: 'loop-support', path: 'escalations/SUP-79.md', hash: 'h-escalation', size: 900, binary: false, updatedAt: '2026-07-28T10:10:00.000Z', meta: { type: 'needs_human', title: 'SUP-79 refund decision', date: '2026-07-28' } },
      // a v1-format artifact: front matter + Markdown
      { loopId: 'loop-support', path: 'reports/2026-07-28.md', hash: 'h-artifact', size: 1200, binary: false, updatedAt: '2026-07-28T10:20:00.000Z', meta: { type: 'report', title: 'Daily triage 2026-07-28', date: '2026-07-28' } },
      { loopId: 'loop-support', path: 'cards/cleanup.md', hash: 'h-open-card', size: 400, binary: false, updatedAt: '2026-07-27T09:00:00.000Z', meta: { type: 'open', title: 'Remove a dead util' } },
      { loopId: 'loop-support', path: 'cards/done.md', hash: 'h-done-card', size: 400, binary: false, updatedAt: '2026-07-26T09:00:00.000Z', meta: { type: 'merged', title: 'Removed a dead component' } },
      { loopId: 'loop-support', path: 'posts/draft.md', hash: 'h-draft', size: 700, binary: false, updatedAt: '2026-07-26T10:00:00.000Z', meta: { type: 'drafted', title: 'A post waiting to go out' } },
      // Markdown with NO front matter - still a real document
      { loopId: 'loop-support', path: 'notes/scratch.md', hash: 'h-plain', size: 100, binary: false, updatedAt: '2026-07-20T10:00:00.000Z', meta: null },
      // data, not prose
      { loopId: 'loop-support', path: 'reports/metrics.json', hash: 'h-json', size: 120, binary: false, updatedAt: '2026-07-20T11:00:00.000Z', meta: { type: 'report', title: 'Metrics' } },
      // bytes never fetched - the Library must SAY so, not blank the row
      { loopId: 'loop-support', path: 'reports/absent.md', hash: 'h-absent', size: 300, binary: false, updatedAt: '2026-07-19T11:00:00.000Z', meta: { type: 'report', title: 'Body not cached' } },
      // the loop's own task file, already seeded from task_file_content
      { loopId: 'loop-support', path: 'support/README.md', hash: 'h-taskfile', size: 5000, binary: false, updatedAt: '2026-07-29T07:00:00.000Z', meta: { type: 'task', title: 'Support triage' } },
      // belongs to nothing in this snapshot
      { loopId: 'loop-gone', path: 'orphan.md', hash: 'h-orphan', size: 10, binary: false, updatedAt: '2026-07-20T10:00:00.000Z', meta: { type: 'report' } },
    ],
    dropped: [{ what: 'runs', count: 1047, why: 'outside the 14-day window' }],
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-real-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  const dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  seedReal = await import('./seed-real.js')
  read = await import('./read.js')
  graph = await import('../../db/graphStore.js')
  snapshot = makeSnapshot()

  // Stand in for `pnpm graph:bodies`: the real fetcher is read-only against the
  // artifact store and must never run in CI, so the cache is written directly.
  const bodies = await import('./fetch-bodies.js')
  const cache = bodies.bodyCacheDir()
  fs.mkdirSync(cache, { recursive: true })
  const write = (hash: string, text: string) => fs.writeFileSync(path.join(cache, `${hash}.txt`), text)
  write('h-artifact', '---\ntype: report\ntitle: Daily triage 2026-07-28\n---\n\n## Handled\n\n- four conversations\n')
  write('h-plain', '# Scratch\n\nNo front matter here, but still a real document.\n')
  write('h-json', '{"handled": 4}\n')
  write('h-escalation', '---\ntype: needs_human\n---\n\nRefund call needed.\n')
  // h-absent is deliberately NOT written.
}, 120_000)

describe('replaying a production snapshot', () => {
  let result: import('./seed-real.js').RealSeedResult

  beforeAll(async () => {
    result = await seedReal.seedFromProdSnapshot({ snapshot })
  }, 120_000)

  it('replays without a single refused transition', () => {
    expect(result.refusals).toEqual([])
  })

  it('carries the pull\'s drops through and adds its own, never silently', () => {
    const why = result.dropped.map((d) => d.why).join(' | ')
    expect(why).toContain('outside the 14-day window')
    expect(why).toMatch(/still pending at pull time/)
    expect(why).toMatch(/task_file_content/)
    expect(why).toMatch(/outside the pulled team/)
  })

  it('turns each run class into the right transition with the right provenance', async () => {
    const objects = await graph.listObjects(undefined, read.DEMO_TEAM_ID)
    const support = objects.find((o) => o.title === 'Support Inbox Triage')!
    const events = await graph.listObjectEvents(undefined, support.id)
    const byTransition = new Map(events.map((e) => [e.transition, e]))

    // the clock fires, the agent reports - two events, two entrances
    expect(byTransition.get('fire')?.entrance).toBe('clock')
    expect(byTransition.get('complete')?.entrance).toBe('agent-run')
    expect(byTransition.get('stand-down')).toBeTruthy() // the quiet run
    expect(byTransition.get('fail')).toBeTruthy() // the errored run
    expect(byTransition.get('skip')?.entrance).toBe('clock') // machine asleep
    expect(byTransition.get('evolve')?.entrance).toBe('agent-run')

    // the run's real metric state rides in the diff, not just in prose
    const complete = byTransition.get('complete')!
    expect(complete.diff?.['payload.handled']).toEqual({ old: null, new: 4 })
    // and the run's own message is the timeline line
    expect((complete.payload as Record<string, unknown>).note).toBe('Handled 4 conversations.')
  })

  it('ends a closed loop in `completed` and a disabled one in `paused`', async () => {
    const objects = await graph.listObjects(undefined, read.DEMO_TEAM_ID)
    const closed = objects.find((o) => o.title === 'PR #1085 edit-correction impact')!
    expect(closed.status).toBe('completed')
    const events = await graph.listObjectEvents(undefined, closed.id)
    expect(events.some((e) => e.transition === 'finish')).toBe(true)
  })

  it('opens a gate for exactly the waiting front-matter types', async () => {
    const open = await graph.listOpenObligations(undefined, read.DEMO_TEAM_ID, { class: 'human-verdict' })
    const objects = new Map((await graph.listObjects(undefined, read.DEMO_TEAM_ID)).map((o) => [o.id, o]))
    const waiting = open.map((o) => objects.get(o.objectId)?.title).sort()
    // needs_human, open and drafted wait; report, merged and no-front-matter do not.
    expect(waiting).toEqual(['A post waiting to go out', 'Remove a dead util', 'SUP-79 refund decision'])
  })

  it('creates a mirror for a PR a run referenced, at the honest `observed` status', async () => {
    const objects = await graph.listObjects(undefined, read.DEMO_TEAM_ID)
    const mirror = objects.find((o) => o.archetype === 'mirror')!
    expect(mirror.externalSource).toBe('github')
    expect(mirror.externalId).toBe('acme/widgets/pull/42')
    // We saw it referenced; we did not observe whether it merged.
    expect(mirror.status).toBe('observed')
  })

  it('renders the real fetched body of a v1-format artifact', async () => {
    const library = await read.libraryView()
    const product = library.artifacts.find((a) => a.title === 'Daily triage 2026-07-28')!
    expect(product.bodyAvailable).toBe(true)
    expect(product.renderMode).toBe('artifact')
    expect(product.html).toContain('four conversations')
    // the front-matter head is the machine head, not body content
    expect(product.html).not.toContain('type: report')
    expect(product.path).toBe('reports/2026-07-28.md')
    expect(product.originalType).toBe('report')
  })

  it('renders Markdown with no front matter as prose rather than an error', async () => {
    const library = await read.libraryView()
    const plain = library.artifacts.find((a) => a.title === 'scratch')!
    expect(plain.bodyAvailable).toBe(true)
    expect(plain.renderMode).toBe('markdown')
    expect(plain.html).toContain('still a real document')
  })

  it('renders a data file as a code block instead of mangling it as Markdown', async () => {
    const library = await read.libraryView()
    const json = library.artifacts.find((a) => a.title === 'Metrics')!
    expect(json.renderMode).toBe('code')
    expect(json.html).toContain('<code')
    expect(json.html).toContain('handled')
  })

  it('keeps the real task file as a document with its body', async () => {
    const library = await read.libraryView()
    const taskFile = library.artifacts.find((a) => a.title.endsWith('· task file'))!
    expect(taskFile.bodyAvailable).toBe(true)
    expect(taskFile.html).toContain('Watch the inbox')
  })

  it('states WHY a body is missing instead of showing a blank document', async () => {
    const library = await read.libraryView()
    const absent = library.artifacts.find((a) => a.title === 'Body not cached')!
    expect(absent.bodyAvailable).toBe(false)
    expect(absent.html).toBeUndefined()
    expect(absent.bodyAbsentReason).toMatch(/not in the local cache/)
  })

  it('never lets a body render raw HTML from an agent-written document', async () => {
    const library = await read.libraryView()
    for (const a of library.artifacts) {
      if (!a.html) continue
      expect(a.html).not.toMatch(/<script|<iframe|onerror=/i)
    }
  })

  it('titles an artifact with no front matter from its path rather than inventing one', async () => {
    const library = await read.libraryView()
    expect(library.artifacts.some((a) => a.title === 'scratch')).toBe(true)
  })

  it('never truncates the waiting list, only the settled archive', async () => {
    const library = await read.libraryView()
    const open = await graph.listOpenObligations(undefined, read.DEMO_TEAM_ID, { class: 'human-verdict' })
    expect(library.needsYou).toBe(open.length)
    expect(library.artifacts.filter((a) => a.needsHuman).length).toBe(open.length)
    expect(library.total).toBeGreaterThanOrEqual(library.artifacts.length)
  })

  it('is re-runnable: replaying the same snapshot converges', async () => {
    const again = await seedReal.seedFromProdSnapshot({ snapshot })
    expect(again.refusals).toEqual([])
    expect(again.objects).toBe(result.objects)
    expect(again.openObligations).toBe(result.openObligations)
  }, 120_000)
})
