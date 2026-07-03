/**
 * The file-based template registry (server/templates.ts). It's built from a Vite glob
 * over skill/templates/*​/meta.json, so this asserts the registry is populated, every
 * entry satisfies the slimmed TemplateInfo shape (name/label/desc + a non-empty canned
 * `description` that rides the bootstrap snippet), and the React Doctor entry is present
 * and expresses its guardrails. Adding a template in a later batch is pure content (a
 * new folder); this test then covers it automatically.
 */
import { describe, expect, test } from 'vitest'

import { TEMPLATES } from './templates'
import type { TemplateInfo } from '../types'

describe('template registry', () => {
  test('is non-empty and every entry has the TemplateInfo shape', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0)
    for (const t of TEMPLATES) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.label).toBe('string')
      expect(t.label.length).toBeGreaterThan(0)
      // The card blurb and the canned task description are both required + non-empty:
      // the description is the INTENT appended to the bootstrap snippet, so an empty
      // one would ship a template that pastes nothing to build.
      expect(typeof t.desc).toBe('string')
      expect(t.desc.trim().length).toBeGreaterThan(0)
      expect(typeof t.description).toBe('string')
      expect(t.description.trim().length).toBeGreaterThan(0)
    }
  })

  test('names are unique', () => {
    const names = TEMPLATES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('ships the React Doctor template (v1) with its guardrails in the description', () => {
    const rd = TEMPLATES.find((t) => t.name === 'react-doctor') as TemplateInfo
    expect(rd).toBeTruthy()
    expect(rd.label).toBe('React Doctor')
    const d = rd.description
    // The canned intent must express the non-obvious rules (the create flow handles
    // cadence/config on its own, but these are the loop's defining behaviors).
    expect(d).toContain('npx react-doctor@latest')
    expect(d).toContain('worktree') // fresh worktree off main — never dirty the checkout
    expect(d.toLowerCase()).toContain('unmerged') // no-stacking rule
    expect(d.toLowerCase()).toContain('kanban') // open/merged board
    expect(d.toLowerCase()).toContain('score') // daily health score
  })
})
