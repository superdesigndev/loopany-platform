// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { LoopCalendar } from './LoopCalendar'
import type { ArtifactSummary } from '../types'

vi.mock('../server/loopApi', () => ({
  getArtifact: vi.fn(async () => ({ text: 'hello' })),
}))

// jsdom has no ResizeObserver/layout. The stub reports `measuredWidth` on
// observe, so a test picks the container width the calendar "sees".
let measuredWidth = 800
class RO {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe(el: Element) {
    this.cb(
      [{ target: el, contentRect: { width: measuredWidth, height: 400 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (path: string, meta: ArtifactSummary['meta'] = null): ArtifactSummary => ({
  path,
  size: 10,
  updatedAt: '2026-07-01T08:00:00.000Z',
  binary: false,
  oversize: false,
  meta,
})
const ARTIFACTS = [file('reports/digest-2026-07-01.md'), file('reports/digest-2026-06-30.md')]

/**
 * Mount through the REAL prop lifecycle: artifacts is null on first render
 * (LoopView fetches the list lazily) and arrives on a later one. The width
 * observer must survive that transition — it used to attach only on first
 * mount, when the loading early-return meant the observed root div did not
 * exist, so dot mode could never engage in production.
 */
async function mountThroughLoading(width: number): Promise<string> {
  measuredWidth = width
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const props = { loopId: 'loop-1', match: 'reports/*.md' }
  await act(async () => {
    root.render(createElement(LoopCalendar, { ...props, artifacts: null }))
  })
  expect(host.innerHTML).toContain('Loading…')
  await act(async () => {
    root.render(createElement(LoopCalendar, { ...props, artifacts: ARTIFACTS }))
  })
  const out = host.innerHTML
  await act(async () => root.unmount())
  host.remove()
  return out
}

describe('LoopCalendar dot mode', () => {
  it('collapses chips to dots when the container measures under 620px', async () => {
    const out = await mountThroughLoading(500)
    expect(out).toContain('size-2') // the dot button
    expect(out).not.toContain('truncate rounded-full border') // no named chips
  })

  it('renders named chips at wide container widths', async () => {
    const out = await mountThroughLoading(800)
    expect(out).toContain('truncate rounded-full border')
    expect(out).not.toContain('size-2')
  })
})

describe('LoopCalendar front-matter dating', () => {
  it('dates a product by its front-matter date over the filename, and labels the source', async () => {
    measuredWidth = 800
    // Filename says 2026-07-01; front matter says the 15th → the 15th wins and is
    // the newest, so it auto-selects and the viewer labels it "dated by front matter".
    const arts = [file('reports/digest-2026-07-01.md', { date: '2026-07-15', title: 'Mid-July' })]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(LoopCalendar, { loopId: 'loop-1', match: 'reports/*.md', artifacts: arts }))
    })
    const out = host.innerHTML
    await act(async () => root.unmount())
    host.remove()
    // The selected product's viewer caption reflects the authoritative source…
    expect(out).toContain('· dated by front matter ·')
    // …and the calendar shows July 2026 (the front-matter month, not June).
    expect(out).toContain('July 2026')
  })
})
