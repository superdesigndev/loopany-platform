import { describe, expect, it } from 'vitest'
import { firstRunFinished, firstRunStateFrom } from './firstRun'

/**
 * The first-run wait-state branch table. The wizard hands off into the Loop page on
 * 'done'/'failed', shows a live in-progress state on 'running', and gives an honest
 * scheduled handoff (never a spinner-trap) on 'scheduled'.
 */
describe('firstRunStateFrom', () => {
  it('a run that finished OK → done (the payoff)', () => {
    expect(firstRunStateFrom({ phase: 'done', hasRun: true, machineOnline: true })).toBe('done')
  })

  it('a run that finished with an error → failed (hand off, but never claim success)', () => {
    expect(firstRunStateFrom({ phase: 'error', hasRun: true, machineOnline: false })).toBe('failed')
  })

  it('both terminal outcomes count as finished (both hand off into the run page)', () => {
    expect(firstRunFinished('done')).toBe(true)
    expect(firstRunFinished('failed')).toBe(true)
    expect(firstRunFinished('running')).toBe(false)
    expect(firstRunFinished('scheduled')).toBe(false)
  })

  it('an in-flight run → running (live in-progress)', () => {
    expect(firstRunStateFrom({ phase: 'running', hasRun: true, machineOnline: true })).toBe('running')
  })

  it('a queued run on an ONLINE machine → running (about to start)', () => {
    expect(firstRunStateFrom({ phase: 'pending', hasRun: true, machineOnline: true })).toBe('running')
  })

  it('a queued run on an OFFLINE machine → scheduled (honest handoff, no spinner-trap)', () => {
    expect(firstRunStateFrom({ phase: 'pending', hasRun: true, machineOnline: false })).toBe('scheduled')
  })

  it('no run yet: online → running (starting), offline → scheduled', () => {
    expect(firstRunStateFrom({ phase: null, hasRun: false, machineOnline: true })).toBe('running')
    expect(firstRunStateFrom({ phase: null, hasRun: false, machineOnline: false })).toBe('scheduled')
  })

  it('a superseded/canceled run → scheduled (nothing to watch here)', () => {
    expect(firstRunStateFrom({ phase: 'canceled', hasRun: true, machineOnline: true })).toBe('scheduled')
  })
})
