/**
 * The file-based template registry (server/templates.ts). It's built from a Vite glob
 * over skill/templates/*​/meta.json, so this asserts the registry is populated, the
 * React Doctor entry is well-formed (label/desc/tags/slots), and every entry's shape
 * satisfies TemplateInfo — the contract the dashboard cards and the serving route rely
 * on. Adding a template in a later batch is pure content (a new folder); this test then
 * covers it automatically.
 */
import { describe, expect, test } from 'vitest'

import { TEMPLATES, TEMPLATE_NAMES } from './templates'
import type { TemplateInfo } from '../types'

describe('template registry', () => {
  test('is non-empty and every entry has the TemplateInfo shape', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0)
    for (const t of TEMPLATES) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.label).toBe('string')
      expect(typeof t.desc).toBe('string')
      expect(Array.isArray(t.tags)).toBe(true)
      expect(Array.isArray(t.slots)).toBe(true)
      // Slots carry a name + prompt; the market's slots are all optional (defaulted).
      for (const s of t.slots) {
        expect(typeof s.name).toBe('string')
        expect(typeof s.prompt).toBe('string')
        expect(s.required ?? false).toBe(false)
      }
    }
  })

  test('TEMPLATE_NAMES mirrors the registry (the route allowlist)', () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual(TEMPLATES.map((t) => t.name).sort())
  })

  test('ships the React Doctor template (v1) with a defaulted schedule slot', () => {
    const rd = TEMPLATES.find((t) => t.name === 'react-doctor') as TemplateInfo
    expect(rd).toBeTruthy()
    expect(rd.label).toBe('React Doctor')
    expect(rd.tags.length).toBeGreaterThan(0)
    const runAt = rd.slots.find((s) => s.name === 'run-at')
    expect(runAt).toBeTruthy()
    expect(runAt?.kind).toBe('cron')
    expect(runAt?.default).toBe('05:00')
    expect(runAt?.required ?? false).toBe(false)
  })
})
