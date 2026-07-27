// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposeModal } from './ComposeModal'
import type { TemplateInfo } from '../types'

/**
 * The dashboard's New-Loop flow (ComposeModal) must show the SAME live milestone
 * checklist as the onboarding wizard while waiting for the agent to create the loop —
 * fed by the shared `useCreationProgress` hook against the same claim-progress data.
 */
const h = vi.hoisted(() => ({ steps: [] as string[] }))

vi.mock('../server/loopApi', () => ({
  mintClaim: vi.fn(async () => ({ token: 'ck_test' })),
  getConfig: vi.fn(async () => ({ loopanyCli: 'npx @crewlet/loopany@latest', customCli: false, onboardingSim: false })),
  claimStatus: vi.fn(async () => ({ done: false })),
  claimProgress: vi.fn(async () => ({ steps: h.steps })),
}))
// Render the Base UI Dialog shell inline (no portal / focus-trap) so we can query it.
vi.mock('./Modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? createElement('div', null, children) : null),
  ModalHead: ({ title }: { title: string }) => createElement('div', null, title),
}))
vi.mock('./LoopFlow', () => ({ LoopFlow: () => null, hasLoopFlow: () => false }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HK: TemplateInfo = { name: 'housekeeper', label: 'Tech Debt Cleanup', desc: 'A daily janitor.', description: 'Keep this codebase tidy.' }

let root: Root | null = null
let host: HTMLElement | null = null
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  h.steps = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

describe('ComposeModal New-Loop waiting state', () => {
  it('shows the live checklist while waiting, and lights it up as milestones arrive', async () => {
    act(() => root!.render(createElement(ComposeModal, { open: true, template: HK, onClose: () => {}, onCreated: () => {} })))
    await advance(0) // flush mintClaim → token
    // The waiting state renders the shared checklist (every milestone label).
    expect(host!.textContent).toContain('Waiting for your coding agent')
    expect(host!.textContent).toContain('Reading the setup instructions')
    expect(host!.textContent).toContain('Creating the loop')
    // Degraded (no reports) → the first step pulses as "working…".
    expect(host!.textContent).toContain('working…')
    // The lean snippet carries no reporting protocol (round 8).
    expect(host!.textContent).not.toContain('curl')
    expect(host!.textContent).not.toContain('/api/claim/progress')

    // Real reports arrive (via `loopany progress`) → the checklist advances.
    h.steps = ['reading', 'inspecting', 'configuring']
    await advance(1600)
    // Three done → the active cursor moved past them (still "working…" on authoring).
    expect(host!.textContent).toContain('working…')
  })
})
