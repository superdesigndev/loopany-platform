/**
 * The file-based bundle registry (server/bundles.ts). Built from a Vite glob over
 * skill/bundles/*​/meta.json, it groups templates into the dashboard's stage-select
 * dial. This asserts the registry is populated, every bundle satisfies the resolved
 * BundleView shape (label/tagline + a valid accent + at least one member that resolves
 * to a real template), the curated order holds, and — the classification invariant —
 * every template belongs to EXACTLY ONE bundle (no orphan, no duplicate). Adding a
 * bundle is pure content (a new folder); these shape tests then cover it automatically.
 */
import { describe, expect, test } from 'vitest'

import { BUNDLES, listBundles } from './bundles'
import { TEMPLATES } from './templates'

const VALID_ACCENTS = ['interactive', 'rubik-green', 'rubik-orange', 'secondary']

describe('bundle registry', () => {
  test('is non-empty and every bundle has the BundleView shape', () => {
    expect(BUNDLES.length).toBeGreaterThan(0)
    for (const b of BUNDLES) {
      expect(typeof b.name).toBe('string')
      expect(b.name.length).toBeGreaterThan(0)
      expect(typeof b.label).toBe('string')
      expect(b.label.trim().length).toBeGreaterThan(0)
      expect(typeof b.tagline).toBe('string')
      expect(b.tagline.trim().length).toBeGreaterThan(0)
      expect(VALID_ACCENTS).toContain(b.accent)
      // At least one member, and every member is a REAL resolved template (unknown
      // names are dropped by the registry, so this also proves resolution worked).
      expect(b.members.length).toBeGreaterThan(0)
      for (const m of b.members) {
        expect(TEMPLATES.some((t) => t.name === m.name)).toBe(true)
      }
    }
  })

  test('names are unique', () => {
    const names = BUNDLES.map((b) => b.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('listBundles returns the curated order (Engineering, Growth, Operations, Others)', () => {
    expect(listBundles().map((b) => b.name)).toEqual(['engineering', 'growth', 'operations', 'others'])
  })

  test('the shipped bundles carry their label, accent, and members', () => {
    const byName = new Map(BUNDLES.map((b) => [b.name, b]))
    const eng = byName.get('engineering')!
    expect(eng.label).toBe('Engineering')
    expect(eng.accent).toBe('interactive')
    expect(eng.members.map((m) => m.name)).toEqual(['react-doctor', 'housekeeper', 'docs-sweep', 'dependency-triage', 'error-sweep'])

    const growth = byName.get('growth')!
    expect(growth.label).toBe('Growth')
    expect(growth.accent).toBe('rubik-green')
    expect(growth.members.map((m) => m.name)).toEqual(['market-research', 'reddit-karma'])

    const ops = byName.get('operations')!
    expect(ops.label).toBe('Operations')
    expect(ops.accent).toBe('rubik-orange')
    expect(ops.members.map((m) => m.name)).toEqual(['support-triage'])
  })

  test('the "Others" category holds the individually-set-up loops (no bundle CTA)', () => {
    const others = BUNDLES.find((b) => b.name === 'others')!
    expect(others).toBeTruthy()
    expect(others.label).toBe('Others')
    // Follow-up Tracker is set up individually, so it lives in Others, not Operations.
    expect(others.members.map((m) => m.name)).toContain('follow-up-tracker')
    // `individual` marks a no-CTA category; the tryable bundles never set it.
    expect(others.individual).toBe(true)
    for (const b of BUNDLES.filter((x) => x.name !== 'others')) {
      expect(b.individual).toBe(false)
    }
  })

  test('every template belongs to EXACTLY ONE bundle — no orphan, no duplicate', () => {
    const seen = new Map<string, number>()
    for (const b of BUNDLES) {
      for (const m of b.members) {
        seen.set(m.name, (seen.get(m.name) ?? 0) + 1)
      }
    }
    // No template is claimed by two bundles.
    for (const [name, count] of seen) {
      expect(count, `${name} appears in ${count} bundles`).toBe(1)
    }
    // Every template is claimed by some bundle (no orphan).
    for (const t of TEMPLATES) {
      expect(seen.has(t.name), `${t.name} belongs to no bundle`).toBe(true)
    }
    // And the members exactly partition the template set.
    expect(seen.size).toBe(TEMPLATES.length)
  })
})
