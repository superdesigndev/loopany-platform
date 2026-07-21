import { describe, expect, it } from 'vitest'

import type { TimelineLoop, TimelineMark } from '../types'
import { visibleLanes, windowFor } from './LoopTimeline'

const loop = (id: string): TimelineLoop => ({
  id,
  name: id,
  cron: '0 6 * * *',
  timezone: null,
  enabled: true,
  completedAt: null,
  cadence: 'daily 06:00',
  machineId: 'm1',
})

const mark = (loopId: string, kind: TimelineMark['kind'] = 'run'): TimelineMark => ({
  loopId,
  ts: '2026-07-21T06:00:00.000Z',
  runId: kind === 'run' ? 'r1' : null,
  kind,
  running: false,
  canceled: false,
  role: 'exec',
  outcome: kind === 'run' ? 'exec' : null,
  status: null,
  durationMs: 60_000,
  costUsd: null,
  message: null,
  error: null,
})

/*
 * A loop with nothing in the window draws an unbroken empty track — noise at day
 * zoom, where most loops aren't due. Hidden by default, but NEVER silently: a
 * dropped loop is exactly the "is anything dead?" signal this view exists for,
 * so the count has to survive for the reveal control.
 */
describe('visibleLanes', () => {
  it('hides lanes with nothing in the window and counts them', () => {
    const { lanes, idleCount } = visibleLanes([loop('a'), loop('b'), loop('c')], [mark('a')], false)
    expect(lanes.map((l) => l.id)).toEqual(['a'])
    expect(idleCount).toBe(2)
  })

  it('counts a projected-only lane as active — an upcoming fire is content', () => {
    const { lanes, idleCount } = visibleLanes([loop('a'), loop('b')], [mark('b', 'projected')], false)
    expect(lanes.map((l) => l.id)).toEqual(['b'])
    expect(idleCount).toBe(1)
  })

  it('keeps every lane when the reveal is on, and still reports the count', () => {
    const { lanes, idleCount } = visibleLanes([loop('a'), loop('b')], [mark('a')], true)
    expect(lanes.map((l) => l.id)).toEqual(['a', 'b'])
    // The control must keep saying "hide N" while revealed, so the count stands.
    expect(idleCount).toBe(1)
  })

  it('preserves lane order rather than resorting', () => {
    const { lanes } = visibleLanes([loop('c'), loop('a'), loop('b')], [mark('a'), mark('c')], false)
    expect(lanes.map((l) => l.id)).toEqual(['c', 'a'])
  })

  it('hides everything when the window is empty', () => {
    const { lanes, idleCount } = visibleLanes([loop('a'), loop('b')], [], false)
    expect(lanes).toEqual([])
    expect(idleCount).toBe(2)
  })
})

describe('windowFor', () => {
  const at = new Date('2026-07-21T15:40:00')

  it('day spans the calendar day containing now', () => {
    const { from, to } = windowFor('day', at)
    expect(from.getHours()).toBe(0)
    expect(from.getMinutes()).toBe(0)
    expect(to.getTime() - from.getTime()).toBe(86_400_000)
  })

  it('week and month both straddle now, so the view is part history part forecast', () => {
    for (const z of ['week', 'month'] as const) {
      const { from, to } = windowFor(z, at)
      expect(from.getTime()).toBeLessThan(at.getTime())
      expect(to.getTime()).toBeGreaterThan(at.getTime())
    }
  })
})
