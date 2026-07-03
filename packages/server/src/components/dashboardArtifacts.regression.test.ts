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

  it('clips an expanded card body via the shared collapse wrapper', () => {
    expect(src).toMatch(/CollapsibleBody/)
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
