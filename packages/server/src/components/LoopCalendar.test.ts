// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { LoopCalendar } from './LoopCalendar'
import type { ArtifactSummary } from '../types'

vi.mock('../server/loopApi', () => ({
  getArtifact: vi.fn(async () => ({ text: 'hello from the product' })),
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
  it('dates a product by its front-matter date over the filename, and labels the source in the modal', async () => {
    measuredWidth = 800
    // Filename says 2026-07-01; front matter says the 15th → the 15th wins.
    const arts = [file('reports/digest-2026-07-01.md', { date: '2026-07-15', title: 'Mid-July' })]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(LoopCalendar, { loopId: 'loop-1', match: 'reports/*.md', artifacts: arts }))
    })
    // The calendar shows July 2026 (the front-matter month, not June)…
    expect(host.innerHTML).toContain('July 2026')
    // …and nothing is reviewed yet (the modal is a body-level portal).
    expect(document.body.innerHTML).not.toContain('hello from the product')
    // Click the product chip → the modal opens with the body and the date source.
    const chip = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('digest'))
    if (!chip) throw new Error('no product chip')
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.body.innerHTML).toContain('hello from the product')
    expect(document.body.innerHTML).toContain('Mid-July') // front-matter title as the head
    expect(document.body.innerHTML).toContain('dated by front matter')
    // Close returns to the grid.
    const close = [...document.body.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Close',
    )
    if (!close) throw new Error('no modal close button')
    await act(async () => {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.body.innerHTML).not.toContain('hello from the product')
    await act(async () => root.unmount())
    host.remove()
  })

  it('drops the open review when its artifact vanishes on a poll refresh', async () => {
    measuredWidth = 800
    const arts = [file('reports/digest-2026-07-01.md', { title: 'Keep me' })]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const props = { loopId: 'loop-1', match: 'reports/*.md' }
    await act(async () => {
      root.render(createElement(LoopCalendar, { ...props, artifacts: arts }))
    })
    // Open the product's review modal.
    const chip = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('digest'))
    if (!chip) throw new Error('no product chip')
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.body.innerHTML).toContain('hello from the product')
    // A poll refresh drops that artifact → the modal closes instead of pointing
    // at stale data (derived during render, no syncing effect).
    await act(async () => {
      root.render(createElement(LoopCalendar, { ...props, artifacts: [] }))
    })
    expect(document.body.innerHTML).not.toContain('hello from the product')
    await act(async () => root.unmount())
    host.remove()
  })
})
