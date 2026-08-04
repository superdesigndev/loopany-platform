/**
 * THE TASK BOARD'S COLUMNS — derived from the kernel lifecycle, never invented.
 *
 * The kernel gives a task exactly TWO states, `open` and `closed` (types.ts
 * `TASK_STATUSES`), and three facets that decide what is actually true about an
 * open one: a pending question, a watcher, and a follow-up date. A board column
 * is therefore not a new state — it is a NAME for one cell of that fact table,
 * and `columnFor` is the total function that assigns it.
 *
 * Two properties are load-bearing and both are unit-tested:
 *
 *  1. **Every task lands in exactly one column.** The rules are evaluated in
 *     order and the last one is unconditional, so the mapping is total and
 *     disjoint by construction — a card can never be duplicated or lost.
 *  2. **A column is one explainable sentence.** `rule` is that sentence, it
 *     ships in the view payload, and the board renders it under the column
 *     heading. If a column ever needs two sentences it is really two columns.
 *
 * The four columns are the four filters the list screen used to offer
 * (Questions / Due / Open / Closed), turned from a chooser into a layout: the
 * same predicates, all visible at once.
 *
 * THERE USED TO BE A FIFTH, `unclaimed`, and it is gone rather than empty: the
 * watcher rule (`types.ts` WATCHER_HINT) removed the state it named, so its
 * predicate (`!watcher`) can no longer match a row. A permanently-empty column
 * is worse than no column — it teaches a distinction the kernel stopped making,
 * and it invites someone to "fix" the emptiness by reintroducing the state.
 */

export const BOARD_COLUMN_KEYS = ["waiting", "due", "watched", "closed"] as const;
export type BoardColumnKey = (typeof BOARD_COLUMN_KEYS)[number];

export interface BoardColumnSpec {
  key: BoardColumnKey;
  label: string;
  /** The one sentence that explains why a card is in this column. */
  rule: string;
}

export const BOARD_COLUMNS: readonly BoardColumnSpec[] = [
  {
    key: "waiting",
    label: "Waiting on you",
    rule: "Open with a question pending — nothing but a human answer moves it.",
  },
  {
    key: "due",
    label: "Due",
    rule: "Open and its follow-up date has arrived — the watching loop has been woken for it.",
  },
  {
    key: "watched",
    label: "Watched",
    rule: "Open with nothing due — its loop will be woken when the follow-up arrives.",
  },
  {
    key: "closed",
    label: "Closed",
    rule: "Closed — the terminal state; the kernel has no transition back to open.",
  },
] as const;

/** The facts a column decision needs. Deliberately the kernel's own field names
 *  so a caller cannot pass a re-derived or prettified value by accident.
 *  `watcher` is no longer among them: it is never empty, so it can no longer
 *  distinguish one column from another. */
export interface BoardTaskFacts {
  status: string;
  pendingQuestion: string | null;
  followUpAt: string | null;
}

/**
 * The column a task belongs to, at `stamp` (an ISO instant — this module never
 * reads a clock, exactly like the rest of the kernel).
 *
 * PRECEDENCE, and why it is this order:
 *   1. `closed` first, because a closed task is a record and none of the open
 *      facets can be acted on any more.
 *   2. `waiting` next, because a pending question BLOCKS every other move —
 *      `close` is refused outright while one is open (applyTransition §OPEN_QUESTION).
 *   3. `due` before `watched`, because the date is what separates "its loop has
 *      been woken for this" from "its loop will be woken later".
 */
export function columnFor(task: BoardTaskFacts, stamp: string): BoardColumnKey {
  if (task.status === "closed") return "closed";
  if (task.pendingQuestion?.trim()) return "waiting";
  if (task.followUpAt && task.followUpAt <= stamp) return "due";
  return "watched";
}
