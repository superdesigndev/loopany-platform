import type { BoardColumn, TaskCard } from './api'
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
