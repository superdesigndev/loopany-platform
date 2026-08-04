import type { TaskCard } from './api'

/**
 * WHICH ACTIONS A TASK OFFERS — pure, so the rule is testable without a DOM.
 *
 * Both Tasks views are READ LAYOUTS. There is no drag-and-drop: a column (or a
 * loop section) is a rendering of a fact, not a control, and moving a card by
 * dropping it was never how a task changes — it changes because a person closes
 * it, hands it to a loop, or takes it back. Those are the three entrances the
 * kernel actually has for a human, and each is a button (product decision; a drop
 * also carries no note, no loop id and no date, so every interesting move needed
 * a form anyway).
 *
 * Captain direction (2026-08-04) moved those buttons OFF the row and the card and
 * into the task DRAWER — this module is unchanged by that, because it always
 * answered "which acts does this task offer", never "where do they render". A row
 * is now a pure entrance; `TasksPane`'s `TaskActions` is the one consumer.
 *
 *   - **close** — the one task transition (`kernel/types.ts` TRANSITIONS), via
 *     `POST /api/tasks/:id/close`. The kernel requires a note, so the button
 *     opens a dialog rather than writing; and the kernel refuses a close while a
 *     question is pending, so the button is not offered at all there.
 *   - **claim / release** — the `watcher` facet, via `PATCH /api/tasks/:id` with
 *     a loop id or `null`. Claim names a loop, so it is a picker.
 *
 * Everything else a board might suggest has no human entrance behind it: there
 * is no reopen (close is one-way), a person does not ask themself a question,
 * and due-ness follows the follow-up date, which no button here sets.
 *
 * This is an AFFORDANCE layer, never an authority: the kernel re-decides every
 * one of these, and a refusal it returns is rendered verbatim.
 */

export type CardActions = {
  /** The one transition. Refused by the kernel while a question is pending. */
  canClose: boolean
  /** Hand the task to a loop — a picker, because a loop must be named. */
  canClaim: boolean
  /**
   * Return the task to the unclaimed pool. Offered on a card with a question
   * pending too: it is consequential there (the eventual answer wakes the
   * watcher loop and there would be none), but it is an explicit, labelled act
   * on that one card — not a spatial gesture that could be made by accident.
   */
  canRelease: boolean
}

export function cardActions(card: Pick<TaskCard, 'status' | 'pendingQuestion' | 'watcher'>): CardActions {
  const open = card.status !== 'closed'
  return {
    canClose: open && !card.pendingQuestion?.trim(),
    canClaim: open && !card.watcher,
    canRelease: open && Boolean(card.watcher),
  }
}

/** Does this task offer anything at all? A closed task is a record: it offers
 *  nothing, and its drawer shows no empty action bar. */
export function hasActions(card: Pick<TaskCard, 'status' | 'pendingQuestion' | 'watcher'>): boolean {
  const actions = cardActions(card)
  return actions.canClose || actions.canClaim || actions.canRelease
}
