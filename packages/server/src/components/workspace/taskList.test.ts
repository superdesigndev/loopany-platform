import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { BoardColumn, TaskCard } from './api'
import {
  DEFAULT_TASKS_VIEW, TASKS_VIEW_STORAGE_KEY, flattenColumns, groupTasks, readTasksView, writeTasksView,
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
    expect(alpha.note).toMatch(/2 tasks/)
    expect(groups.find((group) => group.key === 'loop-b')!.note).toMatch(/1 task\b/)
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
