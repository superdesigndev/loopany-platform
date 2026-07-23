// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingWizard } from './OnboardingWizard'
import { savePersisted } from '../lib/onboardingState'
import type { TemplateInfo } from '../types'

/**
 * The wizard's step state machine, driven end-to-end against mocked server fns.
 * The load-bearing guarantee: each step advances on DETECTED reality, not a claimed
 * Next — the machine step's Continue stays disabled until `machineStatus.online`,
 * and the prompt step only advances to the celebration when `claimStatus.done`.
 * Also pins resume-from-storage and the dev-sim button gating.
 */
const h = vi.hoisted(() => ({ online: false, done: false, sim: false }))

vi.mock('../server/machineFns', () => ({
  createMachine: vi.fn(async () => ({ id: 'm-1', token: 'dk_test' })),
  machineStatus: vi.fn(async () => (h.online ? { online: true, hostname: 'sim-host' } : { online: false })),
  finalizeMachine: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../server/loopApi', () => ({
  getConfig: vi.fn(async () => ({ loopanyCli: 'npx @crewlet/loopany@latest', customCli: false, onboardingSim: h.sim })),
  mintClaim: vi.fn(async () => ({ token: 'ck_test' })),
  claimStatus: vi.fn(async () => (h.done ? { done: true, id: 'loop-1' } : { done: false })),
}))
vi.mock('../server/onboardingSim', () => ({
  simulateMachineConnect: vi.fn(async () => {
    h.online = true
    return { ok: true }
  }),
  simulateLoopCreated: vi.fn(async () => {
    h.done = true
    return { ok: true }
  }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HK: TemplateInfo = {
  name: 'housekeeper',
  label: 'Tech Debt Cleanup',
  desc: 'A daily janitor.',
  description: 'Set up a daily loop that keeps this codebase tidy, one proven cleanup at a time.',
}

let root: Root | null = null
let host: HTMLElement | null = null
const onExit = vi.fn()

function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(OnboardingWizard, { teamId: 'teamA', housekeeper: HK, onExit })))
}
/** Advance past a poll interval and flush the async server-fn promises. */
async function poll(ms = 2600) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
function findButton(label: string | RegExp): HTMLButtonElement | undefined {
  const re = typeof label === 'string' ? new RegExp(label, 'i') : label
  return [...host!.querySelectorAll('button')].find((b) => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined
}
function click(label: string | RegExp) {
  const b = findButton(label)
  if (!b) throw new Error(`no button matching ${label}`)
  act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  vi.useFakeTimers()
  h.online = false
  h.done = false
  h.sim = false
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  onExit.mockClear()
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('OnboardingWizard step machine', () => {
  it('advances welcome → machine → (detected connect) → meet → prompt → (detected loop) → done', async () => {
    render()
    await poll(0) // flush getConfig
    expect(host!.textContent).toContain('Your first loop')

    click('Get started')
    await poll(0) // flush createMachine
    expect(host!.textContent).toContain('Get your machine online')
    // The connect command is rendered from the minted device token.
    expect(host!.textContent).toContain('--connect-key dk_test')

    // Detected reality: Continue is disabled while the machine is offline.
    expect(findButton('Continue')!.disabled).toBe(true)
    expect(host!.textContent).toContain('Waiting for your machine')

    // Machine comes online → the poll flips the step complete, Continue enables.
    h.online = true
    await poll()
    expect(host!.textContent).toContain('Machine connected')
    expect(findButton('Continue')!.disabled).toBe(false)

    click('Continue')
    expect(host!.textContent).toContain('Meet Housekeeper')
    // The three-act cinematic renders (all acts mount; content that is present from
    // the first frame — later beats like the Merged stamp arrive on a timeline).
    expect(host!.textContent).toContain('8:00 AM')
    expect(host!.textContent).toContain('Remove dead code')
    expect(host!.textContent).toContain('Cleanliness score')

    click('Set it up')
    await poll(0) // flush mintClaim
    expect(host!.textContent).toContain('Copy the prompt')
    // The paste snippet carries the bootstrap line, the claim key, and the template intent.
    expect(host!.textContent).toContain('/api/bootstrap')
    expect(host!.textContent).toContain('connect-key: ck_test')
    expect(host!.textContent).toContain('keeps this codebase tidy')

    // Detected reality: nothing advances until a real loop lands.
    expect(host!.textContent).not.toContain('Housekeeper is live')
    h.done = true
    await poll()
    expect(host!.textContent).toContain('Housekeeper is live')

    click('Go to dashboard')
    expect(onExit).toHaveBeenCalled()
  })

  it('resumes mid-flow from persisted state (lands on the prompt step)', async () => {
    savePersisted('teamA', { step: 'prompt', machineId: 'm-1', machineToken: 'dk_test', claimToken: 'ck_test' })
    render()
    await poll(0)
    expect(host!.textContent).toContain('Copy the prompt')
    expect(host!.textContent).toContain('connect-key: ck_test')
  })

  it('hides the dev-sim buttons when onboardingSim is off, shows them when on', async () => {
    render()
    await poll(0)
    click('Get started')
    await poll(0)
    expect(findButton('Simulate connection')).toBeUndefined()

    // Re-render fresh (clear the resume state persisted above) with the flag on.
    act(() => root!.unmount())
    host?.remove()
    window.localStorage.clear()
    h.sim = true
    h.online = false
    render()
    await poll(0)
    click('Get started')
    await poll(0)
    const simBtn = findButton('Simulate connection')
    expect(simBtn).toBeDefined()

    // Clicking it flips the machine online via the (mocked) real store write path.
    click('Simulate connection')
    await poll()
    expect(findButton('Continue')!.disabled).toBe(false)
  })
})
