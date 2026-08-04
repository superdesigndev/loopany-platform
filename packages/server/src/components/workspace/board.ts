import type { BoardColumnKey, TaskCard } from './api'

/**
 * THE DRAG LEGALITY GUARD — pure, so the rule is testable without a DOM.
 *
 * The board may only offer a drop where a LEGAL HUMAN ENTRANCE already exists in
 * the kernel. There are exactly two such moves on a task, and the board invents
 * neither:
 *
 *   - **close** — the one task transition (`kernel/types.ts` TRANSITIONS), via
 *     `POST /api/tasks/:id/close`. The kernel requires a note, so the board
 *     collects one before it asks; and it refuses outright while a question is
 *     pending, so the board does not offer the drop at all.
 *   - **release** — clearing the `watcher` facet, via `PATCH /api/tasks/:id`
 *     with `{watcher: null}`. Its mirror, **claim**, is the same PATCH with a
 *     loop id — but a column cannot name a loop, so claim is a picker on the
 *     card rather than a drop target.
 *
 * Everything else is refused HERE, with the reason, rather than being fired at
 * the server to see what happens: dragging to `waiting` would mean a human
 * asking themself a question; dragging between `due` and `watched` would mean
 * inventing a follow-up date out of a drop; and dragging anything out of
 * `closed` has no transition at all — `close` is one-way, there is no reopen.
 *
 * This is a UI affordance layer, never an authority: the kernel re-decides every
 * one of these, and a refusal it returns is rendered verbatim.
 */

export type BoardVerb = 'close' | 'release' | 'claim'

export type MoveVerdict =
  | { ok: true; verb: 'close'; needsNote: true }
  | { ok: true; verb: 'release'; needsNote: false }
  | { ok: false; reason: string }

/**
 * May this card be dropped on this column, and if so as what?
 *
 * `to` is the column being dropped on; the card carries the column it is in, so
 * a same-column drop is a no-op rather than a refusal.
 */
export function legalMove(card: Pick<TaskCard, 'column' | 'status' | 'pendingQuestion' | 'watcher'>, to: BoardColumnKey): MoveVerdict {
  if (card.column === to) return { ok: false, reason: 'it is already here' }
  if (card.status === 'closed') {
    return { ok: false, reason: 'a closed task is a record — the kernel has no transition back to open, so file a new task for new work' }
  }
  if (to === 'closed') {
    if (card.pendingQuestion?.trim()) {
      return { ok: false, reason: 'a task with a question waiting cannot be closed — answer it in the inbox first' }
    }
    return { ok: true, verb: 'close', needsNote: true }
  }
  if (to === 'unclaimed') {
    if (!card.watcher) return { ok: false, reason: 'no watcher to release — it is already unclaimed' }
    return { ok: true, verb: 'release', needsNote: false }
  }
  if (to === 'waiting') {
    return { ok: false, reason: 'a question is asked by a run and answered by you — you cannot ask yourself one' }
  }
  // `due` and `watched` both mean "watched"; which one a task is in follows its
  // follow-up date, and a drop carries no date.
  if (!card.watcher) return { ok: false, reason: 'claiming names a loop — use the claim picker on the card' }
  return { ok: false, reason: 'due-ness follows the follow-up date, which a drop cannot set' }
}

/** Can this card be picked up at all? Used for the `draggable` attribute, so a
 *  card with no legal destination never suggests one. */
export function isDraggable(card: Pick<TaskCard, 'column' | 'status' | 'pendingQuestion' | 'watcher'>, columns: readonly BoardColumnKey[]): boolean {
  return columns.some((to) => legalMove(card, to).ok)
}
