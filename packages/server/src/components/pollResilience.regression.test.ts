import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guards for the page-poll resilience fixes.
 *
 * (1) LoopDetailView: a transient initial-load failure used to brick the page
 * permanently — `load()` set `err`, the background poll kept succeeding but never
 * cleared it, and the `if (err)` render guard won over the fresh data. The poll
 * must clear `err` on success, and the error view must offer a Retry (mirroring
 * RunDetailView's).
 *
 * (2) LoopDetailView: dispatching a SECOND edit in a page session must start
 * from a clean slate - `onRequestEdit` re-seeds `seenRunIds` from the current
 * runs (so the status card tracks the NEW edit run, not a settled earlier one)
 * and clears the accumulated progress log. (The transcript variant of this bug
 * died with the takeover: the settled transcript now lives on the edit run's
 * own detail page.)
 *
 * (3) ComposeModal: the claimStatus setInterval tick had no rejection handler —
 * an unhandled rejection every 2.5s during a server hiccup. The tick must catch.
 */
const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')

describe('LoopDetailView poll/error resilience', () => {
  const src = read('LoopDetailView.tsx')

  it('clears err when a background poll succeeds (un-bricks a transient initial failure)', () => {
    // load(silent) is the single fetch for both the initial load and the poll:
    // success always clears err; only a NON-silent (initial) failure sets it.
    const load = /const load = useCallback\(\s*async \(silent = false\) => \{[\s\S]*?\[id\],?\s*\)/.exec(src)?.[0]
    expect(load, 'the load(silent) callback should exist').toBeTruthy()
    expect(load).toContain('setErr(null)')
    expect(load).toContain('if (!silent) setErr(')
    // The poll tick is the silent variant of the same callback.
    expect(src).toContain('void load(true)')
  })

  it('offers a Retry in the fatal-error view (the shared LoadErrorCard)', () => {
    const errView = /if \(err\)\s*return \(\s*<Shell[\s\S]*?<\/Shell>\s*\)/.exec(src)?.[0]
    expect(errView, 'the error view should exist').toBeTruthy()
    expect(errView).toContain('LoadErrorCard')
    expect(errView).toContain('void load()')
  })

  it('starts a fresh dispatch from a clean slate (second edit tracks its own run)', () => {
    const dispatch = /async function onRequestEdit\(\) \{[\s\S]*?\n  \}/.exec(src)?.[0]
    expect(dispatch, 'onRequestEdit should exist').toBeTruthy()
    expect(dispatch).toContain('seenRunIds.current = new Set(')
    expect(dispatch).toContain('setEditLog([])')
  })
})

describe('ComposeModal claim-poll rejection handling', () => {
  const src = read('ComposeModal.tsx')

  it('catches a failed claimStatus tick (no unhandled rejection every 2.5s)', () => {
    const tick = /pollRef\.current = setInterval\(\(\) => \{[\s\S]*?\}, 2500\)/.exec(src)?.[0]
    expect(tick, 'the claim poll tick should exist').toBeTruthy()
    expect(tick).toContain('.catch(')
    // The old shape passed a bare async fn to setInterval — its rejection had no handler.
    expect(src).not.toMatch(/setInterval\(async /)
  })
})
