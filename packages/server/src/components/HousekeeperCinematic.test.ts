// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HousekeeperCinematic } from './HousekeeperCinematic'

/**
 * The "Meet Housekeeper" cinematic: a four-act, elapsed-clock storyboard —
 * morning wake-up → one clean PR → a day-by-day compounding montage (score climbs
 * 30 → 80 over Day 1…30) → the cadence beat. Auto-plays, pauses on hover, rests on
 * the last act with Replay, and falls back to static stills for reduced-motion.
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
const dayText = () => host!.querySelector('[data-testid="hk-day"]')!.textContent
// React synthesizes onMouseEnter/Leave from delegated mouseover/mouseout (with a
// relatedTarget outside the element), so drive those rather than raw enter/leave.
function hover(enter: boolean) {
  act(() => cine().dispatchEvent(new MouseEvent(enter ? 'mouseover' : 'mouseout', { bubbles: true, relatedTarget: enter ? null : document.body })))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  delete (window as { matchMedia?: unknown }).matchMedia
  vi.useRealTimers()
})

describe('motion mode (auto-play)', () => {
  it('renders all four acts and starts on act 0', () => {
    render()
    expect(dataAct()).toBe('0')
    expect(host!.textContent).toContain('7:00 AM')
    expect(host!.textContent).toContain('Remove dead code')
    expect(host!.textContent).toContain('A little better every day')
    expect(host!.textContent).toContain('Cleanliness score')
    expect(host!.textContent).toContain('Every morning · 07:00')
  })

  it('auto-advances act 0 → 1 → 2 → 3 with cinematic pacing, then rests', async () => {
    render()
    expect(dataAct()).toBe('0')
    await advance(2800) // PR (act 1)
    expect(dataAct()).toBe('1')
    await advance(4000) // day montage (act 2)
    expect(dataAct()).toBe('2')
    await advance(5500) // cadence (act 3)
    expect(dataAct()).toBe('3')
    // Rests on the last act — no wraparound.
    await advance(4000)
    expect(dataAct()).toBe('3')
  })

  it('climbs the day counter Day 1 → Day 30 as the montage plays', async () => {
    render()
    await advance(6800) // into the montage
    expect(dataAct()).toBe('2')
    expect(dayText()).toMatch(/^Day [1-9]/)
    await advance(5000) // through to the last day
    expect(dayText()).toBe('Day 30')
  })

  it('steps the cleanliness score up to 80 by the last day', async () => {
    render()
    expect(score()).toBe('30')
    await advance(7000) // mid-montage — climbing, not yet 80
    const mid = Number(score())
    expect(mid).toBeGreaterThan(30)
    expect(mid).toBeLessThan(80)
    await advance(5000) // land on 80
    expect(score()).toBe('80')
  })

  it('pauses the clock on hover and resumes on leave', async () => {
    render()
    await advance(2800)
    expect(dataAct()).toBe('1')
    hover(true)
    await advance(8000) // paused — nothing advances
    expect(dataAct()).toBe('1')
    hover(false)
    await advance(8000) // resumes and reaches the montage
    expect(dataAct()).not.toBe('1')
  })

  it('offers a Replay on the final act that restarts the story', async () => {
    render()
    await advance(13000)
    expect(dataAct()).toBe('3')
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

  it('shows the acts as stills, no auto-play, score pinned at its final value', async () => {
    render()
    expect(dataAct()).toBe('stills')
    expect(score()).toBe('80')
    expect(host!.textContent).toContain('7:00 AM')
    expect(host!.textContent).toContain('Merged')
    expect(host!.textContent).toContain('Day 30')
    expect(host!.textContent).toContain('Every morning · 07:00')
    // Advancing time changes nothing — there is no auto-play.
    await advance(13000)
    expect(dataAct()).toBe('stills')
    expect(score()).toBe('80')
  })
})
