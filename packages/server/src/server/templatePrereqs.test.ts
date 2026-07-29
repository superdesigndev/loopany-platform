import { describe, expect, test } from 'vitest'
import { TEMPLATE_PREREQS } from './templatePrereqs'
import { TEMPLATES } from './templates'

/** Prereq table shape: every key resolves to a shipped template, labels are non-empty,
 *  and links are absolute https. A typo'd key would silently ship an invisible list. */
describe('TEMPLATE_PREREQS', () => {
  const names = new Set(TEMPLATES.map((t) => t.name))

  test('every key is a shipped template', () => {
    for (const key of Object.keys(TEMPLATE_PREREQS)) {
      expect(names.has(key), key).toBe(true)
    }
  })

  test('entries are well-formed', () => {
    for (const [key, items] of Object.entries(TEMPLATE_PREREQS)) {
      expect(items.length, key).toBeGreaterThan(0)
      for (const p of items) {
        expect(p.label.trim().length, key).toBeGreaterThan(0)
        if (p.href) expect(p.href.startsWith('https://'), `${key}: ${p.href}`).toBe(true)
      }
    }
  })

  test('every Codebase Autopilot member ships the verifier prereq', () => {
    for (const name of ['docs-sweep', 'error-sweep', 'react-doctor', 'housekeeper', 'dependency-triage']) {
      const items = TEMPLATE_PREREQS[name]
      expect(items, name).toBeTruthy()
      expect(items!.some((p) => p.label.toLowerCase().includes('verifier')), name).toBe(true)
    }
  })
})
