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

/** Seven bundles' worth of templates: more than the band shows, so the curation
 *  (one lead per category, capped at 6) and the "Browse all N" count both bite. */
const bundles: BundleView[] = [
  bundle('code-health', 'Code Health', 'interactive', [['react-doctor', 'React Doctor'], ['housekeeper', 'Housekeeper']]),
  bundle('ship', 'Ship with Confidence', 'indigo', [['release-notes', 'Release Notes']]),
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

describe('TemplatesPreview (dashboard catalog teaser)', () => {
  it('shows a curated one-per-category subset, capped at two desktop rows', async () => {
    const el = await mount()
    const cards = [...el.querySelectorAll('article.market-card')]
    expect(cards.length).toBe(6)
    // The LEAD of each bundle, in the registry's curated category order — not a slice
    // of one category (Housekeeper is Code Health's second member, so it is left out).
    const titles = [...el.querySelectorAll('a.market-card-link')].map((a) => a.textContent)
    expect(titles).toEqual(['React Doctor', 'Release Notes', 'Market Monitor', 'Inbox Triage', 'Reading List', 'Bug Vigil'])
    expect(el.innerHTML).not.toContain('Housekeeper')
  })

  it('reuses the market card language: category tag, intro, prompt preview, rating row', async () => {
    const el = await mount()
    const out = el.innerHTML
    expect(out).toContain('Code Health')
    expect(out).toContain('React Doctor blurb')
    // The monospace prompt-preview texture, one per card, masked at its bottom.
    const pres = [...el.querySelectorAll('article pre')]
    expect(pres.length).toBe(6)
    expect(pres[0]!.textContent).toContain('React Doctor full setup prompt')
    expect(el.querySelectorAll('article .prompt-preview-mask').length).toBe(6)
    // The compact 3-indicator rating row (same as the market grid).
    expect(out).toContain('Easy start')
    expect(out).toContain('Short cycle')
    expect(out).toContain('Visible fast')
  })

  it('keeps whole-card navigation to the detail route, and the Create deep-link', async () => {
    const el = await mount()
    const links = [...el.querySelectorAll('a.market-card-link')].map((a) => a.getAttribute('href'))
    expect(links[0]).toBe('/templates/react-doctor')
    expect(links.every((h) => h?.startsWith('/templates/'))).toBe(true)
    expect([...el.querySelectorAll('a.market-create')].map((a) => a.getAttribute('href'))[0]).toBe('/?template=react-doctor')
  })

  it('fades out into ONE Browse-all affordance counting the WHOLE catalog', async () => {
    const el = await mount()
    // The clip+fade container carries the mask (see `.templates-peek` in app.css).
    expect(el.querySelectorAll('.templates-peek').length).toBe(1)
    const browse = [...el.querySelectorAll('a')].filter((a) => (a.textContent ?? '').includes('Browse all'))
    expect(browse.length).toBe(1)
    // 7 templates across the 6 bundles — the count is the catalog, not the 6 shown.
    expect(browse[0]!.textContent).toContain('Browse all 7 templates')
    expect(browse[0]!.getAttribute('href')).toBe('/templates')
  })

  it('renders nothing when the registry is empty (never an orphan heading)', async () => {
    const el = await mount([])
    expect(el.innerHTML).toBe('')
  })
})

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('placement + shared-card wiring', () => {
  it('sits directly above the playbook on the dashboard', () => {
    const view = src('./DashboardView.tsx')
    expect(view).toContain('<TemplatesPreview bundles={bundles} />')
    // Order matters: the teaser precedes the playbook band.
    expect(view.indexOf('<TemplatesPreview')).toBeLessThan(view.indexOf('<LoopPlaybook'))
    // Off the loader's static bundles — the poll must not re-ship the registry.
    expect(view).not.toMatch(/listBundles|listPublicBundles/)
  })

  it('the market and the teaser render the SAME extracted card', () => {
    // One card component, two surfaces — a change to the market card language shows in
    // both by construction (no duplicated markup to drift).
    for (const rel of ['./TemplatesPage.tsx', './TemplatesPreview.tsx']) {
      expect(src(rel)).toContain("from './TemplateCard'")
      expect(src(rel)).toContain('<TemplateCard')
    }
    expect(src('./TemplatesPage.tsx')).not.toContain('function MarketCard')
  })

  it('the clip + fade is deterministic: fixed-height compact cards under a masked box', () => {
    // The mask cuts at a fixed pixel height, so the compact card must be fixed-height
    // too or the peek row lands somewhere different at every width.
    expect(src('./TemplateCard.tsx')).toMatch(/compact \? 'h-\[\d+px\] overflow-hidden'/)
    const css = src('../styles/app.css')
    expect(css).toContain('.templates-peek')
    expect(css).toMatch(/\.templates-peek \{[\s\S]*?max-height:[\s\S]*?mask-image: linear-gradient\(to bottom/)
  })
})
