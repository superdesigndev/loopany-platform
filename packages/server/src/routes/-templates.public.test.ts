// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

describe('TemplatesPage (text-first market — round 8 card)', () => {
  it('renders text-first cards: title, intro, prompt preview anchor, 3 micro-indicators', async () => {
    const el = await mount()
    const out = el.innerHTML
    expect(out).toContain('Code Health')
    expect(out).toContain('Others')
    expect(out).toContain('React Doctor')
    expect(out).toContain('Bug Vigil')
    // The visual anchor: a monospace <pre> preview of the REAL prompt per card.
    const pres = [...el.querySelectorAll('article pre')]
    expect(pres.length).toBe(2)
    expect(pres.some((p) => (p.textContent ?? '').includes('React Doctor full setup'))).toBe(true)
    // Compact 3-indicator row (ease · cadence · effect) — NOT the wrapping full chips.
    expect(out).toContain('Easy start')
    expect(out).toContain('Short cycle')
    expect(out).toContain('Visible fast')
    expect(out).toContain('Moderate')
    expect(out).toContain('Compounds')
    // The open/closed mechanism + the full visibility labels move to the detail view.
    expect(out).not.toContain('Open loop')
    expect(out).not.toContain('Closed loop')
    expect(out).not.toContain('Visible first run')
    // Text-first: still no template illustration on the market.
    expect(el.querySelectorAll('article svg').length).toBe(0)
  })

  it('the whole card links to detail; Create is a quiet deep-link; no Details button', async () => {
    const el = await mount()
    // The stretched title link makes the whole card navigate to the shareable detail.
    const titleLinks = [...el.querySelectorAll('article a.market-card-link')]
    expect(titleLinks.map((a) => a.getAttribute('href')).sort()).toEqual(['/templates/bug-vigil', '/templates/react-doctor'])
    // The demoted "Create" affordance deep-links into the compose flow.
    const create = [...el.querySelectorAll('a.market-create')]
    expect(create.length).toBe(2)
    expect(create.map((a) => a.getAttribute('href')).sort()).toEqual(['/?template=bug-vigil', '/?template=react-doctor'])
    // The old full-width black "Create in Loopany" bar + the "Details" button are gone.
    expect(el.innerHTML).not.toContain('Create in Loopany')
    expect([...el.querySelectorAll('a')].some((a) => (a.textContent ?? '').trim() === 'Details')).toBe(false)
  })
})

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('the public market routes SSR (crawlers/unfurlers see the real page)', () => {
  it('neither market route opts out of SSR — their loaders are the static, auth-free registry', () => {
    // Every OTHER route is `ssr: false` because its loader needs the browser session
    // cookie; these two only read the static registry, so the server HTML carries the
    // real grid/prose next to the SEO meta.
    const optOut = /^\s*ssr:\s*false/m
    expect(src('./templates.tsx')).not.toMatch(optOut)
    expect(src('./templates_.$slug.tsx')).not.toMatch(optOut)
    // The gated app routes keep theirs.
    expect(src('./index.tsx')).toMatch(optOut)
  })

  it('the detail head titles from the RESOLVED template label, with the slug as fallback', () => {
    const detail = src('./templates_.$slug.tsx')
    expect(detail).toContain('head: ({ params, loaderData })')
    expect(detail).toContain('?.data?.template')
    expect(detail).toContain('${t.label} — Loopany template')
    expect(detail).toContain('${params.slug} — Loopany template')
    // And it ships a description meta, like the grid route.
    expect(detail).toContain("name: 'description'")
  })

  it('an unknown slug is a REAL 404, still rendering the friendly not-found page', () => {
    const detail = src('./templates_.$slug.tsx')
    // notFound() makes the router mark the match not-found (statusCode 404) instead of
    // serving a crawlable soft-404 at HTTP 200.
    expect(detail).toContain('throw notFound()')
    expect(detail).toContain("import { createFileRoute, notFound } from '@tanstack/react-router'")
    // The friendly page (Template not found + Browse all templates) still renders.
    expect(detail).toContain('notFoundComponent: () => <TemplateDetail data={null} />')
  })

  it('both public routes take a THUMB-STRIPPED payload, never the dashboard registry', () => {
    // The market is text-first (the card test above pins zero <svg>), and both routes
    // SSR — so the inlined thumb.svg strings would be dead weight in every document.
    expect(src('./templates.tsx')).toContain('listPublicBundles')
    expect(src('./templates_.$slug.tsx')).toContain('getPublicTemplate')
    for (const rel of ['./templates.tsx', './templates_.$slug.tsx']) {
      expect(src(rel)).not.toMatch(/\blistBundles\b/)
    }
  })

  it('the detail loader resolves ONE template by slug — a hover never pulls the catalog', () => {
    // The grid preloads this route on card hover (`defaultPreload: 'intent'`), so the
    // loader must not fetch every template to render one.
    const detail = src('./templates_.$slug.tsx')
    expect(detail).toContain('await getPublicTemplate({ data: params.slug })')
    expect(detail).not.toContain('listPublicBundles')
    // No client-side scan left behind.
    expect(detail).not.toMatch(/\.members\.find\(/)
    expect(src('../router.tsx')).toContain("defaultPreload: 'intent'")
  })
})
