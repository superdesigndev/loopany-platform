import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { BoardColumn, TaskCard } from './api'
import {
  DEFAULT_TASKS_VIEW, TASKS_VIEW_STORAGE_KEY, TREE_MAX_DEPTH, flattenColumns, groupTasks, parentRef, readTasksView, treeRows, writeTasksView,
} from './taskList'

/**
 * The list's two rules: how tasks are grouped, and which view the screen
 * remembers.
 *
 * The grouping is held to the same bar as the board's column mapping — TOTAL and
 * DISJOINT over the whole fact table — for the same reason: a layout that drops a
 * task hides work, and one that shows it twice invents work.
 */

const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 'task-1', title: 'Verify the nightly backup', status: 'open', followUpAt: null, pendingQuestion: null,
  watcher: 'loop-b', watcherLoop: { id: 'loop-b', title: 'Loop loop-b' },
  createdByLoop: 'loop-b', createdAt: '', updatedAt: '', due: false, column: 'watched', ...over,
})

const watched = (id: string, loop: string, title: string | null = `Loop ${loop}`): TaskCard =>
  card({ id, watcher: loop, watcherLoop: { id: loop, title }, column: 'watched' })

describe('groupTasks — one group per loop, plus the record', () => {
  /**
   * Since convergence S1 a watcher may name a PRODUCTION loop, and its group
   * heading must read as that loop's name rather than as a raw id — the whole
   * value of grouping by loop is that the heading is a desk. A loop deleted out
   * from under a task still watching it reads as a tombstone, for the same
   * reason: the group is real work, so it may never be silently unlabelled.
   */
  it('labels a group from the resolved reference, prod loops and tombstones included', () => {
    const groups = groupTasks([
      card({ id: 't-1', watcher: 'loop-mqkxn6lq-4c81d1b2', watcherLoop: { id: 'loop-mqkxn6lq-4c81d1b2', title: 'React Doctor', source: 'prod' } }),
      card({ id: 't-2', watcher: 'loop-gone', watcherLoop: { id: 'loop-gone', title: null, source: 'missing' } }),
    ])
    expect(groups.map((group) => [group.key, group.label])).toEqual([
      ['loop-gone', 'deleted loop loop-gone'],
      ['loop-mqkxn6lq-4c81d1b2', 'React Doctor'],
    ])
  })


  it('puts loops by title first, then closed — and there is no pool group', () => {
    const groups = groupTasks([
      watched('t-1', 'loop-z', 'Zebra watch'),
      card({ id: 't-3', status: 'closed', closedAt: '2026-01-01T00:00:00.000Z', column: 'closed' }),
      watched('t-4', 'loop-a', 'Alpha watch'),
    ])
    expect(groups.map((group) => [group.kind, group.label])).toEqual([
      ['loop', 'Alpha watch'],
      ['loop', 'Zebra watch'],
      ['closed', 'Closed'],
    ])
  })

  /**
   * The pool group is GONE, not empty. Its predicate was `!watcher`, and the
   * watcher rule removed that state — so the guard is that no code path can
   * produce the group even if a row somehow arrived without one: such a task is
   * grouped (visibly, under its own id) rather than piled into a heading that
   * says nobody picked it up.
   */
  it('has no unclaimed group at all, even fed a task with no watcher', () => {
    const groups = groupTasks([card({ id: 't-1', watcher: null, watcherLoop: null })])
    expect(groups.map((group) => group.kind)).toEqual(['loop'])
    expect(groups.map((group) => group.label)).toEqual(['t-1'])
    const source = readFileSync(fileURLToPath(new URL('./taskList.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/'unclaimed'/)
  })

  it('collects every task a loop watches under that loop, in server order', () => {
    const groups = groupTasks([watched('t-1', 'loop-a'), watched('t-2', 'loop-b'), watched('t-3', 'loop-a')])
    const alpha = groups.find((group) => group.key === 'loop-a')!
    expect(alpha.tasks.map((task) => task.id)).toEqual(['t-1', 't-3'])
    expect(groups.find((group) => group.key === 'loop-b')!.tasks.map((task) => task.id)).toEqual(['t-2'])
  })

  // A group carries a LABEL and its tasks, and nothing else. The prose
  // annotation it used to compute ("Open work this loop is watching · N tasks")
  // restated the heading and the count the header already renders, so the count
  // is now read straight off `tasks.length` at the one place it is shown.
  it('carries no prose annotation to render beside the heading', () => {
    const groups = groupTasks([watched('t-1', 'loop-a')])
    expect(Object.keys(groups[0]!).sort()).toEqual(['key', 'kind', 'label', 'tasks'])
  })

  // A closed task's watcher is history: leaving it on the loop's desk would show
  // finished work as if somebody still owed it.
  it('reads closedness FIRST — a closed watched task lands in Closed, not on its loop', () => {
    const groups = groupTasks([card({ id: 't-1', status: 'closed', watcher: 'loop-a', watcherLoop: { id: 'loop-a', title: 'Alpha' }, column: 'closed' })])
    expect(groups.map((group) => group.kind)).toEqual(['closed'])
  })

  it('falls back to the loop id when the watching loop has no title', () => {
    const [group] = groupTasks([watched('t-1', 'loop-a', null)])
    expect(group!.label).toBe('loop-a')
  })

  it('names no empty group', () => {
    expect(groupTasks([watched('t-1', 'loop-a')]).map((group) => group.kind)).toEqual(['loop'])
    expect(groupTasks([])).toEqual([])
  })

  it('is TOTAL and DISJOINT over the fact table — every task in exactly one group', () => {
    const facts: TaskCard[] = []
    let n = 0
    for (const status of ['open', 'closed']) {
      for (const watcher of [null, 'loop-a', 'loop-b']) {
        for (const question of [null, 'revert or wait?']) {
          for (const due of [false, true]) {
            facts.push(card({
              id: `t-${n++}`, status, watcher,
              watcherLoop: watcher ? { id: watcher, title: watcher.toUpperCase() } : null,
              pendingQuestion: question, due, followUpAt: due ? '2026-01-01T00:00:00.000Z' : null,
              column: status === 'closed' ? 'closed' : 'watched',
            }))
          }
        }
      }
    }
    const placed = groupTasks(facts).flatMap((group) => group.tasks.map((task) => task.id))
    expect(placed.length).toBe(facts.length)
    expect(new Set(placed).size).toBe(facts.length)
  })
})

/**
 * THE TREE (convergence S4), held to the same bar as the grouping: TOTAL and
 * DISJOINT. A tree layout has one extra way to lose a task that a flat list does
 * not — a child whose parent is unreachable, or a cycle nothing descends into —
 * so every tolerance case below ends by asserting the row is still ON SCREEN.
 */
describe('treeRows — parent/child indentation inside one group', () => {
  const sub = (id: string, parentId: string | null, over: Partial<TaskCard> = {}): TaskCard =>
    card({ id, parentId, ...(parentId ? { parent: { id: parentId, title: `Title of ${parentId}`, status: 'open' } } : {}), ...over })

  it('indents a child under its parent and keeps the server order among siblings', () => {
    const rows = treeRows([sub('t-parent', null), sub('t-a', 't-parent'), sub('t-b', 't-parent')])
    expect(rows.map((row) => [row.task.id, row.depth])).toEqual([['t-parent', 0], ['t-a', 1], ['t-b', 1]])
    expect(rows.every((row) => !row.detached)).toBe(true)
  })

  it('nests a grandchild under its own parent, not under the root', () => {
    const rows = treeRows([sub('t-1', null), sub('t-2', 't-1'), sub('t-3', 't-2')])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2])
  })

  // A child is filed under its parent even when the payload lists it first: the
  // rows arrive in the server's order, which is not a topological one.
  it('does not depend on a parent arriving before its child', () => {
    const rows = treeRows([sub('t-child', 't-parent'), sub('t-parent', null)])
    expect(rows.map((row) => [row.task.id, row.depth])).toEqual([['t-parent', 0], ['t-child', 1]])
  })

  /**
   * The watcher-orthogonality case, and the reason `detached` exists: a child
   * watched by ANOTHER loop is grouped under ITS watcher (never re-parented
   * visually), so in that group the indent cannot express the relationship and
   * a chip has to.
   */
  it('roots a child whose parent is in another group, and flags it detached', () => {
    const rows = treeRows([sub('t-child', 't-elsewhere')])
    expect(rows.map((row) => [row.task.id, row.depth, row.detached])).toEqual([['t-child', 0, true]])
  })

  it('treats a self-parent as a root rather than descending into it', () => {
    const rows = treeRows([sub('t-self', 't-self')])
    expect(rows.map((row) => [row.task.id, row.depth])).toEqual([['t-self', 0]])
  })

  /**
   * The kernel's write guard makes a cycle unreachable, and the reader still
   * must not hang on one (defence in depth, ported from `feat/task-tree-v2`).
   * EVERY member surfaces as a root: losing one would hide work, and the whole
   * point of the tolerance is that hostile data degrades to a flat list.
   */
  it('surfaces every member of a cycle, exactly once, instead of hanging', () => {
    const rows = treeRows([sub('t-a', 't-b'), sub('t-b', 't-a'), sub('t-c', 't-b')])
    expect(rows.map((row) => row.task.id).sort()).toEqual(['t-a', 't-b', 't-c'])
    expect(rows.every((row) => row.depth === 0)).toBe(true)
  })

  it('is TOTAL and DISJOINT over trees, orphans, cycles and roots together', () => {
    const tasks = [
      sub('t-root', null), sub('t-kid', 't-root'), sub('t-grandkid', 't-kid'),
      sub('t-orphan', 't-missing'), sub('t-self', 't-self'),
      sub('t-cycle-a', 't-cycle-b'), sub('t-cycle-b', 't-cycle-a'),
    ]
    const rows = treeRows(tasks)
    expect(rows.length).toBe(tasks.length)
    expect(new Set(rows.map((row) => row.task.id)).size).toBe(tasks.length)
  })

  /**
   * A CHAIN DEEPER THAN THE BOUND IS STILL TOTAL — the regression the shipped
   * bound test could not see, because `not.toThrow()` is satisfied by a function
   * that quietly returns fewer rows than it was given.
   *
   * The kernel's write guard allows 64 hops, so a 26+-deep chain is reachable
   * through legal writes. `isRoot` classified the task at exactly
   * `TREE_MAX_DEPTH + 1` as a NON-root (filing it as its parent's child) while
   * the descent refused to emit at that depth — so it was in neither `roots` nor
   * any emitted subtree and disappeared from the list. A layout that loses a
   * task hides work.
   */
  it('bounds the classification walk WITHOUT losing a row from a deeper chain', () => {
    expect(TREE_MAX_DEPTH).toBeGreaterThan(12)
    const chain = Array.from({ length: 40 }, (_, i) => sub(`t-${i}`, i === 0 ? null : `t-${i - 1}`))
    const rows = treeRows(chain)
    expect(() => treeRows(chain)).not.toThrow()
    // TOTAL: every task, exactly once — including `t-25`, the one that used to
    // vanish, and every task below it.
    expect(rows).toHaveLength(chain.length)
    expect(new Set(rows.map((row) => row.task.id)).size).toBe(chain.length)
    expect(rows.map((row) => row.task.id)).toContain('t-25')
    for (const task of chain) expect(rows.some((row) => row.task.id === task.id), task.id).toBe(true)
  })

  it('reads an empty list as an empty tree', () => {
    expect(treeRows([])).toEqual([])
  })
})

describe('parentRef — what a chip names', () => {
  it('prefers the server-resolved reference, title included', () => {
    expect(parentRef({ parent: { id: 't-1', title: 'The epic', status: 'open' }, parentId: 't-1' })).toEqual({ id: 't-1', title: 'The epic', status: 'open' })
  })

  // An id alone is still a TRUE reference: printing nothing because the title
  // never arrived would hide the relationship rather than degrade it.
  it('falls back to the bare id, and says nothing at all for a root', () => {
    expect(parentRef({ parentId: 't-9' })).toEqual({ id: 't-9', title: null, status: null })
    expect(parentRef({ parentId: null })).toBe(null)
    expect(parentRef({})).toBe(null)
  })
})

describe('flattenColumns — the list and the board read ONE payload', () => {
  it('returns every card the board columns hold', () => {
    const columns: BoardColumn[] = [
      { key: 'waiting', label: 'Waiting', rule: '', tasks: [card({ id: 't-1', column: 'waiting' })] },
      { key: 'closed', label: 'Closed', rule: '', tasks: [card({ id: 't-2', status: 'closed', column: 'closed' })] },
      { key: 'due', label: 'Due', rule: '', tasks: [] },
    ]
    expect(flattenColumns(columns).map((task) => task.id)).toEqual(['t-1', 't-2'])
  })
})

describe('the remembered view', () => {
  const store = (value?: string) => {
    let held = value
    return {
      getItem: () => held ?? null,
      setItem: (_key: string, next: string) => { held = next },
      read: () => held,
    }
  }

  it('defaults to the list — a first visit, and the captain-directed default', () => {
    expect(DEFAULT_TASKS_VIEW).toBe('list')
    expect(readTasksView(store())).toBe('list')
    expect(readTasksView(undefined)).toBe('list')
  })

  it('round-trips the choice through storage', () => {
    const storage = store()
    writeTasksView(storage, 'board')
    expect(storage.read()).toBe('board')
    expect(readTasksView(storage)).toBe('board')
    writeTasksView(storage, 'list')
    expect(readTasksView(storage)).toBe('list')
  })

  it('keys off one stable name, and ignores a value it does not recognise', () => {
    expect(TASKS_VIEW_STORAGE_KEY).toBe('loopany-workspace-tasks-view-v1')
    expect(readTasksView(store('kanban'))).toBe('list')
  })

  // Storage can be denied outright (private modes, embedded frames). The toggle
  // still works there — it just forgets.
  it('survives a storage that throws', () => {
    const denied = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readTasksView(denied)).toBe('list')
    expect(() => writeTasksView(denied, 'board')).not.toThrow()
  })
})
