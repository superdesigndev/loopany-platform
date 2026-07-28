// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The page uses TanStack's <Link>, which needs a router context. Stub it to a plain <a>
// (encoding `search` into the href so the deep-link CTA can be asserted).
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, params, ...p }: { children?: unknown; to?: string; search?: { template?: string }; params?: { slug?: string }; [k: string]: unknown }) => {
    let href = typeof to === 'string' ? to : undefined
    if (href && params?.slug) href = href.replace('$slug', params.slug)
    if (href && search?.template) href = `${href}?template=${search.template}`
    return createElement('a', { href, ...p }, children as never)
  },
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
        schedule: 'Daily · ~6am',
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
        schedule: 'Patrol cadence (you set it)',
        exitCondition: 'Finishes on one clean capture.',
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

describe('TemplatesPage (text-first market)', () => {
  it('renders text-first cards: title, intro, chips, category filter, no thumb art', async () => {
    const el = await mount()
    const out = el.innerHTML
    // Both categories + both templates show (grid + filter chips).
    expect(out).toContain('Code Health')
    expect(out).toContain('Others')
    expect(out).toContain('React Doctor')
    expect(out).toContain('Bug Vigil')
    // Rating chips (all three dimensions) scan on the card.
    expect(out).toContain('Easy start')
    expect(out).toContain('Short cycle')
    expect(out).toContain('Open loop')
    expect(out).toContain('Closed loop')
    expect(out).toContain('Visible first run')
    expect(out).toContain('Compounds over weeks')
    // Honest note rides the visibility chip's hover title.
    expect(out).toContain('The first scan fixes the worst issue.')
    // Text-first: no template illustration (thumb svg) is inlined on the market.
    expect(el.querySelectorAll('article svg').length).toBe(0)
  })

  it('each card has a "Create in Loopany" deep link (?template=<name>) + a Details link', async () => {
    const el = await mount()
    const create = [...el.querySelectorAll('a')].filter((a) => (a.textContent ?? '').includes('Create in Loopany'))
    expect(create.length).toBe(2)
    expect(create.map((a) => a.getAttribute('href')).sort()).toEqual(['/?template=bug-vigil', '/?template=react-doctor'])
    // Title + "Details" both link to the shareable detail route.
    const details = [...el.querySelectorAll('a')].filter((a) => a.getAttribute('href')?.startsWith('/templates/'))
    expect(details.some((a) => a.getAttribute('href') === '/templates/react-doctor')).toBe(true)
    expect(details.some((a) => a.getAttribute('href') === '/templates/bug-vigil')).toBe(true)
  })
})
