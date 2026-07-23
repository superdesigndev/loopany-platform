import { describe, expect, it } from 'vitest'
import { CREATION_STEP_KEYS, deriveStepStates, isCreationStep, stepIndex } from './creationSteps'

/**
 * The live-checklist step vocabulary + derivation. Agents are unreliable narrators,
 * so `deriveStepStates` must tolerate skipped, repeated, out-of-order, absent, and
 * junk reports; `isCreationStep` is the enum gate that rejects free text.
 */
describe('isCreationStep (enum gate)', () => {
  it('accepts exactly the fixed keys', () => {
    for (const k of CREATION_STEP_KEYS) expect(isCreationStep(k)).toBe(true)
  })
  it('rejects free text, near-misses, and non-strings', () => {
    for (const bad of ['', 'Reading', 'reading ', 'done', 'drop table', 42, null, undefined, {}, ['reading']]) {
      expect(isCreationStep(bad)).toBe(false)
    }
  })
})

describe('deriveStepStates (tolerant)', () => {
  const N = CREATION_STEP_KEYS.length

  it('nothing reported → first step active, rest pending (a live "starting" state)', () => {
    expect(deriveStepStates([])).toEqual(['active', ...Array(N - 1).fill('pending')])
  })

  it('an in-order report marks passed steps done and the next active', () => {
    // reported first two → indices 0,1 done, 2 active, rest pending
    const s = deriveStepStates([CREATION_STEP_KEYS[0]!, CREATION_STEP_KEYS[1]!])
    expect(s[0]).toBe('done')
    expect(s[1]).toBe('done')
    expect(s[2]).toBe('active')
    expect(s[3]).toBe('pending')
  })

  it('tolerates a SKIPPED intermediate step (a later report lights earlier ones)', () => {
    // report step 0 and step 2, skipping 1 → 0,1,2 all done, 3 active
    const s = deriveStepStates([CREATION_STEP_KEYS[0]!, CREATION_STEP_KEYS[2]!])
    expect(s.slice(0, 3)).toEqual(['done', 'done', 'done'])
    expect(s[3]).toBe('active')
  })

  it('tolerates OUT-OF-ORDER and REPEATED reports (keys off the highest index)', () => {
    const s = deriveStepStates([CREATION_STEP_KEYS[2]!, CREATION_STEP_KEYS[0]!, CREATION_STEP_KEYS[2]!])
    expect(s.slice(0, 3)).toEqual(['done', 'done', 'done'])
    expect(s[3]).toBe('active')
  })

  it('ignores UNKNOWN keys entirely (junk never advances the checklist)', () => {
    expect(deriveStepStates(['bogus', 'drop table', ''])).toEqual(['active', ...Array(N - 1).fill('pending')])
  })

  it('the final step reported marks every step done, none active', () => {
    const s = deriveStepStates(CREATION_STEP_KEYS)
    expect(s.every((x) => x === 'done')).toBe(true)
  })

  it('stepIndex maps keys to order and returns -1 for junk', () => {
    expect(stepIndex(CREATION_STEP_KEYS[0]!)).toBe(0)
    expect(stepIndex('nope')).toBe(-1)
  })
})

describe('sim sequence progression', () => {
  it('feeding the canonical sequence one-by-one walks the active cursor to the end', () => {
    const seen: string[] = []
    const activeIdx: number[] = []
    for (const k of CREATION_STEP_KEYS) {
      seen.push(k)
      activeIdx.push(deriveStepStates(seen).findIndex((s) => s === 'active'))
    }
    // After each report the active cursor advances; after the last there is no active (-1).
    expect(activeIdx).toEqual([1, 2, 3, 4, -1])
  })
})
