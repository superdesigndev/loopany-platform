/**
 * @loopany/kernel — the pure-function rulebook. Zero I/O: it runs wherever
 * the authority lives (the local driver in-process, or the loopany server),
 * which is what makes the two backends unable to drift.
 *
 * The public surface is pinned by test/surface.test.ts — an export cannot
 * appear or vanish unnoticed.
 */
export * from "./types.js";
export { decide, EDITABLE_TASK_FIELDS, isPersonAssignee, isDispatchable, activeRun } from "./decide.js";
export { tick, type TickResult } from "./tick.js";
export {
  applyChangeset,
  applyToWorld,
  emptyWorld,
  type World,
  type ApplyResult,
  type ApplyConflict,
  type WorldResult,
} from "./apply.js";
// NB foldChangeset/foldToWorld are the UNCONDITIONAL folds — internal + test use
// only. They are deliberately NOT re-exported from the package root: a later
// driver reaching for the public fold could bypass every CAS/active-run check
// and undermine §9's single transactional boundary. tick.ts imports foldChangeset
// directly from ./apply.js; tests do the same.
export {
  treeView,
  inboxView,
  boardView,
  loopsView,
  sortTasksForList,
  type TreeNode,
  type InboxItem,
  type LoopRow,
} from "./views.js";
export { timelineView, type TimelineItem, type TimelineKind, type TimelineOptions } from "./timeline.js";
export {
  slugify,
  shortHash,
  cronTriggerId,
  onceTriggerId,
  runId,
  eventId,
  mirrorId,
} from "./ids.js";
