/**
 * The editorial template ratings (server/templateRatings.ts) surfaced on the public
 * template list. Asserts every shipped template has a rating with valid enum values, and
 * the load-bearing consistency invariant: `mechanism` REUSES the catalog's open/closed
 * distinction — the "Others" category (individual) templates are `closed`, everything
 * else is `open`. Adding a template without a rating (or misclassifying its mechanism)
 * fails here.
 */
import { describe, expect, test } from 'vitest'

import { TEMPLATES } from './templates'
import { TEMPLATE_RATINGS } from './templateRatings'
import { BUNDLES } from './bundles'

const EASE = ['easy', 'moderate', 'advanced']
const CADENCE = ['short', 'long']
const MECHANISM = ['open', 'closed']
const VISIBILITY = ['first-run', 'few-runs', 'compounds']

describe('template ratings', () => {
  test('every shipped template has a rating with valid enum values + a note', () => {
    for (const t of TEMPLATES) {
      const r = t.rating
      expect(r, `${t.name} has no rating`).toBeTruthy()
      if (!r) continue
      expect(EASE).toContain(r.ease)
      expect(CADENCE).toContain(r.cadence)
      expect(MECHANISM).toContain(r.mechanism)
      expect(VISIBILITY).toContain(r.visibility)
      expect(typeof r.visibilityNote).toBe('string')
      expect(r.visibilityNote.trim().length).toBeGreaterThan(0)
      // A humanized schedule (for the detail view's mechanism rows) is always present.
      expect(typeof r.schedule).toBe('string')
      expect(r.schedule.trim().length).toBeGreaterThan(0)
    }
  })

  test('exitCondition is present for CLOSED loops and absent for OPEN ones', () => {
    for (const t of TEMPLATES) {
      const r = t.rating
      if (!r) continue
      if (r.mechanism === 'closed') {
        expect(r.exitCondition, `${t.name} (closed) needs an exit condition`).toBeTruthy()
        expect((r.exitCondition ?? '').trim().length).toBeGreaterThan(0)
      } else {
        expect(r.exitCondition, `${t.name} (open) should have no exit condition`).toBeUndefined()
      }
    }
  })

  test('the ratings table has no entry for a template that no longer exists', () => {
    const names = new Set(TEMPLATES.map((t) => t.name))
    for (const key of Object.keys(TEMPLATE_RATINGS)) {
      expect(names.has(key), `rating "${key}" matches no template`).toBe(true)
    }
  })

  test('mechanism reuses the catalog open/closed distinction (Others = closed)', () => {
    const closed = new Set(
      BUNDLES.filter((b) => b.individual).flatMap((b) => b.members.map((m) => m.name)),
    )
    // At least one closed template exists (the Others category), so this isn't vacuous.
    expect(closed.size).toBeGreaterThan(0)
    for (const t of TEMPLATES) {
      const expected = closed.has(t.name) ? 'closed' : 'open'
      expect(t.rating?.mechanism, `${t.name} mechanism should be ${expected}`).toBe(expected)
    }
  })

  test('ratings are honest — not every template is easy / visible-first-run', () => {
    const eases = TEMPLATES.map((t) => t.rating?.ease)
    expect(eases).toContain('easy')
    expect(eases).toContain('moderate')
    expect(eases).toContain('advanced')
    const vis = TEMPLATES.map((t) => t.rating?.visibility)
    expect(vis).toContain('first-run')
    expect(vis).toContain('compounds')
    const cad = TEMPLATES.map((t) => t.rating?.cadence)
    expect(cad).toContain('short')
    expect(cad).toContain('long')
  })
})
