import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the run-detail redesign's width containment.
 *
 * The redesign widened the run page to the loop page's shell and moved to a
 * two-column layout with a wide diff/transcript column. The hard project rule is
 * NO page-level horizontal scroll at any width: every grid/flex child must be able
 * to shrink (`min-w-0`) and any wide inner content (a long diff/transcript line)
 * must scroll INSIDE its own pane, never widen the page. These assertions pin the
 * structural classes that enforce that so a future edit can't silently regress it.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const runView = read('./RunView.tsx')
const diffView = read('./DiffView.tsx')
const route = read('../routes/loops.$loopId_.runs.$runId.tsx')

describe('run detail page width containment', () => {
  it('matches the loop page shell width', () => {
    expect(route).toMatch(/max-w-\[1360px\]/)
  })

  it('uses a shrinkable two-column grid like the loop page', () => {
    expect(runView).toMatch(/lg:grid-cols-\[minmax\(0,1fr\)_minmax\(300px,360px\)\]/)
  })

  it('makes the section cards shrinkable so wide content contains inside them', () => {
    // The Card wrapper must carry min-w-0. Assert ONLY the behavioral class -
    // the decoration around it is fashion and must be free to change.
    expect(runView).toMatch(/<section className="min-w-0 /)
  })

  it('scrolls the diff body inside its own pane rather than widening the page', () => {
    expect(diffView).toMatch(/min-w-0 max-h-\[420px\] overflow-auto/)
    // Long lines DON'T wrap — they scroll horizontally inside the capped pane.
    expect(diffView).toMatch(/whitespace-pre/)
  })

  it('retires the modal-era bracket loading/error placeholders', () => {
    expect(runView).not.toMatch(/\[ Loading \]/)
    expect(runView).not.toMatch(/\[ ERROR \]/)
  })
})
