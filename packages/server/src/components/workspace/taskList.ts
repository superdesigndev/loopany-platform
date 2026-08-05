import type { BoardColumn, TaskCard, TaskRef } from './api'
import { loopLabel } from './loopLabel'

/**
 * THE TASKS LIST — grouping, and the view the screen remembers. Pure, so both
 * rules are testable without a DOM.
 *
 * Captain direction (2026-08-04): the DEFAULT Tasks view is a row list, one task
 * per line, GROUPED BY LOOP; the kanban board becomes an alternate view behind a
 * toggle, and the choice is remembered.
 *
 * **Why by loop, when the board groups by state.** The board answers "what is
 * true about this task"; the list answers "whose work is this". A loop is the
 * product's unit of ownership — it is the actor that will act next — so a person
 * scanning the list reads it as a set of desks. The two state facts that change
 * what a person would DO (a question waiting, a follow-up date that has arrived)
 * do not become groups; they stay as badges on the row, exactly as they are on a
 * card. Turning them into groups again would be the board, spelled differently.
 *
 * Two group KINDS, and every task lands in exactly one by construction:
 *
 *   1. `loop` — open, one group per watching loop, ordered by title. EVERY open
 *      task is in one of these, because every task names a watcher
 *      (`kernel/types.ts` WATCHER_HINT).
 *   2. `closed` — closed, whatever it was watched by. LAST, because it is a
 *      record rather than work; a closed task's watcher is history.
 *
 * There USED to be a third, `unclaimed`, pinned first as the §6 safety floor.
 * It is gone rather than empty: the watcher rule removed the state it grouped,
 * so it could only ever render as a heading with nothing under it — and a
 * permanently-empty "nobody picked this up" section teaches that unowned work is
 * still a thing the system can produce. It cannot.
 *
 * Closedness is read FIRST, so a closed task never appears under the loop that
 * used to watch it — that would double-count a desk with work that is done.
 * `groupTasks` is total and disjoint, and `taskList.test.ts` asserts both over
 * the whole fact table, for the same reason the board's mapping is: a layout that
 * drops a task hides work.
 */

export type TaskGroupKind = 'loop' | 'closed'

export interface TaskGroup {
  /** Stable within one render: `closed`, or the watching loop's own id. */
  key: string
  kind: TaskGroupKind
  label: string
  /** The one sentence the section header carries, like a board column's rule. */
  note: string
  tasks: TaskCard[]
}

const CLOSED_NOTE = 'Closed is one-way — these are the record, not the worklist.'
const loopNote = (count: number) => `Open work this loop is watching · ${count} task${count === 1 ? '' : 's'}`

/**
 * The board's columns, flattened back to the tasks themselves.
 *
 * The list and the board render the SAME payload — `/api/views/tasks` is the one
 * endpoint for this screen (the BFF rule), and adding a second shape for the
 * list would be exactly the drift that rule forbids. Order inside a group is the
 * server's order, which is already the useful one (open by newest, closed by most
 * recently closed).
 */
export function flattenColumns(columns: BoardColumn[]): TaskCard[] {
  return columns.flatMap((column) => column.tasks)
}

export function groupTasks(tasks: TaskCard[]): TaskGroup[] {
  const closed: TaskCard[] = []
  const byLoop = new Map<string, { label: string; tasks: TaskCard[] }>()

  for (const task of tasks) {
    if (task.status === 'closed') {
      closed.push(task)
      continue
    }
    // Defensive, not a branch the kernel can produce: an open task always names
    // a watcher. Grouping under the id keeps a row VISIBLE if one ever arrived
    // without one — dropping it silently is the one thing this function must
    // never do, and the totality test is what says so.
    const watcher = task.watcher ?? task.id
    const existing = byLoop.get(watcher)
    if (existing) existing.tasks.push(task)
    // The card carries the loop's resolved reference already — `loopLabel` is
    // the one place that turns it into words, so a group HEADING says the same
    // thing the row does, including the tombstone for a loop deleted out from
    // under a task that still watches it.
    else byLoop.set(watcher, { label: loopLabel(task.watcherLoop, watcher), tasks: [task] })
  }

  const groups: TaskGroup[] = []
  for (const [id, entry] of [...byLoop.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label) || a[0].localeCompare(b[0]))) {
    groups.push({ key: id, kind: 'loop', label: entry.label, note: loopNote(entry.tasks.length), tasks: entry.tasks })
  }
  if (closed.length) groups.push({ key: 'closed', kind: 'closed', label: 'Closed', note: CLOSED_NOTE, tasks: closed })
  return groups
}

// ---- the tree, inside a group ----

/**
 * THE TREE — parent/child indentation WITHIN one group (convergence S4).
 *
 * Hierarchy is ORTHOGONAL to the watcher (design §3): every task keeps its own
 * watcher, its own follow-up and its own end, and there is NO ROLL-UP in either
 * direction. So the grouping does not change — a child whose watcher differs
 * stays in ITS watcher's group and is never re-parented visually. Inside a
 * group, a child whose parent is there too indents under it; a child whose
 * parent is elsewhere renders at the root of its own group and says where it
 * belongs with a chip (`detached`).
 *
 * READ-SIDE TOLERANCE IS DEFENCE IN DEPTH, ported from `feat/task-tree-v2`'s
 * `taskTree.ts` (the prior art the design studied). The kernel's write-time
 * cycle guard means hostile data should be impossible — but a reader must never
 * hang on it and must never silently drop a row, because a layout that loses a
 * task hides work. Hence: a self-parent is a root, an unknown parent is a root,
 * and EVERY member of a cycle is a root (the ancestor walk carries a visited
 * set and is depth-bounded), so nothing can disappear into one.
 */
export interface TaskTreeRow {
  task: TaskCard
  /** 0 for a root; the render clamps how far it indents, the number is true. */
  depth: number
  /** It names a parent, but that parent is not an ancestor row in this group —
   *  so the relationship is carried by a chip instead of by the indent. */
  detached: boolean
}

/** How far the ROOT CLASSIFICATION walk climbs before it gives up and calls the
 *  task a root. A bound is needed because the walk runs over data a reader must
 *  not trust; it is deliberately NOT a bound on emission — see `walk`. */
export const TREE_MAX_DEPTH = 24

export function treeRows(tasks: TaskCard[]): TaskTreeRow[] {
  const index = new Map(tasks.map((task) => [task.id, task]))
  // A parent EDGE inside this group. A self-parent has no edge — it is the
  // shortest cycle there is, and treating it as one costs a walk.
  const parentOf = (task: TaskCard): TaskCard | undefined =>
    task.parentId && task.parentId !== task.id ? index.get(task.parentId) : undefined

  const isRoot = (task: TaskCard): boolean => {
    let cursor = parentOf(task)
    if (!cursor) return true
    const seen = new Set([task.id])
    for (let hop = 0; hop <= TREE_MAX_DEPTH; hop++) {
      if (seen.has(cursor.id)) return true // a cycle: surface it rather than lose it
      seen.add(cursor.id)
      const next = parentOf(cursor)
      if (!next) return false
      cursor = next
    }
    return true
  }

  const roots: TaskCard[] = []
  const children = new Map<string, TaskCard[]>()
  for (const task of tasks) {
    if (isRoot(task)) {
      roots.push(task)
      continue
    }
    // Only a NON-root is filed as somebody's child, which is what keeps a task
    // from being emitted twice (once as a rescued cycle root, once under the
    // parent it also names).
    const siblings = children.get(task.parentId!)
    if (siblings) siblings.push(task)
    else children.set(task.parentId!, [task])
  }

  const rows: TaskTreeRow[] = []
  const emitted = new Set<string>()
  // TOTALITY BEATS THE BOUND. The descent used to stop at `depth >
  // TREE_MAX_DEPTH`, which silently DROPPED the row at exactly that depth: it
  // had classified as a non-root (so it was filed as somebody's child, never a
  // rescued root) and then refused to emit — a task that vanished from the list,
  // which is the one thing this module's header forbids. The bound belongs to
  // `isRoot`'s walk over untrusted data, not here: `children` is a forest by
  // construction (only a task whose chain reached a parentless root INSIDE the
  // bound is filed as a child), and `emitted` terminates the descent regardless.
  // The depth NUMBER stays true; the render clamps how far it indents.
  const walk = (task: TaskCard, depth: number, detached: boolean) => {
    if (emitted.has(task.id)) return
    emitted.add(task.id)
    rows.push({ task, depth, detached })
    for (const child of children.get(task.id) ?? []) walk(child, depth + 1, false)
  }
  // A rescued root still NAMES a parent, so it keeps the chip: the fact survives
  // even when the indent cannot express it.
  for (const root of roots) walk(root, 0, Boolean(root.parentId))
  return rows
}

/**
 * The parent a card should NAME, resolved title-first.
 *
 * The server resolves the reference (`views.ts` `taskRefOf`), so the title is
 * normally there; this only decides what to do when it is not. An id alone is
 * still a true reference — printing nothing because the title is missing would
 * hide the relationship rather than degrade it.
 */
export function parentRef(task: Pick<TaskCard, 'parent' | 'parentId'>): TaskRef {
  if (task.parent) return task.parent
  return task.parentId ? { id: task.parentId, title: null, status: null } : null
}

// ---- the remembered view ----

export type TasksViewMode = 'list' | 'board'

/** The list is the DEFAULT — a first visit, or any unreadable stored value. */
export const DEFAULT_TASKS_VIEW: TasksViewMode = 'list'

export const TASKS_VIEW_STORAGE_KEY = 'loopany-workspace-tasks-view-v1'

/**
 * Persisted like the System canvas's manual pins (`systemLayout.ts`): a local
 * preference about how to LOOK at the workspace, kept on the device rather than
 * on the server, since it is neither a kernel fact nor shared with a teammate.
 * Storage is passed in (never reached for) so this stays pure and SSR-safe.
 */
export function readTasksView(storage: Pick<Storage, 'getItem'> | undefined): TasksViewMode {
  try {
    const value = storage?.getItem(TASKS_VIEW_STORAGE_KEY)
    return value === 'board' || value === 'list' ? value : DEFAULT_TASKS_VIEW
  } catch {
    return DEFAULT_TASKS_VIEW
  }
}

export function writeTasksView(storage: Pick<Storage, 'setItem'> | undefined, mode: TasksViewMode): void {
  try {
    storage?.setItem(TASKS_VIEW_STORAGE_KEY, mode)
  } catch {
    // A browser with storage denied still gets the toggle — it just forgets.
  }
}
