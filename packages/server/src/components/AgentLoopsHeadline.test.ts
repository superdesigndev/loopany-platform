// @vitest-environment jsdom
/*
 * Guard for the browser-translation crash on the typed hero.
 *
 * A browser translator (Chrome/Edge/Safari) rewrites text by MOVING each text node
 * into an injected `<font>` wrapper, which invalidates React's record of that node's
 * parent. `TypedLine` re-renders its text every 26-55ms, so React soon has to remove
 * a text node the translator has re-parented and throws `NotFoundError: Failed to
 * execute 'removeChild' on 'Node'`, taking the whole route down to its error
 * boundary (reproduced on /templates, 2026-07-31; the crashing node was the
 * `{tail}` text node inside `span.whitespace-nowrap`).
 *
 * The fix is `translate="no"` on the element that WRAPS the animated subtree. These
 * tests pin BOTH facts that make it work: the attribute is present, and it sits on
 * an ancestor of the animated part (moving it to a sibling would silently un-fix the
 * crash while keeping any attribute-only assertion green).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentLoopsHeadline } from './TemplatesPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(props: { as?: 'h1' | 'h2'; compact?: boolean }): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(createElement(AgentLoopsHeadline, props))
  })
  return host
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
})

describe('AgentLoopsHeadline — browser-translation opt-out', () => {
  it('marks the headline translate="no" (h1, the /templates market hero)', () => {
    const el = render({ as: 'h1' }).querySelector('h1')
    expect(el).not.toBeNull()
    expect(el!.getAttribute('translate')).toBe('no')
  })

  it('marks the compact band headline too (h2, dashboard + pre-login landing)', () => {
    const el = render({ as: 'h2', compact: true }).querySelector('h2')
    expect(el).not.toBeNull()
    expect(el!.getAttribute('translate')).toBe('no')
  })

  it('puts the opt-out on an ANCESTOR of the animated subtree, not beside it', () => {
    const host = render({ as: 'h1' })
    const optedOut = host.querySelector('[translate="no"]')
    expect(optedOut).not.toBeNull()

    // The caret is rendered by TypedLine, i.e. it marks the subtree whose text
    // mutates at animation rate — the exact thing the translator must not touch.
    const caret = host.querySelector('.type-caret')
    expect(caret, 'TypedLine should render a caret').not.toBeNull()
    expect(optedOut!.contains(caret!), 'translate="no" must wrap the animated text').toBe(true)
  })

  it('still renders the SSR/first-paint phrase as real text (crawlers, no-JS)', () => {
    // The opt-out must not change what is rendered — only how translators treat it.
    const host = render({ as: 'h1' })
    expect(host.textContent).toContain('Agent Loops')
    expect(host.textContent).toContain('that actually work')
  })
})
