import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the Runs-panel width overflow.
 *
 * The timeline strip is a flex row of fixed-width (`shrink-0`) run blocks plus an
 * optional next-run marker. A full WINDOW of blocks is wider than a narrow rail
 * (e.g. the loop page's ~320px runs rail), so an unbounded strip painted its
 * blocks past the card's right edge and forced a page-level horizontal scrollbar
 * (against the hard no-page-scroll rule). The fix contains the strip: its root row
 * must be able to shrink (`min-w-0`) and scroll its surplus inside its own box
 * (`overflow-x-auto`) instead of widening the card.
 */
const src = readFileSync(fileURLToPath(new URL('./Timeline.tsx', import.meta.url)), 'utf8')

describe('Timeline strip width containment', () => {
  it('contains the strip root so it can shrink and scroll-x inside its own box', () => {
    // The root flex row that wraps the pagers + run blocks.
    const rootRow = /<div className="flex[^"]*">\s*<Pager count=\{olderHidden\}/.exec(src)?.[0]
    expect(rootRow, 'the strip root flex row should exist').toBeTruthy()
    expect(rootRow).toMatch(/\bmin-w-0\b/)
    expect(rootRow).toMatch(/\boverflow-x-auto\b/)
  })

  it('keeps the run blocks fixed-width (shrink-0) — containment is on the row, not the blocks', () => {
    expect(src).toMatch(/const SEG = `h-5 w-\[18px\] shrink-0/)
  })
})
