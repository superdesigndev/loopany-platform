// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HousekeeperCinematic } from './HousekeeperCinematic'

/**
 * The "Meet Housekeeper" cinematic: three acts that auto-advance with cinematic
 * pacing and rest on the last, plus a `prefers-reduced-motion` fallback that shows
 * static stills with no auto-play. Guards the behaviors the captain asked for.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null
function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(HousekeeperCinematic)))
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const cine = () => host!.querySelector('[data-testid="hk-cinematic"]')!
const dataAct = () => cine().getAttribute('data-act')
const score = () => host!.querySelector('[data-testid="hk-score"]')!.textContent

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  // Reset any matchMedia stub between tests.
  delete (window as { matchMedia?: unknown }).matchMedia
  vi.useRealTimers()
})

describe('motion mode (auto-play)', () => {
  it('renders all three acts and starts on act 0', () => {
    render()
    expect(dataAct()).toBe('0')
    // All acts live in the DOM (they crossfade), so their key copy is present.
    expect(host!.textContent).toContain('8:00 AM')
    expect(host!.textContent).toContain('Merged')
    expect(host!.textContent).toContain('−102')
    expect(host!.textContent).toContain('30 days later')
    expect(host!.textContent).toContain('Cleanliness score')
  })

  it('auto-advances act 0 → 1 → 2 with cinematic pacing, then rests', async () => {
    render()
    expect(dataAct()).toBe('0')
    await advance(2700)
    expect(dataAct()).toBe('1')
    await advance(2700)
    expect(dataAct()).toBe('2')
    // Rests on the last act — no wraparound.
    await advance(5000)
    expect(dataAct()).toBe('2')
  })

  it('counts the cleanliness score up to 80 once act 3 lands', async () => {
    render()
    expect(score()).toBe('30')
    await advance(2700) // act 1
    await advance(2700) // act 2 — count-up begins
    expect(dataAct()).toBe('2')
    await advance(1500) // let the counter finish
    expect(score()).toBe('80')
  })

  it('offers a Replay on the final act that restarts the story', async () => {
    render()
    await advance(2700)
    await advance(2700)
    expect(dataAct()).toBe('2')
    const replay = [...host!.querySelectorAll('button')].find((b) => /Replay/i.test(b.textContent ?? ''))
    expect(replay).toBeDefined()
    act(() => replay!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(dataAct()).toBe('0')
    expect(score()).toBe('30')
  })
})

describe('prefers-reduced-motion (static stills)', () => {
  beforeEach(() => {
    ;(window as { matchMedia?: unknown }).matchMedia = (q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })
  })

  it('shows the three acts as stills, no auto-play, score pinned at its final value', async () => {
    render()
    expect(dataAct()).toBe('stills')
    expect(score()).toBe('80')
    // All three acts still present as stills.
    expect(host!.textContent).toContain('8:00 AM')
    expect(host!.textContent).toContain('Merged')
    expect(host!.textContent).toContain('30 days later')
    // Advancing time changes nothing — there is no auto-play.
    await advance(6000)
    expect(dataAct()).toBe('stills')
    expect(score()).toBe('80')
  })
})
