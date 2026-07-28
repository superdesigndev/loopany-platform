/**
 * The bundle Copy-prompt builder (lib/bundlePrompt.ts). Pure + self-contained: it must
 * carry the exact preamble, the numbered candidate menu, and EACH member's full setup
 * `description` inline (so no serving endpoint is needed). Guards the snippet contents.
 */
import { describe, expect, test } from 'vitest'

import { buildBundlePrompt } from './bundlePrompt'
import type { BundleView } from '../types'

const bundle: BundleView = {
  name: 'engineering',
  label: 'Engineering',
  tagline: 'Keep your codebase healthy while you sleep.',
  accent: 'interactive',
  members: [
    { name: 'react-doctor', label: 'React Doctor', desc: 'Fix the worst React issue daily.', description: 'FULL REACT SETUP with worktree rules.' },
    { name: 'housekeeper', label: 'Tech Debt Cleanup', desc: 'One proven cleanup per day.', description: 'FULL HOUSEKEEPER SETUP with deferred candidates.' },
  ],
}

describe('buildBundlePrompt', () => {
  const snippet = buildBundlePrompt({
    instruction: 'Fetch https://loopany.ai/api/bootstrap and help me build a loop.',
    configLines: 'server-url: https://loopany.ai\nconnect-key: ck_abc',
    bundle,
  })

  test('leads with the caller-supplied bootstrap instruction + the exact bundle preamble', () => {
    // The instruction is passed IN (one source with the single-template snippet), so the
    // builder never hardcodes its own bootstrap wording.
    expect(snippet.startsWith('Fetch https://loopany.ai/api/bootstrap and help me build a loop.')).toBe(true)
    expect(snippet).toContain('from the "Engineering" bundle')
    expect(snippet).toContain('Below are 2 candidate loops')
    expect(snippet).toContain('never create a blind loop')
  })

  test('embeds the config lines', () => {
    expect(snippet).toContain('server-url: https://loopany.ai')
    expect(snippet).toContain('connect-key: ck_abc')
  })

  test('carries a numbered candidate menu with each member label + blurb', () => {
    expect(snippet).toContain('Candidate loops in "Engineering":')
    expect(snippet).toContain('1. React Doctor - Fix the worst React issue daily.')
    expect(snippet).toContain('2. Tech Debt Cleanup - One proven cleanup per day.')
  })

  test('inlines each member full setup description under a labeled header', () => {
    expect(snippet).toContain('- Full setup for each (follow only the ones I confirm) -')
    for (const m of bundle.members) {
      expect(snippet).toContain(`[${m.label}]`)
      expect(snippet).toContain(m.description)
    }
  })
})
