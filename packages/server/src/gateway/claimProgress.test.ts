import { afterEach, describe, expect, it } from 'vitest'
import { CREATION_STEP_KEYS } from '../lib/creationSteps'
import { clearClaimProgress, readClaimProgress, recordClaimProgress } from './tokens'

/**
 * The in-memory claim-progress store behind the wizard's live checklist. It is an
 * untrusted ingress (a public endpoint feeds it), so it must reject non-enum steps
 * and tolerate repeats/out-of-order without ever storing free text.
 */
const TOKEN = 'dk_progress_test_token'
afterEach(() => clearClaimProgress(TOKEN))

describe('recordClaimProgress / readClaimProgress', () => {
  it('records enum steps and reads them back (dedup, insertion order preserved)', () => {
    recordClaimProgress(TOKEN, CREATION_STEP_KEYS[0]!)
    recordClaimProgress(TOKEN, CREATION_STEP_KEYS[1]!)
    recordClaimProgress(TOKEN, CREATION_STEP_KEYS[0]!) // repeat — de-duped
    expect(readClaimProgress(TOKEN)).toEqual([CREATION_STEP_KEYS[0], CREATION_STEP_KEYS[1]])
  })

  it('drops non-enum / free-text steps at the storage boundary (defense-in-depth)', () => {
    recordClaimProgress(TOKEN, 'reading') // valid
    recordClaimProgress(TOKEN, 'drop table users')
    recordClaimProgress(TOKEN, '')
    recordClaimProgress(TOKEN, 'READING')
    expect(readClaimProgress(TOKEN)).toEqual(['reading'])
  })

  it('an unknown token reads as empty (absent agent → plain waiting state)', () => {
    expect(readClaimProgress('dk_never_seen')).toEqual([])
  })

  it('clearClaimProgress removes the entry', () => {
    recordClaimProgress(TOKEN, 'reading')
    clearClaimProgress(TOKEN)
    expect(readClaimProgress(TOKEN)).toEqual([])
  })
})
