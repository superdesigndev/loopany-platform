import { describe, expect, it } from 'vitest'

import type { Loop } from '../db/schema.js'
import type { TimelineRun } from '../db/store.js'
import { MAX_PROJECTED_PER_LOOP, projectFires, runToMark, sumCosts, toTimelineLoop } from './timeline.js'

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: 'l1',
    name: 'react-doctor',
    cron: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    completedAt: null,
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as Loop

const run = (over: Partial<TimelineRun> = {}): TimelineRun => ({
  id: 'r1',
  loopId: 'l1',
  ts: '2026-07-20T06:00:00.000Z',
  phase: 'done',
  role: 'exec',
  outcome: 'exec',
  status: 'resolved',
  durationMs: 60_000,
  costUsd: 1.25,
  message: 'ok',
  error: null,
  ...over,
})

describe('projectFires', () => {
  const from = new Date('2026-07-21T00:00:00.000Z')
  const to = new Date('2026-07-24T00:00:00.000Z')

  it('projects a daily cron across the window', () => {
    expect(projectFires(loop(), from, to)).toEqual([
      '2026-07-21T06:00:00.000Z',
      '2026-07-22T06:00:00.000Z',
      '2026-07-23T06:00:00.000Z',
    ])
  })

  it('honours the loop timezone', () => {
    // 06:00 in Tokyo (UTC+9) is 21:00 UTC the previous day.
    const fires = projectFires(loop({ timezone: 'Asia/Tokyo' }), from, to)
    expect(fires[0]).toBe('2026-07-21T21:00:00.000Z')
  })

  it('emits nothing for a disabled or completed loop', () => {
    expect(projectFires(loop({ enabled: false }), from, to)).toEqual([])
    expect(projectFires(loop({ completedAt: '2026-07-01T00:00:00.000Z' }), from, to)).toEqual([])
  })

  it('includes a pinned one-shot inside the window, deduped against the cron walk', () => {
    const fires = projectFires(loop({ nextRunAt: '2026-07-21T10:00:00.000Z' }), from, to)
    expect(fires).toContain('2026-07-21T10:00:00.000Z')
    // pinned fire does not suppress the regular cadence
    expect(fires).toContain('2026-07-22T06:00:00.000Z')
    expect(new Set(fires).size).toBe(fires.length)
  })

  it('ignores a pinned one-shot outside the window', () => {
    const fires = projectFires(loop({ nextRunAt: '2026-08-01T10:00:00.000Z' }), from, to)
    expect(fires).not.toContain('2026-08-01T10:00:00.000Z')
  })

  it('returns [] for an unparseable cron instead of throwing', () => {
    expect(() => projectFires(loop({ cron: 'not a cron' }), from, to)).not.toThrow()
    expect(projectFires(loop({ cron: 'not a cron' }), from, to)).toEqual([])
  })

  it('caps a pathologically frequent cron', () => {
    const fires = projectFires(loop({ cron: '* * * * *' }), from, to)
    expect(fires.length).toBe(MAX_PROJECTED_PER_LOOP)
  })

  it('emits nothing when the window is already past', () => {
    expect(projectFires(loop(), to, from)).toEqual([])
  })
})

describe('runToMark', () => {
  it('derives running/canceled from phase, matching toRunSummary', () => {
    expect(runToMark(run({ phase: 'running' })).running).toBe(true)
    expect(runToMark(run({ phase: 'pending' })).running).toBe(true)
    expect(runToMark(run({ phase: 'done' })).running).toBe(false)
    expect(runToMark(run({ phase: 'canceled' })).canceled).toBe(true)
  })

  it('carries the run id so a mark links to its run page', () => {
    const m = runToMark(run())
    expect(m.runId).toBe('r1')
    expect(m.kind).toBe('run')
  })
})

describe('sumCosts', () => {
  it('excludes null costs rather than counting them as zero', () => {
    const t = sumCosts([
      runToMark(run({ id: 'a', costUsd: 1.5 })),
      runToMark(run({ id: 'b', costUsd: null })),
      runToMark(run({ id: 'c', costUsd: 0.25 })),
    ])
    expect(t.runCount).toBe(3) // the unknown-cost run still happened
    expect(t.costUsd).toBe(1.75)
    expect(t.byLoop.l1).toBe(1.75)
  })

  it('ignores projected marks entirely', () => {
    const t = sumCosts([
      runToMark(run({ costUsd: 2 })),
      { ...runToMark(run()), kind: 'projected', runId: null, costUsd: null },
    ])
    expect(t.runCount).toBe(1)
    expect(t.costUsd).toBe(2)
  })

  it('splits spend per loop', () => {
    const t = sumCosts([
      runToMark(run({ id: 'a', loopId: 'l1', costUsd: 1 })),
      runToMark(run({ id: 'b', loopId: 'l2', costUsd: 3 })),
    ])
    expect(t.byLoop).toEqual({ l1: 1, l2: 3 })
  })

  it('rounds away float accumulation noise', () => {
    const t = sumCosts([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((c, i) => runToMark(run({ id: `r${i}`, costUsd: c }))))
    expect(t.costUsd).toBe(2.8)
  })
})

describe('toTimelineLoop', () => {
  it('carries a readable cadence rather than the raw cron', () => {
    expect(toTimelineLoop(loop()).cadence).toBe('daily 06:00')
    expect(toTimelineLoop(loop({ cron: '*/30 * * * *' })).cadence).toBe('every 30m')
  })

  it('falls back to the id when a loop is unnamed', () => {
    expect(toTimelineLoop(loop({ name: null })).name).toBe('l1')
  })
})
