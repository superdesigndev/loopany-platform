/**
 * The file-based bundle registry (server/bundles.ts). Built from a Vite glob over
 * skill/bundles/*​/meta.json, it groups templates into the dashboard carousel's
 * categories. This asserts the registry is populated, every bundle satisfies the resolved
 * BundleView shape (label/tagline + a valid accent + at least one member that resolves
 * to a real template), the curated order holds, and — the classification invariant —
 * every template belongs to EXACTLY ONE bundle (no orphan, no duplicate). Adding a
 * bundle is pure content (a new folder); these shape tests then cover it automatically.
 */
import { describe, expect, test } from 'vitest'

import { BUNDLES, findPublicTemplate, listBundles, publicBundles } from './bundles'
import { TEMPLATES } from './templates'

const VALID_ACCENTS = ['interactive', 'indigo', 'rubik-green', 'rubik-orange', 'rubik-yellow', 'secondary']
// Categories must never read as an error state — no red accent (round 9).
const ALARM_ACCENTS = ['rubik-red', 'accent']

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
      // No category may read as an error state (round 9): never a red/error accent.
      expect(ALARM_ACCENTS).not.toContain(b.accent)
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

  test('listBundles returns the curated 6-category order (broad-appeal first)', () => {
    expect(listBundles().map((b) => b.name)).toEqual([
      'growth',
      'business-ops',
      'code-health',
      'ship-with-confidence',
      'personal',
      'others',
    ])
  })

  test('each shipped bundle carries its label, accent, and member order', () => {
    const byName = new Map(BUNDLES.map((b) => [b.name, b]))
    const members = (name: string) => byName.get(name)!.members.map((m) => m.name)

    expect(byName.get('code-health')!.label).toBe('Codebase Autopilot')
    expect(byName.get('code-health')!.accent).toBe('interactive')
    expect(members('code-health')).toEqual(['docs-sweep', 'error-sweep', 'react-doctor', 'housekeeper', 'dependency-triage'])

    expect(byName.get('ship-with-confidence')!.label).toBe('CI, Test & Security')
    expect(byName.get('ship-with-confidence')!.accent).toBe('indigo')
    expect(members('ship-with-confidence')).toEqual(['test-guardian', 'security-sweep', 'ci-doctor'])

    expect(byName.get('growth')!.label).toBe('Growth')
    expect(byName.get('growth')!.accent).toBe('rubik-green')
    expect(members('growth')).toEqual(['reddit-karma', 'seo-try-keywords', 'seo-scale-keywords', 'market-research', 'changelog-broadcaster'])

    expect(byName.get('business-ops')!.label).toBe('Business Ops')
    expect(byName.get('business-ops')!.accent).toBe('rubik-orange')
    expect(members('business-ops')).toEqual(['support-triage', 'metrics-digest', 'funnel-watch'])

    expect(byName.get('personal')!.label).toBe('Personal')
    expect(byName.get('personal')!.accent).toBe('rubik-yellow')
    expect(members('personal')).toEqual(['morning-briefing', 'homebrew-updater', 'daily-lesson'])
  })

  test('the "Others" category holds the individually-set-up loops (no bundle CTA)', () => {
    const others = BUNDLES.find((b) => b.name === 'others')!
    expect(others).toBeTruthy()
    expect(others.label).toBe('Goal Loops')
    // The closed, goal-bound loops are set up individually, so they live in Others.
    expect(others.members.map((m) => m.name)).toEqual(['follow-up-tracker', 'ab-experiment-watch', 'bug-vigil', 'release-shepherd'])
    // `individual` marks a no-CTA category; the tryable bundles never set it.
    expect(others.individual).toBe(true)
    for (const b of BUNDLES.filter((x) => x.name !== 'others')) {
      expect(b.individual).toBe(false)
    }
  })

  test('publicBundles drops every thumb but keeps the whole catalog + prompts', () => {
    const full = listBundles()
    const pub = publicBundles()
    // Same categories, same members, same order — only the payload is lighter.
    expect(pub.map((b) => b.name)).toEqual(full.map((b) => b.name))
    expect(pub.flatMap((b) => b.members.map((m) => m.name))).toEqual(
      full.flatMap((b) => b.members.map((m) => m.name)),
    )
    // The dashboard registry really does carry thumbs (else this guard is vacuous).
    expect(full.some((b) => b.members.some((m) => m.thumb))).toBe(true)
    for (const b of pub) {
      for (const m of b.members) {
        expect(m).not.toHaveProperty('thumb')
        // The market card preview + the detail view's verbatim prompt need these.
        expect(m.description.length).toBeGreaterThan(0)
        expect(m.desc.length).toBeGreaterThan(0)
      }
    }
    // Non-destructive: the shared registry keeps its thumbs for the dashboard.
    expect(listBundles().some((b) => b.members.some((m) => m.thumb))).toBe(true)
  })

  test('findPublicTemplate resolves ONE slug with its category, thumb-stripped', () => {
    const first = BUNDLES[0]!
    const member = first.members[0]!
    const hit = findPublicTemplate(member.name)!
    expect(hit).toBeTruthy()
    expect(hit.template.name).toBe(member.name)
    expect(hit.categoryLabel).toBe(first.label)
    expect(hit.accent).toBe(first.accent)
    // No thumb, but the full prompt the detail view renders verbatim survives.
    expect(hit.template).not.toHaveProperty('thumb')
    expect(hit.template.description).toBe(member.description)
    // Every catalog member resolves (the route's 404 is for real unknowns only).
    for (const b of BUNDLES) {
      for (const m of b.members) {
        expect(findPublicTemplate(m.name)?.categoryLabel, m.name).toBe(b.label)
      }
    }
    expect(findPublicTemplate('no-such-template')).toBeNull()
    expect(findPublicTemplate('')).toBeNull()
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
