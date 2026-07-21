import { describe, expect, it } from 'vitest'
import { cronText, isClosed, isCompleted } from './format'
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
    totalCostUsd: null,
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

/*
 * cronText is the ONE cron humaniser in the codebase — the loop card, the loop
 * form and the timeline lane label all read it, so a change here is visible in
 * three places at once. These pin the existing outputs plus the day-set cases
 * added for the timeline (which previously fell through to the raw expression).
 */
describe('cronText', () => {
  it('keeps its established outputs', () => {
    expect(cronText('0 6 * * *')).toBe('daily 06:00')
    expect(cronText('0 9 * * 1')).toBe('Mon 09:00')
    expect(cronText('*/30 * * * *')).toBe('every 30m')
    expect(cronText('0 */4 * * *')).toBe('every 4h')
    expect(cronText('15 * * * *')).toBe('hourly :15')
  })

  it('names day-of-week sets', () => {
    expect(cronText('0 6 * * 1,2,3,4,5')).toBe('weekdays 06:00')
    expect(cronText('0 6 * * 0,6')).toBe('weekends 06:00')
    expect(cronText('0 6 * * 1,4')).toBe('Mon/Thu 06:00')
    expect(cronText('0 6 * * 0,1,2,3,4,5,6')).toBe('daily 06:00')
  })

  it('accepts 7 as Sunday', () => {
    expect(cronText('0 6 * * 7')).toBe('Sun 06:00')
    expect(cronText('0 6 * * 0,7')).toBe('Sun 06:00')
  })

  it('falls back to the raw expression rather than guessing', () => {
    expect(cronText('0 5 1 * *')).toBe('0 5 1 * *')
    expect(cronText('0 9-17 * * *')).toBe('0 9-17 * * *')
    expect(cronText('0 6 * * 1-5')).toBe('0 6 * * 1-5')
    expect(cronText('0 0 5 * * *')).toBe('0 0 5 * * *')
    expect(cronText('')).toBe('')
  })
})
