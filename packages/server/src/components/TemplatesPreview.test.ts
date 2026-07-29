// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The band uses TanStack's <Link>; stub it to a plain <a> (encoding `search`/`params`
// into the href) so the card + Browse-all navigation can be asserted without a router.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, params, ...p }: { children?: unknown; to?: string; search?: { template?: string }; params?: { slug?: string }; [k: string]: unknown }) => {
    let href = typeof to === 'string' ? to : undefined
    if (href && params?.slug) href = href.replace('$slug', params.slug)
    if (href && search?.template) href = `${href}?template=${search.template}`
    return createElement('a', { href, ...p }, children as never)
  },
}))

import { TemplatesPreview } from './TemplatesPreview'
import type { BundleView, TemplateInfo } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rating: TemplateInfo['rating'] = {
  ease: 'easy',
  cadence: 'short',
  mechanism: 'open',
  visibility: 'first-run',
  visibilityNote: 'The first run fixes the worst issue.',
  schedule: 'Daily · ~6am',
  does: 'Scans the app → fixes the worst issue',
  outcome: '🔀 One verified fix PR daily',
}

const tmpl = (name: string, label: string): TemplateInfo => ({
  name,
  label,
  desc: `${label} blurb`,
  description: `${label} full setup prompt`,
  rating,
})

const bundle = (name: string, label: string, accent: BundleView['accent'], members: [string, string][]): BundleView => ({
  name,
  label,
  tagline: `${label} tagline`,
  accent,
  members: members.map(([n, l]) => tmpl(n, l)),
})

/** More templates than the band shows (10 across 6 bundles), so both the round-robin
 *  curation + its 9-card cap and the "Browse all N" catalog count bite. Code Health is
 *  deliberately deep (4) so a flat top-up would be visible as a Code Health cluster. */
const bundles: BundleView[] = [
  bundle('code-health', 'Code Health', 'interactive', [
    ['react-doctor', 'React Doctor'],
    ['housekeeper', 'Housekeeper'],
    ['docs-sweep', 'Doc Maintainer'],
    ['dep-triage', 'Dependency Triage'],
  ]),
  bundle('ship', 'Ship with Confidence', 'indigo', [['release-notes', 'Release Notes'], ['test-guardian', 'Test Guardian']]),
  bundle('growth', 'Growth', 'rubik-green', [['market-monitor', 'Market Monitor']]),
  bundle('ops', 'Business Ops', 'rubik-orange', [['inbox-triage', 'Inbox Triage']]),
  bundle('personal', 'Personal', 'rubik-yellow', [['reading-list', 'Reading List']]),
  bundle('others', 'Others', 'secondary', [['bug-vigil', 'Bug Vigil']]),
]

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(data: BundleView[] = bundles): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(TemplatesPreview, { bundles: data }))
  })
  return host
}

describe('TemplatesPreview (the loop-marketplace band)', () => {
  it('renders the FULL catalog as per-bundle sections, in registry order', async () => {
    const el = await mount()
    const out = el.textContent ?? ''
    expect(out).toContain('Loop marketplace')
    expect(out).toContain('Start from a loop that already works')
    // One section per bundle, curated order, label + tagline + count.
    const heads = [...el.querySelectorAll('h3.band-section-head')].map((h) => h.textContent?.trim())
    expect(heads).toEqual(bundles.map((b) => b.label))
    for (const b of bundles) expect(out).toContain(`${b.label} tagline`)
    // EVERY member renders — no clip, no cap, no fade.
    const cards = el.querySelectorAll('article.market-card')
    expect(cards.length).toBe(bundles.reduce((n, b) => n + b.members.length, 0))
  })

  it('every card goes STRAIGHT to compose — no detail hop, no Browse-all, no Create pill', async () => {
    const el = await mount()
    const links = [...el.querySelectorAll('a.market-card-link')].map((a) => a.getAttribute('href'))
    expect(links.length).toBeGreaterThan(0)
    expect(links.every((h) => h?.startsWith('/?template='))).toBe(true)
    expect(el.querySelectorAll('a.market-create').length).toBe(0)
    expect([...el.querySelectorAll('a')].some((a) => (a.textContent ?? '').includes('Browse all'))).toBe(false)
  })

  it('cards keep the flow strip + rating row (same shared card as the market)', async () => {
    const el = await mount()
    const strips = el.querySelectorAll('article .flow-strip')
    expect(strips.length).toBe(el.querySelectorAll('article.market-card').length)
    expect(el.textContent).toContain('Easy start')
  })

  it('renders nothing when the registry is empty (never an orphan heading)', async () => {
    const el = await mount([])
    expect(el.innerHTML).toBe('')
  })
})
