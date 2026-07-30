/**
 * SENSING pipe 1 - the PURE half, tested directly.
 *
 * Everything the dedup invariant rests on is a pure function, so it is asserted
 * here without a database: identity round-trips, the diff's "nothing changed"
 * answer, and the event-id derivation that makes a re-poll free. The integration
 * probes (`sensing.integration.test.ts`) then prove the same properties hold once
 * real rows are involved.
 */
import { describe, expect, it } from 'vitest'

import {
  OBSERVED_FIELDS,
  conditionOf,
  diffObservation,
  mirrorStatusFor,
  observationEventId,
  observedFromPayload,
  observedPayload,
  parsePrExternalId,
  prExternalId,
  referencedPrs,
  waitSatisfied,
  type ObservedPr,
} from './pr.js'

const PR: ObservedPr = {
  repo: 'superdesigndev/loopany-platform',
  number: 1291,
  state: 'open',
  merged: false,
  checks: 'pending',
  title: 'a real pull request',
  draft: false,
}

describe('mirror identity round-trips', () => {
  it('parses exactly the external ids the seeders write', () => {
    expect(prExternalId(PR)).toBe('superdesigndev/loopany-platform/pull/1291')
    expect(parsePrExternalId(prExternalId(PR))).toEqual({ repo: PR.repo, number: PR.number })
  })

  it('refuses anything that is not a pull-request external id', () => {
    // The poller must only ever act on rows it understands - an issue mirror, a
    // Linear ticket or a malformed row has to come back undefined rather than
    // being coerced into a PR number.
    for (const bad of ['org/repo/issues/1291', 'org/repo/pull/', 'org/repo/pull/abc', 'pull/12', '', null, undefined]) {
      expect(parsePrExternalId(bad)).toBeUndefined()
    }
  })
})

describe('the observed status is a projection, never an invention', () => {
  it('maps the real combinations onto PULL_REQUEST_SPEC states', () => {
    expect(mirrorStatusFor({ state: 'merged', merged: true, checks: 'passing', draft: false })).toBe('merged')
    // `merged` wins even when the state field disagrees: a disagreement should
    // never downgrade a merge.
    expect(mirrorStatusFor({ state: 'open', merged: true, checks: 'none', draft: false })).toBe('merged')
    expect(mirrorStatusFor({ state: 'closed', merged: false, checks: 'failing', draft: false })).toBe('closed')
    expect(mirrorStatusFor({ state: 'open', merged: false, checks: 'passing', draft: false })).toBe('checks-green')
    expect(mirrorStatusFor({ state: 'open', merged: false, checks: 'pending', draft: false })).toBe('open')
    // Green checks on a DRAFT are not an invitation to merge.
    expect(mirrorStatusFor({ state: 'open', merged: false, checks: 'passing', draft: true })).toBe('open')
  })
})

describe('the diff is what makes re-polling free', () => {
  it('reports every field on a first observation', () => {
    const changes = diffObservation(null, 'observed', PR)
    expect(changes.map((c) => c.field)).toEqual([...OBSERVED_FIELDS])
    // `from` is null for a fact we had never observed - not "false", not a guess.
    expect(changes.find((c) => c.field === 'state')!.from).toBeNull()
    expect(changes.find((c) => c.field === 'status')).toEqual({ field: 'status', from: 'observed', to: 'open' })
  })

  it('reports NOTHING when the same facts come back', () => {
    // THE load-bearing assertion of the whole pipe: an unchanged upstream must
    // produce an empty change list, so a sweep writes zero rows and may run
    // forever.
    expect(diffObservation(observedPayload(PR), mirrorStatusFor(PR), PR)).toEqual([])
  })

  it('reports only the field that moved', () => {
    const stored = observedPayload(PR)
    const changes = diffObservation(stored, 'open', { ...PR, checks: 'passing' })
    // checks moved, and the status it projects onto moved with it. `state`,
    // `merged` and `title` did not, so they are absent - the diff answers "what
    // changed", and a field listed with old === new would be noise.
    expect(changes.map((c) => c.field)).toEqual(['checks', 'status'])
    expect(changes[0]).toEqual({ field: 'checks', from: 'pending', to: 'passing' })
    expect(changes[1]).toEqual({ field: 'status', from: 'open', to: 'checks-green' })
  })

  it('treats an absent field and null as the same absence', () => {
    // A mirror that has never carried `draft` is not "different from null"; it is
    // unobserved, and an observation of `false` there is still a real first fact.
    const changes = diffObservation({ state: 'open', merged: false, checks: 'pending', title: PR.title }, 'open', PR)
    expect(changes).toEqual([])
  })
})

describe('the event id is derived from the change, never from a window', () => {
  it('is stable across derivations of the same change', () => {
    const change = { field: 'status' as const, from: 'open', to: 'merged' }
    expect(observationEventId(PR, change)).toBe(observationEventId(PR, change))
  })

  it('separates PRs, fields and values', () => {
    const ids = new Set([
      observationEventId(PR, { field: 'status', from: 'open', to: 'merged' }),
      observationEventId({ ...PR, number: 1292 }, { field: 'status', from: 'open', to: 'merged' }),
      observationEventId({ ...PR, repo: 'other/repo' }, { field: 'status', from: 'open', to: 'merged' }),
      observationEventId(PR, { field: 'state', from: 'open', to: 'merged' }),
      observationEventId(PR, { field: 'status', from: 'open', to: 'closed' }),
    ])
    expect(ids.size).toBe(5)
  })

  it('distinguishes a FLIP BACK from the original change', () => {
    // Why `from` is in the seed. Checks go pending → passing → pending on every
    // push. With only the new value in the seed the second arrival at `pending`
    // would collide with the first and be swallowed, leaving the mirror stale
    // forever - silently. The identity of a CHANGE includes where it came from.
    const first = observationEventId(PR, { field: 'checks', from: 'pending', to: 'passing' })
    const back = observationEventId(PR, { field: 'checks', from: 'passing', to: 'pending' })
    const again = observationEventId(PR, { field: 'checks', from: 'pending', to: 'passing' })
    expect(first).not.toBe(back)
    expect(again).toBe(first)
  })
})

describe('external-wait conditions', () => {
  it('reads the condition off the obligation key', () => {
    expect(conditionOf('merge-wait')).toBe('merged')
    expect(conditionOf('merge-wait:checks-green')).toBe('checks-green')
    expect(conditionOf('wait:resolved')).toBe('resolved')
  })

  it('is satisfied only by the matching facts', () => {
    const merged: ObservedPr = { ...PR, state: 'merged', merged: true }
    expect(waitSatisfied('merged', merged)).toBe(true)
    expect(waitSatisfied('merged', PR)).toBe(false)
    // Closed-without-merging settles `resolved` but NOT `merged`.
    expect(waitSatisfied('resolved', { ...PR, state: 'closed' })).toBe(true)
    expect(waitSatisfied('merged', { ...PR, state: 'closed' })).toBe(false)
    expect(waitSatisfied('checks-green', { ...PR, checks: 'passing' })).toBe(true)
  })

  it('never satisfies a condition it does not understand', () => {
    // The safe direction: an obligation naming a condition this build cannot
    // evaluate stays OPEN and stays visible rather than being auto-cleared.
    expect(waitSatisfied('sky-turns-green', { ...PR, merged: true, state: 'merged' })).toBe(false)
  })
})

describe('reading facts back off a mirror payload', () => {
  it('round-trips through the stored payload', () => {
    const mirror = { externalId: prExternalId(PR), payload: observedPayload(PR) }
    expect(observedFromPayload(mirror)).toEqual(PR)
  })

  it('says undefined for a mirror that has never been observed', () => {
    // "Not merged" and "we have not looked" are different answers to "may I stop
    // waiting?", so an unobserved mirror must not read as a set of false facts.
    expect(observedFromPayload({ externalId: prExternalId(PR), payload: { sourceUrl: 'x' } })).toBeUndefined()
    expect(observedFromPayload({ externalId: null, payload: observedPayload(PR) })).toBeUndefined()
  })
})

describe('cross-references are bounded and never invent a repo', () => {
  it('reads full URLs and same-repo shorthand, and skips itself', () => {
    const found = referencedPrs(
      PR,
      `supersedes #1290 and https://github.com/other/repo/pull/7 — see also #1291 (this one)`,
    )
    expect(found).toEqual([
      { repo: 'other/repo', number: 7 },
      { repo: PR.repo, number: 1290 },
    ])
  })

  it('is capped', () => {
    const body = Array.from({ length: 40 }, (_, i) => `#${i + 1}`).join(' ')
    expect(referencedPrs(PR, body, 5)).toHaveLength(5)
  })

  it('finds nothing in prose with no references', () => {
    expect(referencedPrs(PR, 'a plain description with issue-1234 and v1.2.3 in it')).toEqual([])
    expect(referencedPrs(PR, null)).toEqual([])
  })
})
