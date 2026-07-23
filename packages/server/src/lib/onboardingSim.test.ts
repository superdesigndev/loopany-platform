import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { onboardingSimEnabled } from './onboardingSim'

/**
 * The dev-sim gate is the security boundary for the onboarding demo shim: the
 * simulate-machine-connect / simulate-loop-created server fns refuse to act unless
 * this returns true, and the wizard only renders their buttons when `getConfig`
 * echoes it. So the ONE invariant that keeps the shim out of production is: a
 * production build is OFF regardless of the env flag.
 */
describe('onboardingSimEnabled', () => {
  const orig = { node: process.env.NODE_ENV, flag: process.env.LOOPANY_ONBOARDING_SIM }
  beforeEach(() => {
    delete process.env.NODE_ENV
    delete process.env.LOOPANY_ONBOARDING_SIM
  })
  afterEach(() => {
    process.env.NODE_ENV = orig.node
    process.env.LOOPANY_ONBOARDING_SIM = orig.flag
  })

  it('is OFF in a production build even with the opt-in flag set (unreachable in prod)', () => {
    process.env.NODE_ENV = 'production'
    for (const on of ['1', 'on', 'true', 'yes']) {
      process.env.LOOPANY_ONBOARDING_SIM = on
      expect(onboardingSimEnabled()).toBe(false)
    }
  })

  it('is OFF in a dev build when the flag is unset or falsy', () => {
    process.env.NODE_ENV = 'development'
    expect(onboardingSimEnabled()).toBe(false)
    for (const off of ['', '0', 'off', 'false', 'no', 'nope']) {
      process.env.LOOPANY_ONBOARDING_SIM = off
      expect(onboardingSimEnabled()).toBe(false)
    }
  })

  it('is ON only in a non-production build with an explicit truthy opt-in', () => {
    for (const node of ['development', 'test', undefined]) {
      if (node === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = node
      for (const on of ['1', 'on', 'true', 'yes', 'YES', 'On']) {
        process.env.LOOPANY_ONBOARDING_SIM = on
        expect(onboardingSimEnabled()).toBe(true)
      }
    }
  })
})
