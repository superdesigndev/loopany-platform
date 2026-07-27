// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreationChecklist, useCreationProgress } from './CreationChecklist'
import { CREATION_STEP_KEYS } from '../lib/creationSteps'

/**
 * The SHARED live-checklist component + polling behind both the onboarding wizard and
 * the dashboard's New-Loop waiting state. One extraction so the two can't drift.
 */
const h = vi.hoisted(() => ({ steps: [] as string[] }))
vi.mock('../server/loopApi', () => ({ claimProgress: vi.fn(async () => ({ steps: h.steps })) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null
function render(el: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  h.steps = []
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

describe('CreationChecklist (presentational)', () => {
  it('renders every milestone label; with nothing reported the first step is "working…"', () => {
    render(createElement(CreationChecklist, { steps: [] }))
    expect(host!.textContent).toContain('Reading the setup instructions')
    expect(host!.textContent).toContain('Inspecting your project')
    expect(host!.textContent).toContain('Creating the loop')
    expect(host!.textContent).toContain('working…')
  })

  it('once every step is reported, none is active (no "working…")', () => {
    render(createElement(CreationChecklist, { steps: [...CREATION_STEP_KEYS] }))
    expect(host!.textContent).not.toContain('working…')
  })
})

describe('useCreationProgress (shared polling)', () => {
  function Harness({ token, active }: { token: string | null; active: boolean }) {
    const steps = useCreationProgress(token, active)
    return createElement('div', { 'data-testid': 'steps' }, steps.join(','))
  }
  const read = () => host!.querySelector('[data-testid="steps"]')!.textContent

  it('polls claimProgress and reflects reported steps while active', async () => {
    render(createElement(Harness, { token: 'ck_test', active: true }))
    await advance(0)
    expect(read()).toBe('')
    h.steps = ['reading', 'inspecting']
    await advance(1600)
    expect(read()).toBe('reading,inspecting')
  })

  it('is inert (empty) when inactive or when there is no token', async () => {
    h.steps = ['reading']
    render(createElement(Harness, { token: 'ck_test', active: false }))
    await advance(1600)
    expect(read()).toBe('')

    act(() => root!.unmount())
    host!.remove()
    render(createElement(Harness, { token: null, active: true }))
    await advance(1600)
    expect(read()).toBe('')
  })
})
