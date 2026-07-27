import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the Tasks-page width discipline (repo hard rule: no
 * page-level horizontal scroll).
 *
 * The worknode-style tree row is a flex line of fixed chips + a truncating
 * title, indented by depth. Deep indentation + long titles + chips must NARROW
 * the title (min-w-0 + truncate), never widen the pane; chips/squares stay
 * fixed (shrink-0). The split panes themselves must be min-w-0 grid children
 * that scroll vertically inside their own box.
 */
const tree = readFileSync(fileURLToPath(new URL('./TaskTree.tsx', import.meta.url)), 'utf8')
const page = readFileSync(fileURLToPath(new URL('../routes/tasks.tsx', import.meta.url)), 'utf8')

describe('TaskTree width containment', () => {
  it('rows can shrink (min-w-0) and the title truncates instead of widening', () => {
    expect(tree).toMatch(/flex min-w-0 items-center gap-2 border/)
    expect(tree).toMatch(/flex min-w-0 flex-1 cursor-pointer/)
    expect(tree).toMatch(/min-w-0 truncate \$\{/)
  })

  it('status squares and chips are fixed-width (shrink-0)', () => {
    expect(tree).toMatch(/inline-block h-\[10px\] w-\[10px\] shrink-0/)
    expect(tree).toMatch(/inline-block shrink-0 border border-wire/)
  })

  it('the split panes are min-w-0 grid children scrolling inside their own box', () => {
    expect(page).toMatch(/grid min-h-0 min-w-0 flex-1/)
    expect(page).toMatch(/grid-cols-\[minmax/)
    expect(page).toMatch(/min-w-0 overflow-y-auto/)
  })
})
