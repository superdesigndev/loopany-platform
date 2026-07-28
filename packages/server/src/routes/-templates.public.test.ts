// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The page uses TanStack's <Link>, which needs a router context. Stub it to a plain <a>
// so the page can render in isolation.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...p }: { children?: unknown; to?: string; [k: string]: unknown }) =>
    createElement('a', { href: typeof to === 'string' ? to : undefined, ...p }, children as never),
}))

import { TemplatesPage } from '../components/TemplatesPage'
import type { BundleView, TemplateInfo } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tmpl = (name: string, label: string, rating: TemplateInfo['rating']): TemplateInfo => ({
  name,
  label,
  desc: `${label} blurb`,
  description: `${label} full setup`,
  rating,
})

const bundles: BundleView[] = [
  {
    name: 'code-health',
    label: 'Code Health',
    tagline: 'Keep your codebase healthy while you sleep.',
    accent: 'interactive',
    individual: false,
    members: [
      tmpl('react-doctor', 'React Doctor', {
        ease: 'easy',
        cadence: 'short',
        mechanism: 'open',
        visibility: 'first-run',
        visibilityNote: 'The first scan fixes the worst issue.',
      }),
    ],
  },
  {
    name: 'others',
    label: 'Others',
    tagline: 'One-off loops you set up individually.',
    accent: 'secondary',
    individual: true,
    members: [
      tmpl('bug-vigil', 'Bug Vigil', {
        ease: 'moderate',
        cadence: 'short',
        mechanism: 'closed',
        visibility: 'compounds',
        visibilityNote: 'Waits out an intermittent bug.',
      }),
    ],
  },
]

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(TemplatesPage, { bundles }))
  })
  return host
}

describe('TemplatesPage', () => {
  it('renders every category + template with its rating chips and a CTA', async () => {
    const el = await mount()
    const out = el.innerHTML
    // Both categories + both templates show.
    expect(out).toContain('Code Health')
    expect(out).toContain('Others')
    expect(out).toContain('React Doctor')
    expect(out).toContain('Bug Vigil')
    // Rating chips scan on the card: ease, cadence, mechanism, visibility.
    expect(out).toContain('Easy start')
    expect(out).toContain('Short cycle')
    expect(out).toContain('Open loop')
    expect(out).toContain('Closed loop') // the closed (Others) template
    expect(out).toContain('Visible first run')
    expect(out).toContain('Compounds over weeks')
    // Honest note is present (visible + as a hover title).
    expect(out).toContain('The first scan fixes the worst issue.')
    // Every template has a "Use this template" CTA pointing at the app entry.
    const ctas = [...el.querySelectorAll('a')].filter((a) => (a.textContent ?? '').includes('Use this template'))
    expect(ctas.length).toBe(2)
    for (const a of ctas) expect(a.getAttribute('href')).toBe('/')
  })
})
