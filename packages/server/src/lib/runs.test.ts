import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../types'
import { mergeRuns } from './runs'

const run = (id: string, ts: string, over: Partial<RunSummary> = {}): RunSummary => ({
  id,
  loopId: 'loop-1',
  ts,
  outcome: 'exec',
  status: null,
  message: null,
  durationMs: null,
  costUsd: null,
  usage: null,
  error: null,
  state: null,
  control: null,
  sessionId: null,
  artifacts: null,
  ...over,
})

describe('mergeRuns', () => {
  it('merges two lists and re-sorts ascending by ts', () => {
    const newest = [run('c', '2026-06-30T03:00:00Z'), run('d', '2026-06-30T04:00:00Z')]
    const older = [run('a', '2026-06-30T01:00:00Z'), run('b', '2026-06-30T02:00:00Z')]
    expect(mergeRuns(newest, older).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('dedups by id with the first (fresher) occurrence winning', () => {
    // The same run id in both lists — the primary (fresh poll) carries the live
    // status, so its row must survive the merge, not the stale older copy.
    const fresh = run('b', '2026-06-30T02:00:00Z', { running: true })
    const stale = run('b', '2026-06-30T02:00:00Z', { running: false })
    const out = mergeRuns([fresh], [run('a', '2026-06-30T01:00:00Z'), stale])
    expect(out.map((r) => r.id)).toEqual(['a', 'b'])
    expect(out[1]!.running).toBe(true)
  })

  it('handles empty inputs', () => {
    expect(mergeRuns([], [])).toEqual([])
    const only = [run('a', '2026-06-30T01:00:00Z')]
    expect(mergeRuns(only, []).map((r) => r.id)).toEqual(['a'])
    expect(mergeRuns([], only).map((r) => r.id)).toEqual(['a'])
  })
})
