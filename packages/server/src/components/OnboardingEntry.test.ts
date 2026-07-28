// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnboardingEntry } from './OnboardingEntry'

/**
 * The homepage trigger: a new user (no loops, no machines) is auto-started into the
 * guided flow ONCE; a user who already has a loop never sees it. Guards the
 * activation-leak fix — onboarding must reach fresh signups and stay out of the way
 * for everyone else.
 */
const nav = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => nav }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null
function render(el: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
}
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  nav.mockClear()
  window.localStorage.clear()
})

describe('OnboardingEntry trigger', () => {
  it('auto-starts the wizard for a genuinely empty workspace (no loops, no machines)', () => {
    render(createElement(OnboardingEntry, { teamId: 'teamA', noLoops: true, noMachines: true }))
    // The dashboard's team rides along, so the wizard binds to the SAME team the
    // banner was shown for (never the last-used-team cookie, which can drift).
    expect(nav).toHaveBeenCalledWith({ to: '/onboarding', search: { team: 'teamA' } })
  })

  it('open mode (no team) starts the wizard with no team segment', () => {
    render(createElement(OnboardingEntry, { noLoops: true, noMachines: true }))
    expect(nav).toHaveBeenCalledWith({ to: '/onboarding', search: {} })
  })

  it('does NOT auto-start when the user already has a loop', () => {
    render(createElement(OnboardingEntry, { teamId: 'teamA', noLoops: false, noMachines: true }))
    expect(nav).not.toHaveBeenCalled()
    // ...and it renders nothing at all for a user with loops.
    expect(host!.textContent).toBe('')
  })

  it('does NOT auto-start again once dismissed, but still offers a manual entry banner', () => {
    // First empty render auto-starts and marks dismissed.
    render(createElement(OnboardingEntry, { teamId: 'teamA', noLoops: true, noMachines: true }))
    expect(nav).toHaveBeenCalledTimes(1)
    act(() => root!.unmount())
    nav.mockClear()

    // A second visit (still no loops) must not auto-redirect — but keeps a manual hook.
    render(createElement(OnboardingEntry, { teamId: 'teamA', noLoops: true, noMachines: true }))
    expect(nav).not.toHaveBeenCalled()
    expect(host!.textContent).toContain('Guided setup')
  })

  it('does NOT auto-start when a machine is already connected (only fully empty auto-starts)', () => {
    render(createElement(OnboardingEntry, { teamId: 'teamA', noLoops: true, noMachines: false }))
    expect(nav).not.toHaveBeenCalled()
    // No loops yet ⇒ the manual banner is still offered.
    expect(host!.textContent).toContain('Guided setup')
  })
})
