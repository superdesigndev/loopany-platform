import { describe, expect, it } from 'vitest'
import { isClosed, isCompleted } from './format'
import type { JobSummary } from '../types'

/** Minimal JobSummary factory — only the goal/completedAt fields matter here. */
function job(over: Partial<JobSummary>): JobSummary {
  return {
    id: 'l1',
    name: 'L',
    cron: '0 8 * * *',
    kind: 'exec:claude-code',
    enabled: true,
    notify: 'auto',
    nextRun: null,
    lastRunTs: null,
    graduation: null,
    runs: [],
    runCount: 0,
    ...over,
  }
}

describe('isCompleted / isClosed (open vs closed loop states)', () => {
  it('isCompleted is driven purely by completedAt, not the old disabled+resolved heuristic', () => {
    expect(isCompleted(job({ completedAt: '2026-07-01T00:00:00Z' }))).toBe(true)
    // A merely paused loop (disabled, no completedAt) is NOT completed — it stays active.
    expect(isCompleted(job({ enabled: false }))).toBe(false)
    expect(isCompleted(job({}))).toBe(false)
    expect(isCompleted(job({ completedAt: null }))).toBe(false)
  })

  it('isClosed reflects goal presence (open loop = no goal)', () => {
    expect(isClosed(job({ goal: 'reach 100 signups' }))).toBe(true)
    expect(isClosed(job({ goal: null }))).toBe(false)
    expect(isClosed(job({ goal: '' }))).toBe(false)
    expect(isClosed(job({}))).toBe(false)
  })
})
