// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPersisted,
  EMPTY,
  loadPersisted,
  markOnboardingDismissed,
  onboardingDismissed,
  prevNumbered,
  savePersisted,
  type Persisted,
} from './onboardingState'

/**
 * The wizard's resume/persistence + step-rail helpers. These back the two
 * behaviors the flow promises: a mid-flow reload resumes exactly where the user
 * left off (per team), and the homepage auto-starts onboarding at most once.
 */
afterEach(() => window.localStorage.clear())

describe('resume persistence (per team)', () => {
  it('round-trips the step + minted tokens + loopId for resume', () => {
    const state: Persisted = { step: 'live', machineId: 'm1', machineToken: 'dk_x', claimToken: 'ck_y', loopId: 'loop-1' }
    savePersisted('teamA', state)
    expect(loadPersisted('teamA')).toEqual(state)
  })

  it('scopes state by team key — team B does not see team A progress', () => {
    savePersisted('teamA', { step: 'meet', machineId: 'm1', machineToken: 't', claimToken: null, loopId: null })
    expect(loadPersisted('teamB')).toEqual(EMPTY)
  })

  it('a fresh workspace (no stored state) starts at welcome', () => {
    expect(loadPersisted('fresh')).toEqual(EMPTY)
  })

  it('a corrupt or unknown step restarts clean instead of throwing', () => {
    window.localStorage.setItem('loopany.onboarding.v1:bad', '{ not json')
    expect(loadPersisted('bad')).toEqual(EMPTY)
    window.localStorage.setItem('loopany.onboarding.v1:weird', JSON.stringify({ step: 'nope', machineId: 5 }))
    const loaded = loadPersisted('weird')
    expect(loaded.step).toBe('welcome')
    expect(loaded.machineId).toBeNull()
  })

  it('clearPersisted removes resume state', () => {
    savePersisted('t', { step: 'live', machineId: 'm', machineToken: 't', claimToken: 'c', loopId: 'loop-1' })
    clearPersisted('t')
    expect(loadPersisted('t')).toEqual(EMPTY)
  })
})

describe('dismissed trigger flag', () => {
  it('defaults to not-dismissed (a fresh workspace auto-starts)', () => {
    expect(onboardingDismissed('t')).toBe(false)
  })

  it('marks dismissed per team so the homepage never re-auto-starts', () => {
    markOnboardingDismissed('teamA')
    expect(onboardingDismissed('teamA')).toBe(true)
    expect(onboardingDismissed('teamB')).toBe(false)
  })
})

describe('prevNumbered (back navigation)', () => {
  it('walks back through the numbered steps and stops at the first', () => {
    expect(prevNumbered('welcome')).toBeUndefined()
    expect(prevNumbered('machine')).toBe('welcome')
    expect(prevNumbered('meet')).toBe('machine')
    expect(prevNumbered('prompt')).toBe('meet')
    expect(prevNumbered('live')).toBe('prompt')
  })
})
