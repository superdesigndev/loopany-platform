import { describe, expect, it } from 'vitest'

import {
  SEED_ARM_ENV,
  SEED_ARM_IN_ENV,
  SEEDED_WORKFLOWS,
  armMatches,
  configuredArms,
  firstFireAt,
  workflowFor,
} from './seed-arm.js'

/**
 * The ARM config, pinned as pure functions.
 *
 * The costly mistakes here are asymmetric: arming something nobody asked for is a
 * deployed workspace dispatching real work on its own, and failing to arm is a
 * demo that quietly does nothing. So the default (arm NOTHING) and the
 * exact-match rule are both probed directly.
 */

const loop = { id: 'loop-mr4clp9j-3440d2a0', name: 'Daily react-doctor triage' }

describe('seed arm config', () => {
  it('arms NOTHING by default', () => {
    expect(configuredArms({})).toBeNull()
    expect(configuredArms({ [SEED_ARM_ENV]: '   ' })).toBeNull()
    expect(configuredArms({ [SEED_ARM_ENV]: ' , , ' })).toBeNull()
  })

  it('reads a comma list, and the optional first-fire offset', () => {
    expect(configuredArms({ [SEED_ARM_ENV]: 'A, B' })).toEqual([{ key: 'A' }, { key: 'B' }])
    expect(configuredArms({ [SEED_ARM_ENV]: 'A', [SEED_ARM_IN_ENV]: '3' })).toEqual([
      { key: 'A', firstFireInMinutes: 3 },
    ])
    // Junk in the offset is ignored rather than guessed at: the natural occurrence
    // is the safe reading of "I could not understand when you wanted this".
    expect(configuredArms({ [SEED_ARM_ENV]: 'A', [SEED_ARM_IN_ENV]: 'soon' })).toEqual([{ key: 'A' }])
    expect(configuredArms({ [SEED_ARM_ENV]: 'A', [SEED_ARM_IN_ENV]: '-5' })).toEqual([{ key: 'A' }])
  })

  it('matches a loop by name (case-insensitive) or by id, exactly', () => {
    expect(armMatches({ key: 'Daily react-doctor triage' }, loop)).toBe(true)
    expect(armMatches({ key: 'daily REACT-doctor triage' }, loop)).toBe(true)
    expect(armMatches({ key: loop.id }, loop)).toBe(true)
    // A prefix is NOT a match - the same rule the seed scope keeps, so one spelling
    // works in both variables and neither silently reaches something else.
    expect(armMatches({ key: 'Daily react-doctor' }, loop)).toBe(false)
  })

  it('carries an authored workflow for every loop it can arm', () => {
    const workflow = workflowFor(loop)
    expect(workflow).toBeTruthy()
    // The two properties that make it a TRIAGE run rather than the production loop:
    // it says plainly that it does not write, and its outputs are the graph verbs.
    expect(workflow).toContain('TRIAGE ONLY')
    expect(workflow).toContain('graph task create')
    expect(workflow).toContain('graph artifact push')
    expect(workflow).toContain('graph review request')
    expect(workflow).toContain('context.alreadyRecorded')
    // …and it is pinned to the analyzer version the fleet has a baseline for, with
    // the reason stated: two upgrades already destroyed score comparability, so a
    // run that reaches for `@latest` reports a score nobody can compare.
    expect(workflow).toContain('react-doctor@0.7.4')
    expect(workflow).toContain('never `@latest`')
    expect(workflow).not.toContain('react-doctor@latest')
  })

  it('has no workflow for a loop nobody authored one for', () => {
    expect(workflowFor({ id: 'loop-x', name: 'Housekeeper' })).toBeUndefined()
    expect(Object.keys(SEEDED_WORKFLOWS)).toEqual(['Daily react-doctor triage'])
  })

  it('turns a minute offset into an instant, and no offset into nothing', () => {
    const now = '2026-07-31T03:00:00.000Z'
    expect(firstFireAt({ key: 'A', firstFireInMinutes: 3 }, now)).toBe('2026-07-31T03:03:00.000Z')
    expect(firstFireAt({ key: 'A' }, now)).toBeUndefined()
  })
})
