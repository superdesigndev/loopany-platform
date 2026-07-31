import { describe, expect, it } from 'vitest'

import type { ProdSnapshot } from './pull-prod.js'
import {
  SEED_LOOPS_ENV,
  configuredSeedLoops,
  restrictConfiguredSnapshot,
  restrictSnapshot,
} from './snapshot-scope.js'

/**
 * The SEED SCOPE, pinned as a pure function.
 *
 * What matters here is what a mistake costs: an over-wide match seeds content a
 * deploy was told not to carry, and a silent miss seeds nothing at all. Both are
 * probed directly.
 */

function loop(id: string, name: string): ProdSnapshot['loops'][number] {
  return {
    id,
    name,
    cron: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    agent: 'claude-code',
    goal: null,
    completedAt: null,
    completionReason: null,
    taskFile: null,
    taskFileContent: null,
    state: null,
    machineId: 'm-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    runCount: 3,
  }
}

function run(id: string, loopId: string): ProdSnapshot['runs'][number] {
  return {
    id,
    loopId,
    phase: 'done',
    role: 'exec',
    ts: '2026-07-20T06:00:00.000Z',
    outcome: 'exec',
    status: 'new',
    message: null,
    error: null,
    durationMs: 1000,
    costUsd: 0.1,
    state: null,
    sessionId: null,
  }
}

function file(loopId: string, path: string): ProdSnapshot['files'][number] {
  return { loopId, path, hash: `h-${path}`, size: 10, binary: false, updatedAt: '2026-07-20T06:00:00.000Z', meta: null }
}

function snapshot(): ProdSnapshot {
  return {
    pulledAt: '2026-07-29T08:00:00.000Z',
    source: 'loopany-production',
    team: { id: 'team-fixture', name: 'Fixture' },
    window: { days: 14, maxRuns: 900, maxFilesPerLoop: 20 },
    machines: 2,
    loops: [loop('loop-a', 'Daily react-doctor triage'), loop('loop-b', 'React Doctor daily health'), loop('loop-c', 'Housekeeper')],
    runs: [run('r1', 'loop-a'), run('r2', 'loop-b'), run('r3', 'loop-c'), run('r4', 'loop-a')],
    files: [file('loop-a', 'a.md'), file('loop-b', 'b.md'), file('loop-c', 'c.md')],
    dropped: [{ what: 'runs', count: 5, why: 'outside the window' }],
  }
}

describe('seed scope', () => {
  it('keeps only the named loop and everything hanging off it', () => {
    const out = restrictSnapshot(snapshot(), ['Daily react-doctor triage'])
    expect(out.kept).toEqual(['Daily react-doctor triage'])
    expect(out.excluded.sort()).toEqual(['Housekeeper', 'React Doctor daily health'])
    expect(out.snapshot.loops.map((l) => l.id)).toEqual(['loop-a'])
    expect(out.snapshot.runs.map((r) => r.id)).toEqual(['r1', 'r4'])
    expect(out.snapshot.files.map((f) => f.path)).toEqual(['a.md'])
  })

  it('reports what it left behind on the snapshot own dropped ledger', () => {
    const out = restrictSnapshot(snapshot(), ['Daily react-doctor triage'])
    // The pull's own drop survives; the scope's drops are appended.
    expect(out.snapshot.dropped[0]).toEqual({ what: 'runs', count: 5, why: 'outside the window' })
    const scoped = out.snapshot.dropped.filter((d) => d.why.includes(SEED_LOOPS_ENV))
    expect(scoped.map((d) => [d.what, d.count])).toEqual([
      ['loops', 2],
      ['runs', 2],
      ['artifact files', 2],
    ])
  })

  it('matches EXACTLY, so a shorter name never pulls in a longer one', () => {
    // "React Doctor" is a prefix of "React Doctor daily health"; a substring rule
    // would keep a loop the operator did not name.
    expect(() => restrictSnapshot(snapshot(), ['React Doctor'])).toThrow(/does not contain/)
  })

  it('matches a loop id too', () => {
    const out = restrictSnapshot(snapshot(), ['loop-b'])
    expect(out.kept).toEqual(['React Doctor daily health'])
  })

  it('is case-insensitive on the name', () => {
    expect(restrictSnapshot(snapshot(), ['housekeeper']).kept).toEqual(['Housekeeper'])
  })

  it('THROWS on an entry that matches nothing, naming what is available', () => {
    expect(() => restrictSnapshot(snapshot(), ['Housekeeper', 'Nope'])).toThrow(/Nope/)
    expect(() => restrictSnapshot(snapshot(), ['Nope'])).toThrow(/Housekeeper/)
  })

  it('is idempotent - re-restricting its own output changes nothing', () => {
    const once = restrictSnapshot(snapshot(), ['Housekeeper'])
    const twice = restrictSnapshot(once.snapshot, ['Housekeeper'])
    expect(twice.snapshot).toEqual(once.snapshot)
    expect(twice.excluded).toEqual([])
  })

  it('an unset scope is the WHOLE snapshot', () => {
    expect(configuredSeedLoops({})).toBeNull()
    expect(configuredSeedLoops({ [SEED_LOOPS_ENV]: '  ,  ' })).toBeNull()
    const out = restrictConfiguredSnapshot(snapshot(), {})
    expect(out.snapshot.loops).toHaveLength(3)
    expect(out.excluded).toEqual([])
  })

  it('reads a comma list off the environment', () => {
    expect(configuredSeedLoops({ [SEED_LOOPS_ENV]: 'A, B ,, C' })).toEqual(['A', 'B', 'C'])
    const out = restrictConfiguredSnapshot(snapshot(), { [SEED_LOOPS_ENV]: 'Housekeeper' })
    expect(out.kept).toEqual(['Housekeeper'])
  })
})
