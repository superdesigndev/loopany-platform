// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundleView, TemplateInfo } from '../types'

/**
 * The PRE-LOGIN landing (`SignIn`) is what a gated, signed-out visitor sees on every
 * gated route. It must carry the sign-in path AND the public template teaser — the
 * catalog is browsable without an account, so the landing is where that gets shown.
 */

const rating: TemplateInfo['rating'] = {
  ease: 'easy',
  cadence: 'short',
  mechanism: 'open',
  visibility: 'first-run',
  visibilityNote: 'The first run fixes the worst issue.',
  does: 'Scans the app → fixes the worst issue',
  outcome: '🔀 One verified fix PR daily',
  schedule: 'Daily · ~6am',
}

const bundles: BundleView[] = [
  {
    name: 'code-health',
    label: 'Code Health',
    tagline: 'Keep your codebase healthy while you sleep.',
    accent: 'interactive',
    members: [
      { name: 'react-doctor', label: 'React Doctor', desc: 'React Doctor blurb', description: 'React Doctor prompt', rating },
      { name: 'housekeeper', label: 'Housekeeper', desc: 'Housekeeper blurb', description: 'Housekeeper prompt', rating },
    ],
  },
  {
    name: 'growth',
    label: 'Growth',
    tagline: 'Grow while you sleep.',
    accent: 'rubik-green',
    members: [{ name: 'market-monitor', label: 'Market Monitor', desc: 'Market Monitor blurb', description: 'Market Monitor prompt', rating }],
  },
]

const social = vi.fn()
const listPublicBundles = vi.fn(async () => bundles)

vi.mock('../lib/auth-client', () => ({ signIn: { social: (...a: unknown[]) => social(...a) } }))
vi.mock('../server/loopApi', () => ({ listPublicBundles: () => listPublicBundles() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, params, ...p }: { children?: unknown; to?: string; search?: { template?: string }; params?: { slug?: string }; [k: string]: unknown }) => {
    let href = typeof to === 'string' ? to : undefined
    if (href && params?.slug) href = href.replace('$slug', params.slug)
    if (href && search?.template) href = `${href}?template=${search.template}`
    return createElement('a', { href, ...p }, children as never)
  },
}))

import { SignIn } from './SignIn'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Source-guard reader. The path MUST stay a variable: Vite statically rewrites the
 *  literal `new URL('./x', import.meta.url)` form into an asset URL (http://…), which
 *  `fileURLToPath` then rejects. Same shape as the other source-reading guards. */
const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  listPublicBundles.mockClear()
  // The playbook band mounts an IntersectionObserver + reads matchMedia; jsdom has
  // neither. Reduced motion keeps its animation off (it renders the finished state).
  ;(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () =>
    ({ matches: true, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    observe() {}
    disconnect() {}
  }
})

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
    root!.render(createElement(SignIn, { callbackURL: '/' }))
  })
  // Let the client-side public-registry fetch resolve into state.
  await act(async () => {
    await Promise.resolve()
  })
  return host
}

describe('SignIn (pre-login landing)', () => {
  it('keeps the sign-in path: value line + Continue with GitHub', async () => {
    const el = await mount()
    const btn = [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Continue with GitHub'))
    expect(btn).toBeTruthy()
    expect(el.textContent).toContain('What should happen while you sleep?')
    expect(el.textContent).toContain('never runs an LLM or your code')
  })

  it('renders the SAME template teaser as the dashboard, fading into Browse all', async () => {
    const el = await mount()
    expect(listPublicBundles).toHaveBeenCalled()
    // The shared market card under the clip+fade container: each bundle's LEAD first,
    // then a top-up from what is left (only 3 templates here, so all three show).
    expect(el.querySelectorAll('.templates-peek').length).toBe(1)
    expect(el.querySelectorAll('article.market-card').length).toBe(3)
    expect([...el.querySelectorAll('a.market-card-link')].map((a) => a.textContent)).toEqual([
      'React Doctor',
      'Market Monitor',
      'Housekeeper',
    ])
    const browse = [...el.querySelectorAll('a')].filter((a) => (a.textContent ?? '').includes('Browse all'))
    expect(browse.length).toBe(1)
    // /templates is public, so the link works while logged out.
    expect(browse[0]!.getAttribute('href')).toBe('/templates')
    expect(browse[0]!.textContent).toContain('Browse all 3 templates')
  })

  it('the teaser is best-effort — a failed registry fetch never breaks the landing', async () => {
    listPublicBundles.mockRejectedValueOnce(new Error('offline'))
    const el = await mount()
    expect([...el.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('Continue with GitHub'))).toBe(true)
    expect(el.querySelectorAll('.templates-peek').length).toBe(0)
  })

  it('sits above the playbook and reads the PUBLIC (thumb-stripped) registry', () => {
    const src = readSource('./SignIn.tsx')
    expect(src.indexOf('<TemplatesPreview')).toBeLessThan(src.indexOf('<LoopPlaybook'))
    expect(src).toContain('listPublicBundles')
    // The dashboard registry (with inlined thumb.svg) has no business on a public page.
    expect(src).not.toMatch(/\blistBundles\b/)
  })
})
