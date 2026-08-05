import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE ROW GRID, and the two ways a refactor silently un-aligns this surface.
 *
 * Captain direction (2026-08-05) was that the icon, the title block, the pill,
 * the age and the `open ›` must sit on ONE grid across every row and every
 * group. Two things had broken that, and neither is visible in a jsdom render —
 * only in a browser, at a width nobody happened to screenshot:
 *
 *  1. **A row that does not stretch.** `ArtifactRow` is a `<button>`, and a
 *     button in a column flex container is shrink-to-fit rather than stretched.
 *     Every row was therefore as wide as its own content: the separators ended
 *     at a different x on each line, and the trailing cells drifted with the
 *     title length. `width: 100%` is the fix and has to stay.
 *  2. **A second row template.** The grid is per-element, so tracks only line up
 *     across rows if every row is laid out from the SAME declaration. That
 *     declaration is `--ws-row-grid`; the responsive variants re-declare the
 *     VARIABLE, never `.artifact-row`'s `grid-template-columns`.
 *
 * NB the path stays in a VARIABLE — Vite statically rewrites the literal
 * `new URL('./x', import.meta.url)` form into an asset URL.
 */
const sheet = () => readFileSync(fileURLToPath(new URL('../../styles/workspace.css', import.meta.url)), 'utf8')

/** Declarations only, so the prose above a rule never satisfies a rule about it. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '')

describe('every list row is laid out from one grid', () => {
  it('declares the tracks once, as --ws-row-grid', () => {
    const css = stripComments(sheet())
    expect(css).toMatch(/--ws-row-grid:/)
    // `.artifact-row` reads the variable and never spells tracks out itself.
    const rule = css.match(/\.artifact-row \{[^}]*\}/)![0]
    expect(rule).toContain('grid-template-columns: var(--ws-row-grid)')
  })

  it('stretches the row to its container, so separators cannot go ragged', () => {
    const rule = stripComments(sheet()).match(/\.artifact-row \{[^}]*\}/)![0]
    expect(rule).toContain('width: 100%')
  })

  it('re-declares the VARIABLE at every breakpoint, never a second template', () => {
    const css = stripComments(sheet())
    const templates = [...css.matchAll(/\.artifact-row[^{]*\{[^}]*grid-template-columns:([^;}]*)/g)].map((match) => match[1]!.trim())
    expect(templates).toEqual(['var(--ws-row-grid)'])
    // Two narrower grammars exist, and both arrive as a variable override.
    expect([...css.matchAll(/--ws-row-grid:/g)]).toHaveLength(3)
  })
})

/**
 * THE MEASURE. Tasks was a full-bleed pane while every other screen sat in a
 * column, which is what left an acre of empty paper to the right of its rows.
 * The constraint belongs to the LIST CONTENT rather than the pane, because the
 * kanban on that same screen genuinely wants the whole width — so the fix has to
 * be one both can be expressed in.
 */
describe('the workspace holds its list content in one measured column', () => {
  const css = () => stripComments(sheet())

  it('states the measure once, as a max width plus a gutter', () => {
    expect(css()).toMatch(/--ws-column: 940px/)
    expect(css()).toMatch(/--ws-gutter:/)
  })

  it('constrains the document screens with it', () => {
    const rule = css().match(/\.document-view \{[^}]*\}/)![0]
    expect(rule).toContain('min(var(--ws-column), calc(100% - 2 * var(--ws-gutter)))')
  })

  it('constrains the Tasks LIST with it while the board keeps the pane', () => {
    const constrained = css().match(/\.board-view > \.view-header[^{]*\{[^}]*\}/)![0]
    expect(constrained).toContain('min(var(--ws-column), 100%)')
    expect(constrained).toContain('.tasks-list')
    // The board is not in that list, so it still spans the padded pane.
    expect(constrained).not.toContain('.board ')
  })

  it('re-declares both values at every breakpoint rather than forking a width', () => {
    expect([...css().matchAll(/--ws-column:/g)]).toHaveLength(3)
    expect([...css().matchAll(/--ws-gutter:/g)]).toHaveLength(3)
  })
})

describe('the page header separates with space, not a rule', () => {
  it('draws no hairline under the view header', () => {
    const rule = stripComments(sheet()).match(/\.view-header \{[^}]*\}/)![0]
    expect(rule).not.toMatch(/border-bottom/)
  })

  it('has no standalone counter strip left to stack a second pair of rules', () => {
    expect(stripComments(sheet())).not.toMatch(/\.count-strip/)
  })
})
