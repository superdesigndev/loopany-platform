import { describe, expect, it } from 'vitest'

/**
 * The CADENCE arithmetic, unit-tested directly - it is pure, so every property
 * here is asserted on exact instants rather than around a real clock.
 */
import {
  JITTER_WINDOW_MS,
  MIN_INTERVAL_MS,
  cadenceOf,
  describeCadence,
  hasCadence,
  jitterMsFor,
  nextFireAfter,
  parseCadence,
  parseInterval,
} from './cadence.js'

describe('parseInterval', () => {
  it('reads the unit suffixes and a bare count of ms', () => {
    expect(parseInterval('90s')).toBe(90_000)
    expect(parseInterval('2m')).toBe(120_000)
    expect(parseInterval('1h')).toBe(3_600_000)
    expect(parseInterval('1d')).toBe(86_400_000)
    expect(parseInterval('250ms')).toBe(250)
    expect(parseInterval('5000')).toBe(5_000)
    expect(parseInterval(7_500)).toBe(7_500)
  })

  it('refuses what it cannot read rather than guessing', () => {
    for (const bad of ['', 'soon', 'every 2m', '-5m', '0s', '2 weeks']) {
      expect(parseInterval(bad)).toBeUndefined()
    }
  })
})

describe('parseCadence', () => {
  it('accepts a cron expression and an interval, one at a time', () => {
    const cron = parseCadence({ cron: '0 7 * * *', timezone: 'Asia/Shanghai' })
    expect(cron.ok && cron.spec).toEqual({ cron: '0 7 * * *', timezone: 'Asia/Shanghai' })
    const every = parseCadence({ interval: '2m' })
    expect(every.ok && every.spec).toEqual({ intervalMs: 120_000 })
  })

  it('refuses both forms at once, neither form, a bad cron and a too-fast interval', () => {
    expect(parseCadence({ cron: '0 7 * * *', interval: '2m' })).toMatchObject({ ok: false })
    expect(parseCadence({})).toMatchObject({ ok: false })
    expect(parseCadence({ cron: 'not a cron' })).toMatchObject({ ok: false })
    expect(parseCadence({ interval: `${MIN_INTERVAL_MS - 1}` })).toMatchObject({ ok: false })
  })
})

describe('jitter', () => {
  it('is deterministic per object and inside the window', () => {
    const a = jitterMsFor('obj-alpha')
    expect(jitterMsFor('obj-alpha')).toBe(a)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(JITTER_WINDOW_MS)
  })

  it('differs between objects, which is the whole point', () => {
    const spread = new Set(Array.from({ length: 40 }, (_, i) => jitterMsFor(`obj-${i}`)))
    // 40 objects into a 120s window: collisions are possible but a near-constant
    // hash would show up as a tiny set. Anything above ~30 distinct means the
    // fleet's 07:00 fires are genuinely spread.
    expect(spread.size).toBeGreaterThan(30)
  })
})

describe('nextFireAfter', () => {
  it('puts two objects on the same cron line at DIFFERENT instants', () => {
    const spec = { cron: '0 7 * * *', timezone: 'UTC' }
    const a = nextFireAfter(spec, '2026-07-30T09:00:00.000Z', 'obj-a')!
    const b = nextFireAfter(spec, '2026-07-30T09:00:00.000Z', 'obj-b')!
    expect(a).not.toBe(b)
    // Both land on the same occurrence, offset only by their own jitter.
    for (const iso of [a, b]) {
      const offset = Date.parse(iso) - Date.parse('2026-07-31T07:00:00.000Z')
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThan(JITTER_WINDOW_MS)
    }
  })

  it('is epoch-anchored for an interval, so a late fire cannot make it drift', () => {
    const spec = { intervalMs: 120_000 }
    // A cursor computed from a LATE instant lands on the same grid as one computed
    // from the intended instant - the grid is `k · interval`, not `last + interval`.
    const onTime = nextFireAfter(spec, '2026-07-30T09:00:00.000Z', 'obj-drift')!
    const late = nextFireAfter(spec, '2026-07-30T09:00:31.000Z', 'obj-drift')!
    const grid = (iso: string) => (Date.parse(iso) - jitterMsFor('obj-drift')) % 120_000
    expect(grid(onTime)).toBe(0)
    expect(grid(late)).toBe(0)
  })

  it('always returns an instant STRICTLY after the one it was asked about', () => {
    const spec = { intervalMs: MIN_INTERVAL_MS }
    let cursor = '2026-07-30T09:00:00.000Z'
    for (let i = 0; i < 5; i++) {
      const next = nextFireAfter(spec, cursor, 'obj-monotonic')!
      expect(Date.parse(next)).toBeGreaterThan(Date.parse(cursor))
      cursor = next
    }
  })

  it('COLLAPSES a backlog: one fire owed however long the outage', () => {
    const spec = { intervalMs: 120_000 }
    // The cursor was due at 09:00; the process was down until 09:07 (three and a
    // half intervals). The next cursor is one step past NOW - not 09:02, and not a
    // queue of the three occurrences that were missed.
    const next = nextFireAfter(spec, '2026-07-30T09:07:00.000Z', 'obj-catchup')!
    expect(Date.parse(next)).toBeGreaterThan(Date.parse('2026-07-30T09:07:00.000Z'))
    expect(Date.parse(next)).toBeLessThanOrEqual(Date.parse('2026-07-30T09:09:00.000Z') + JITTER_WINDOW_MS)
  })

  it('returns undefined for a cadence with no future occurrence', () => {
    expect(nextFireAfter({ cron: '0 0 30 2 *' }, '2026-07-30T09:00:00.000Z', 'obj-never')).toBeUndefined()
    expect(nextFireAfter({}, '2026-07-30T09:00:00.000Z', 'obj-none')).toBeUndefined()
  })
})

describe('describeCadence / hasCadence / cadenceOf', () => {
  it('names both forms in human units', () => {
    expect(describeCadence({ cron: '0 7 * * *' })).toBe('0 7 * * *')
    expect(describeCadence({ cron: '0 7 * * *', timezone: 'Asia/Shanghai' })).toBe('0 7 * * * (Asia/Shanghai)')
    expect(describeCadence({ intervalMs: 120_000 })).toBe('every 2m')
    expect(describeCadence({ intervalMs: 90_000 })).toBe('every 90s')
    expect(describeCadence({ intervalMs: 7_200_000 })).toBe('every 2h')
    expect(describeCadence({})).toBe('no cadence')
  })

  it('reads the two schedule columns of a row as one value', () => {
    expect(cadenceOf({ cron: '0 7 * * *', intervalMs: null, timezone: 'UTC' })).toEqual({
      cron: '0 7 * * *',
      intervalMs: null,
      timezone: 'UTC',
    })
    expect(hasCadence({ cron: null, intervalMs: null })).toBe(false)
    expect(hasCadence({ cron: null, intervalMs: 5_000 })).toBe(true)
  })
})
