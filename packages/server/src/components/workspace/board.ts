import type { TaskCard } from './api'

/**
 * WHICH ACTIONS A TASK OFFERS — pure, so the rule is testable without a DOM.
 *
 * Both Tasks views are READ LAYOUTS. There is no drag-and-drop: a column (or a
 * loop section) is a rendering of a fact, not a control, and moving a card by
 * dropping it was never how a task changes — it changes because a person tells
 * the loop that watches it what to do. A drop also carries no note, no loop id
 * and no date, so every interesting move needed a form anyway.
 *
 * Captain direction (2026-08-04) moved the buttons OFF the row and the card and
 * into the task DRAWER — this module is unchanged by that, because it always
 * answered "which acts does this task offer", never "where do they render". A row
 * is now a pure entrance; `TasksPane`'s `TaskActions` is the one consumer.
 *
 *   - **tell** — say something to the loop that watches this task. When a
 *     question is pending it ANSWERS (`POST /api/tasks/:id/verdict`); otherwise
 *     it leaves a DIRECTIVE (`POST /api/tasks/:id/directive`). Both queue one
 *     run for the watcher with the task in scope, so it is ONE affordance in two
 *     modes rather than two controls a person has to choose between.
 *
 * **THAT IS THE WHOLE LIST, and it is a list of one** (captain ruling
 * 2026-08-05). The drawer used to carry a second control — a picker that handed
 * the task to a different loop — and it is gone, along with the `watcher` PATCH
 * behind it, because nobody could name the scenario that needed it. A task's
 * watcher is now decided once, when the task is created, and kept: the kernel
 * refuses a rewrite with `WATCHER_IMMUTABLE` and teaches close-and-re-file in its
 * place, so removing the button removed the capability rather than hiding it.
 *
 * **CLOSE IS NOT HERE, and its absence is a rule** (captain direction
 * 2026-08-04). The expected end of a task is that its WATCHER closes it — from
 * its own workflow logic, or in response to a directive left here. A human
 * closing it from this screen settles the kernel's record while the external
 * world it describes carries on unchanged: the PR still open, the branch still
 * there, and the loop that would have cleaned them up now looking at a closed
 * task it will never act on again. `loopany task close` remains as the deep
 * emergency hatch for a broken watcher, where the person running it can see
 * that they are taking the reconciliation on themselves.
 *
 * Everything else a board might suggest has no human entrance behind it: there
 * is no reopen (close is one-way), and due-ness follows the follow-up date,
 * which no button here sets.
 *
 * This is an AFFORDANCE layer, never an authority: the kernel re-decides every
 * one of these, and a refusal it returns is rendered verbatim.
 */

export type CardActions = {
  /**
   * Say something to the watching loop. ONE affordance, two modes (`tellMode`).
   * Open tasks only: a closed task is a record, and there is no run to queue for
   * a conversation about one.
   */
  canTell: boolean
}

export function cardActions(card: Pick<TaskCard, 'status' | 'pendingQuestion'>): CardActions {
  return { canTell: card.status !== 'closed' }
}

/**
 * WHICH conversation the composer is in.
 *
 * `answer` when the loop asked and is waiting — the kernel refuses a directive
 * there, because the person already has the floor and an answer is free text, so
 * any instruction fits inside one. `directive` otherwise. It lives here rather
 * than inside the component so the rule is testable without a DOM, for the same
 * reason `cardActions` does.
 */
export type TellMode = 'answer' | 'directive'

export function tellMode(card: Pick<TaskCard, 'pendingQuestion'>): TellMode {
  return card.pendingQuestion?.trim() ? 'answer' : 'directive'
}

/** Does this task offer anything at all? A closed task is a record: it offers
 *  nothing, and its drawer shows no empty action bar. */
export function hasActions(card: Pick<TaskCard, 'status' | 'pendingQuestion'>): boolean {
  return cardActions(card).canTell
}
