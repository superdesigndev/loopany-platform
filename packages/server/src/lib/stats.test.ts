import { describe, expect, it } from 'vitest'
import { numericSeries, seriesRows } from './stats'
import type { RunSummary } from '../types'

const run = (ts: string, state: RunSummary['state']): RunSummary => ({
  id: `run-${ts}`,
  loopId: 'loop-1',
  ts,
  outcome: 'exec',
  status: 'nothing-new',
  message: null,
  durationMs: null,
  error: null,
  sample: null,
  state,
  control: null,
  sessionId: null,
  artifacts: null,
})

describe('numericSeries', () => {
  it('builds one chronological series per numeric field (newest-first input)', () => {
    const series = numericSeries([
      run('2026-06-17T00:00:00Z', { mrr: 9200 }),
      run('2026-06-16T00:00:00Z', { mrr: 9300 }),
    ])
    expect(series.mrr).toEqual([
      { t: '2026-06-16T00:00:00Z', v: 9300 },
      { t: '2026-06-17T00:00:00Z', v: 9200 },
    ])
  })
})

describe('seriesRows', () => {
  it('merges per-key series into chronological Recharts rows', () => {
    const series = numericSeries([
      run('2026-06-17T00:00:00Z', { mrr: 9200, paid: 41 }),
      run('2026-06-16T00:00:00Z', { mrr: 9300, paid: 40 }),
    ])
    expect(seriesRows(series, ['mrr', 'paid'])).toEqual([
      { __t: '2026-06-16T00:00:00Z', mrr: 9300, paid: 40 },
      { __t: '2026-06-17T00:00:00Z', mrr: 9200, paid: 41 },
    ])
  })

  it('leaves a key absent on rows where its run did not report it (gap, not zero)', () => {
    const series = numericSeries([
      run('2026-06-17T00:00:00Z', { mrr: 9200 }), // paid missing this run
      run('2026-06-16T00:00:00Z', { mrr: 9300, paid: 40 }),
    ])
    const rows = seriesRows(series, ['mrr', 'paid'])
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({ __t: '2026-06-17T00:00:00Z', mrr: 9200 })
    expect('paid' in rows[1]!).toBe(false)
  })

  it('keeps the timestamp intact when a metric is literally named "t"', () => {
    const series = numericSeries([run('2026-06-16T00:00:00Z', { t: 21.5 })])
    expect(seriesRows(series, ['t'])).toEqual([{ __t: '2026-06-16T00:00:00Z', t: 21.5 }])
  })

  it('ignores unknown keys and returns no rows when nothing matches', () => {
    expect(seriesRows({}, ['nope'])).toEqual([])
  })
})
