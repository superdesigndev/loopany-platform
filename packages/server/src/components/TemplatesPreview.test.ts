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

describe('TemplatesPreview (dashboard catalog teaser)', () => {
  it('shows a round-robin curated subset — three desktop rows, two of them full', async () => {
    const el = await mount()
    const cards = [...el.querySelectorAll('article.market-card')]
    // 9 = 3 columns x 3 rows: two full rows plus the one the fade cuts.
    expect(cards.length).toBe(9)
    // Every bundle's LEAD first (curated category order), THEN every bundle's second,
    // and so on — so the extra rows stay a tour of the catalog instead of turning into
    // a Code Health cluster (that bundle is 4 deep here).
    const titles = [...el.querySelectorAll('a.market-card-link')].map((a) => a.textContent)
    expect(titles).toEqual([
      'React Doctor',
      'Release Notes',
      'Market Monitor',
      'Inbox Triage',
      'Reading List',
      'Bug Vigil',
      'Housekeeper',
      'Test Guardian',
      'Doc Maintainer',
    ])
    // The 10th+ template stays behind the "Browse all" link.
    expect(el.innerHTML).not.toContain('Dependency Triage')
  })

  it('reuses the market card language: category tag, intro, flow strip, rating row', async () => {
    const el = await mount()
    const out = el.innerHTML
    expect(out).toContain('Code Health')
    expect(out).toContain('React Doctor blurb')
    // The When → Does → You-get strip, one per card (the old prompt preview is gone —
    // the full prompt lives on the detail page).
    const strips = [...el.querySelectorAll('article .flow-strip')]
    expect(strips.length).toBe(9)
    expect(strips[0]!.textContent).toContain('Daily · ~6am')
    expect(strips[0]!.textContent).toContain('Scans the app → fixes the worst issue')
    expect(strips[0]!.textContent).toContain('One verified fix PR daily')
    expect(el.querySelectorAll('article pre').length).toBe(0)
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
    // 10 templates across the 6 bundles — the count is the CATALOG, not the 9 shown.
    expect(browse[0]!.textContent).toContain('Browse all 10 templates')
    expect(browse[0]!.getAttribute('href')).toBe('/templates')
  })

  it('drops the cards a narrower column count would hide entirely under the clip', async () => {
    const el = await mount()
    // Tokenize — the compact card carries `overflow-hidden`, which is not `hidden`.
    const cls = [...el.querySelectorAll('article.market-card')].map((c) => c.className.split(/\s+/))
    // The mask has room for THREE rows; the grid is 1 column below `sm`, 2 up to `lg`,
    // 3 above. So cards 4-6 only exist from `sm` and 7-9 only from `lg` — anything the
    // clip would hide OUTRIGHT is display:none there, never invisible-but-focusable.
    expect(cls.slice(0, 3).every((c) => !c.includes('hidden'))).toBe(true)
    expect(cls.slice(3, 6).every((c) => c.includes('hidden') && c.includes('sm:flex'))).toBe(true)
    expect(cls.slice(6, 9).every((c) => c.includes('hidden') && c.includes('lg:flex'))).toBe(true)
    // Desktop is untouched: at `lg` all nine are shown.
    expect(cls.filter((c) => c.includes('hidden')).length).toBe(6)
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

  it('TWO full rows stay solid; the third is what the fade cuts', () => {
    // The three numbers that encode "two full rows, third fading" — card height, box
    // height and the mask's opaque stop — must agree, or the cut drifts off a row edge.
    const cardH = Number(/compact \? 'h-\[(\d+)px\] overflow-hidden'/.exec(src('./TemplateCard.tsx'))?.[1])
    const css = /\.templates-peek \{([\s\S]*?)\}/.exec(src('../styles/app.css'))?.[1] ?? ''
    const boxH = Number(/max-height:\s*(\d+)px/.exec(css)?.[1])
    const solidPct = Number(/mask-image: linear-gradient\(to bottom, #000 0, #000 (\d+)%/.exec(css)?.[1])
    const GAP = 16 // the grid's gap-4
    const twoRows = cardH * 2 + GAP
    expect(boxH).toBeGreaterThan(twoRows) // room left for the third row to peek
    expect(boxH).toBeLessThan(twoRows + cardH) // but never a full third row
    // Opaque through the end of row two, within a pixel of rounding.
    expect(Math.abs((solidPct / 100) * boxH - twoRows)).toBeLessThanOrEqual(1)
    // And enough cards to fill all three rows at the 3-column desktop width.
    expect(src('./TemplatesPreview.tsx')).toMatch(/const PREVIEW_COUNT = 9\b/)
  })

  it('the clipped box is not a scroll container, and its breakpoints match the grid', () => {
    const preview = src('./TemplatesPreview.tsx')
    // `overflow-clip`, NOT `overflow-hidden`: a hidden box is still programmatically
    // scrollable, so focus moving into a clipped card would shift the whole band up
    // under the mask with no way back.
    expect(preview).toContain('templates-peek mt-8 overflow-clip')
    expect(preview).not.toContain('templates-peek mt-8 overflow-hidden')
    // The per-card visibility must key off the SAME breakpoints as the column count,
    // and cover every previewed card, or the "three rows at any width" rule breaks.
    expect(preview).toContain('sm:grid-cols-2 lg:grid-cols-3')
    const slots = /const PEEK_VISIBILITY[\s\S]*?= \[([\s\S]*?)\n\]/.exec(preview)?.[1] ?? ''
    expect(slots.split(',').filter((s) => s.trim()).length).toBe(9)
  })

  it('the compact card clamps its title, so the fixed height cannot silently clip the footer', () => {
    // The fixed height leaves no slack for a two-line title; a longer label must
    // ellipsise (truncate on the title link — the h3 is a flex row with the icon)
    // rather than push the rating row + Create link out of the card.
    expect(src('./TemplateCard.tsx')).toContain("${compact ? 'truncate' : ''}")
  })
})
