import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guards for the metrics dashboard. The chart must be
 * container-driven (ResponsiveContainer at a FIXED pixel
 *    height), never a fixed-viewBox svg stretched to the container (the old
 *    renderer scaled like an image: fat strokes, ballooning height).
 */

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

describe('LoopView default grid layout', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles/app.css', import.meta.url)), 'utf8')
  const view = read('./LoopView.tsx')

  it('drives .loopview as an AT-MOST-two-column auto-fit grid (side-by-side panels, stack when narrow)', () => {
    const block = /\.loopview\s*\{[^}]*\}/.exec(css)?.[0]
    expect(block, 'a .loopview grid rule should exist').toBeTruthy()
    expect(block).toMatch(/display:\s*grid/)
    // auto-fit collapses to one full-width column for a single panel (no
    // regression) or a narrow container; the `(100% - gap) / 2` per-track min
    // caps the grid at two columns so a wide desktop never spills 3+ narrow
    // panels (which squeezed the kanban's own columns and card titles). The
    // outer min(100%, ...) clamp keeps a lone panel from overflowing a
    // sub-28rem (mobile) container into an internal horizontal scroll, and the
    // gap is a shared --loopview-gap custom property so the cap math and the
    // actual gap can never drift.
    expect(block).toMatch(/repeat\(auto-fit,\s*minmax\(min\(100%,\s*max\(/)
    expect(block).toMatch(/\(100% - var\(--loopview-gap\)\) \/ 2/)
    expect(block).toMatch(/--loopview-gap:\s*[\d.]+rem/)
    expect(block).toMatch(/gap:\s*var\(--loopview-gap\)/)
  })

  it('spans headings/prose full width so only block panels tile', () => {
    // A top-level heading or paragraph must not become a lone narrow column.
    expect(css).toMatch(/\.loopview >\s*h2[\s\S]*?grid-column:\s*1 \/ -1/)
  })

  it('the LoopView container no longer force-stacks with space-y', () => {
    // The grid gap owns spacing now; a leftover space-y-* would fight the grid.
    const container = /className="loopview[^"]*"/.exec(view)?.[0]
    expect(container).toBeTruthy()
    expect(container).not.toMatch(/space-y-/)
  })
})

describe('LoopChart container-driven sizing', () => {
  const src = read('./LoopChart.tsx')

  it('renders through ResponsiveContainer at a fixed pixel height', () => {
    expect(src).toContain('<ResponsiveContainer')
    expect(src).toMatch(/const HEIGHT = \d+/)
    expect(src).toMatch(/style=\{\{ height: HEIGHT \}\}/)
  })

  it('never reintroduces a stretched fixed viewBox', () => {
    expect(src).not.toMatch(/viewBox=/) // the attribute, not the word (comments explain the old bug)
  })

  it('disables the tooltip position tween (no scrollbar flash at the chart edges)', () => {
    // Recharts' default tooltip carries `transition: transform 400ms`, so the
    // box SLIDES between active points. Near the right edge that slide passes
    // through an out-of-bounds spot; since the dashboard box is
    // `overflow-x-auto` the browser flashes a horizontal scrollbar for the
    // tween. `isAnimationActive={false}` makes the tooltip jump straight to its
    // clamped in-viewBox position, so it stays fully visible and never overflows.
    const tooltip = /<Tooltip[\s\S]*?\/>/.exec(src)?.[0]
    expect(tooltip, 'the <Tooltip/> element should exist').toBeTruthy()
    expect(tooltip).toMatch(/isAnimationActive=\{false\}/)
  })
})
