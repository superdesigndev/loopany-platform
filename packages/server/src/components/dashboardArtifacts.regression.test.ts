import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guards for the dashboard artifact primitives, all serving the
 * hard no-page-horizontal-scroll rule and the layout-audit findings from the
 * design mock:
 *
 *  - the calendar grid must use shrinkable tracks (`grid-cols-7` =
 *    repeat(7, minmax(0,1fr))) and `min-w-0` cells so a long chip truncates
 *    inside its cell instead of widening the row (and the page);
 *  - the embed's collapse must clip via a WRAPPER (`overflow-hidden` +
 *    max-height on a parent div), never the text nodes themselves;
 *  - the chart must be container-driven (ResponsiveContainer at a FIXED pixel
 *    height), never a fixed-viewBox svg stretched to the container (the old
 *    renderer scaled like an image: fat strokes, ballooning height).
 */

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

describe('LoopCalendar width containment', () => {
  const src = read('./LoopCalendar.tsx')

  it('uses 7 shrinkable grid tracks with min-w-0 on the grid root', () => {
    const gridRoot = /className="grid[^"]*grid-cols-7[^"]*"/.exec(src)?.[0]
    expect(gridRoot, 'the month grid root should exist').toBeTruthy()
    expect(gridRoot).toMatch(/\bmin-w-0\b/)
  })

  it('keeps day cells shrinkable and chips truncating inside them', () => {
    expect(src).toMatch(/relative min-w-0 border-b/) // day cell
    expect(src).toMatch(/\btruncate\b/) // named chip text
  })
})

describe('LoopEmbed collapse containment', () => {
  const src = read('./LoopEmbed.tsx')

  it('clips via a wrapper (overflow-hidden + maxHeight), not the content', () => {
    expect(src).toMatch(/collapsed \? 'overflow-hidden' : ''/)
    expect(src).toMatch(/maxHeight: COLLAPSE_PX/)
  })

  it('keeps the shell shrinkable', () => {
    expect(src).toMatch(/'min-w-0 overflow-hidden rounded-card/)
  })
})

describe('LoopKanban width containment', () => {
  const src = read('./LoopKanban.tsx')

  it('scrolls the board inside its own pane (min-w-0 + overflow-x-auto on the row)', () => {
    // The board row is the only horizontal-scroll container: a wide board of
    // fixed-width columns must scroll INSIDE the pane, never widen the dashboard
    // box or force a page-level scrollbar (the Timeline strip rule).
    const row = /className=\{`\$\{shell\} flex[^`]*`\}/.exec(src)?.[0]
    expect(row, 'the board row className should exist').toBeTruthy()
    expect(row).toMatch(/overflow-x-auto/)
    expect(src).toMatch(/const shell = 'min-w-0'/)
  })

  it('keeps columns fixed-width and shrink-0, card titles truncating', () => {
    expect(src).toMatch(/w-\[248px\] shrink-0/) // fixed, non-shrinking column track
    expect(src).toMatch(/min-w-0 truncate/) // card title truncates inside the column
  })

  it('caps board height and scrolls tall columns internally', () => {
    // The board is height-capped; a long column scrolls its own card list
    // (min-h-0 + overflow-y-auto) instead of stretching the dashboard box.
    expect(src).toMatch(/max-h-\[420px\]/)
    expect(src).toMatch(/min-h-0 flex-col gap-2 overflow-y-auto/)
    // Cards must OVERFLOW the cap, never flex-compress to fit it (the squeeze
    // bug: without shrink-0 a 12-card column squashes every card instead of
    // scrolling), and overflow below the fold gets an explicit indicator.
    expect(src).toMatch(/min-w-0 shrink-0 overflow-hidden rounded-control/)
    expect(src).toMatch(/↓ scroll/)
  })

  it('reviews a card body in the shared Modal (its own scroll container), never inline', () => {
    // The card body renders in the portal-mounted Modal (overflow-auto, viewport
    // capped) - an inline expansion inside a 248px column can't clip/scroll sanely.
    expect(src).toMatch(/<Modal open onClose/)
    expect(src).not.toMatch(/CollapsibleBody/)
  })
})

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
