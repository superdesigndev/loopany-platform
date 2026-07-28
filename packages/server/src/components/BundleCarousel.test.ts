// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BundleCarousel, splitRows } from './BundleCarousel'
import type { BundleView, TemplateInfo } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tmpl = (name: string, label: string): TemplateInfo => ({
  name,
  label,
  desc: `${label} blurb`,
  description: `${label} full setup`,
})

const bundle = (
  name: string,
  label: string,
  accent: BundleView['accent'],
  members: [string, string][],
  individual = false,
): BundleView => ({
  name,
  label,
  tagline: `${label} tagline`,
  accent,
  individual,
  members: members.map(([n, l]) => tmpl(n, l)),
})

const bundles: BundleView[] = [
  bundle('engineering', 'Engineering', 'interactive', [
    ['react-doctor', 'React Doctor'],
    ['housekeeper', 'Tech Debt Cleanup'],
    ['docs-sweep', 'Doc Maintainer'],
    ['dependency-triage', 'Dependency Triage'],
    ['error-sweep', 'Error Sweep'],
  ]),
  bundle('growth', 'Growth', 'rubik-green', [['market-research', 'Market Monitor'], ['reddit-karma', 'Reddit Karma']]),
  bundle('others', 'Others', 'secondary', [['follow-up-tracker', 'Follow-up Tracker']], true),
]

/** Stub matchMedia to report a reduced-motion preference (jsdom has none by default). */
function stubReducedMotion(matches: boolean) {
  ;(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () =>
    ({ matches, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  // Default: no reduced-motion preference (auto-play allowed).
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
  vi.useRealTimers()
})

async function mount(props: Parameters<typeof BundleCarousel>[0]): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(BundleCarousel, props))
  })
  return host
}

const trackIdx = (el: HTMLElement): number => {
  const t = el.querySelector('.bundle-carousel-track') as HTMLElement
  // transform is `translateX(${-idx*100}%)` → at idx 0 it's `0%` (no minus).
  const m = /translateX\((-?\d+)%\)/.exec(t.style.transform)
  return m ? -Number(m[1]) / 100 + 0 : NaN // + 0 normalizes -0 → 0 for toBe(0)
}

describe('splitRows — balanced rows of up to N, larger row on top', () => {
  const sizes = (rows: number[][]) => rows.map((r) => r.length)
  const seq = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('keeps <=3 in a single row; splits 4 into 3+1 and 5 into 3+2 (the captain examples)', () => {
    expect(sizes(splitRows(seq(3), 3))).toEqual([3])
    expect(sizes(splitRows(seq(4), 3))).toEqual([3, 1])
    expect(sizes(splitRows(seq(5), 3))).toEqual([3, 2])
  })

  it('generalizes: 6->[3,3], 7->[3,3,1], larger rows on top, never drops/overflows', () => {
    expect(sizes(splitRows(seq(6), 3))).toEqual([3, 3])
    expect(sizes(splitRows(seq(7), 3))).toEqual([3, 3, 1])
    for (let n = 1; n <= 12; n++) {
      const rows = splitRows(seq(n), 3)
      expect(rows.flat().length).toBe(n)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(3)
      // rows are non-increasing (larger rows on top).
      const s = rows.map((r) => r.length)
      for (let i = 1; i < s.length; i++) expect(s[i]!).toBeLessThanOrEqual(s[i - 1]!)
    }
  })
})

describe('BundleCarousel structure', () => {
  it('shows ONE bundle at a time (others aria-hidden) with arrows + a dot per bundle', async () => {
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    const slides = [...el.querySelectorAll('.bundle-slide')]
    expect(slides.length).toBe(3)
    // Exactly one slide is the active (non-hidden) one.
    expect(slides.filter((s) => s.getAttribute('aria-hidden') === 'false').length).toBe(1)
    expect(el.querySelector('.bundle-arrow-prev')).toBeTruthy()
    expect(el.querySelector('.bundle-arrow-next')).toBeTruthy()
    // One dot per bundle.
    const dots = [...el.querySelectorAll('button[aria-label^="Go to"]')]
    expect(dots.length).toBe(3)
  })

  it('wraps a 5-loop bundle fan into balanced rows of 3 then 2', async () => {
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    // Engineering (active, idx 0) has 5 members → its fan rows are [3, 2].
    const activeSlide = [...el.querySelectorAll('.bundle-slide')].find((s) => s.getAttribute('aria-hidden') === 'false')!
    const fanRows = [...activeSlide.querySelectorAll('.flex.flex-wrap')]
    expect(fanRows.map((r) => r.querySelectorAll('button.fan-card').length)).toEqual([3, 2])
  })

  it('CTA is exactly "Try this bundle" for tryable bundles, absent for Others', async () => {
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    // Engineering + Growth are tryable → 2 CTAs; Others has none.
    const ctas = [...el.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Try this bundle')
    expect(ctas.length).toBe(2)
    // No leftover "Copy prompt" prefix anywhere.
    expect(el.innerHTML).not.toContain('Copy prompt')
    // The Others slide keeps the single-loop hint but shows no bundle CTA.
    const others = [...el.querySelectorAll('.bundle-slide')].find((s) => (s.getAttribute('aria-label') ?? '').startsWith('Others'))!
    expect(others.textContent).toContain('or click a loop to set it up alone')
    expect([...others.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Try this bundle')).toBe(false)
  })
})

describe('BundleCarousel interaction', () => {
  it('fires onTryBundle (active) and onPickTemplate (single card)', async () => {
    const onTryBundle = vi.fn()
    const onPickTemplate = vi.fn()
    const el = await mount({ bundles, onPickTemplate, onTryBundle })
    const cta = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try this bundle')!
    await act(async () => cta.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onTryBundle).toHaveBeenCalledWith(bundles[0])
    const card = [...el.querySelectorAll('button.fan-card')].find((b) => (b.textContent ?? '').includes('React Doctor'))!
    await act(async () => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onPickTemplate).toHaveBeenCalledWith(bundles[0]!.members[0])
  })

  it('next arrow advances to the following bundle and stops auto-play', async () => {
    vi.useFakeTimers()
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    expect(trackIdx(el)).toBe(0)
    const nextBtn = el.querySelector('.bundle-arrow-next') as HTMLButtonElement
    await act(async () => nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(trackIdx(el)).toBe(1)
    // Manual nav stops auto-play: advancing the clock does not move it further.
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(trackIdx(el)).toBe(1)
  })
})

describe('BundleCarousel arrow keys are SCOPED to the carousel', () => {
  const arrow = () => new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
  const cta = (el: HTMLElement) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try this bundle')!

  it('an in-carousel arrow press navigates and counts as a manual stop', async () => {
    vi.useFakeTimers()
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    await act(async () => cta(el).dispatchEvent(arrow()))
    expect(trackIdx(el)).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(9_200)
    })
    expect(trackIdx(el)).toBe(1)
  })

  it('ignores an arrow press outside the carousel — auto-play keeps running', async () => {
    vi.useFakeTimers()
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    await act(async () => outside.dispatchEvent(arrow()))
    expect(trackIdx(el)).toBe(0)
    // Not stopped either: the interval still advances it.
    await act(async () => {
      vi.advanceTimersByTime(4_600)
    })
    expect(trackIdx(el)).toBe(1)
    outside.remove()
  })

  it('ignores arrow presses while a dialog owns the page (the carousel stays mounted behind every modal)', async () => {
    vi.useFakeTimers()
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    await act(async () => cta(el).dispatchEvent(arrow()))
    expect(trackIdx(el)).toBe(0)
    dialog.remove()
  })
})

describe('BundleCarousel auto-play', () => {
  it('auto-advances on the interval, and pauses on focus within', async () => {
    vi.useFakeTimers()
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    expect(trackIdx(el)).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(4_600)
    })
    expect(trackIdx(el)).toBe(1)
    // Focus within the carousel pauses (onFocusCapture): the clock advances, index holds.
    const cta = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try this bundle')!
    await act(async () => cta.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    await act(async () => {
      vi.advanceTimersByTime(9_200)
    })
    expect(trackIdx(el)).toBe(1)
  })

  it('does NOT auto-play under prefers-reduced-motion', async () => {
    stubReducedMotion(true)
    vi.useFakeTimers()
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(trackIdx(el)).toBe(0)
  })
})
