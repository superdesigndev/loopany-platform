/**
 * Pins the public surface — an export cannot appear or vanish unnoticed
 * (the artifact-format discipline). Adding an export is a deliberate act:
 * update this list in the same PR and say why.
 */
import { describe, expect, it } from "vitest";
import * as kernel from "../src/index.js";

const EXPECTED = [
  "ACTIVE_RUN_STATES",
  "EDITABLE_TASK_FIELDS",
  "LOOPANY_WORKFLOW_FORMAT",
  "MIRROR_KINDS",
  "REFUSAL_CODES",
  "TASK_PRIORITIES",
  "TASK_STATUSES",
  "TASK_TYPES",
  "TERMINAL_STATUSES",
  "WORKFLOW_SOURCE_MAX_BYTES",
  "activeRun",
  "applyChangeset",
  "applyToWorld",
  "boardView",
  // checkInvariants: the executable spec backing the property suite
  // (test/invariants.property.test.ts) — see src/invariants.ts.
  "checkInvariants",
  // cronText: the ONE cron humaniser — moved down from server lib/format.ts
  // (which re-exports it) so CLI list rows and the web UI render identically.
  "cronText",
  "cronTriggerId",
  "decide",
  "emptyChangeset",
  "emptySnapshot",
  "emptyWorld",
  "eventId",
  // foldChangeset / foldToWorld are intentionally NOT public — the
  // unconditional folds are internal + test only (A1). tests import them from
  // ../src/apply.js directly. A driver bypassing CAS via a public fold would
  // undermine §9's single transactional boundary.
  "inboxView",
  "isDispatchable",
  "isPersonAssignee",
  "isTerminal",
  "loopsView",
  "mirrorId",
  "onceTriggerId",
  "projectOperationalContext",
  "refuse",
  "runId",
  "runArtifactsView",
  "shortHash",
  "slugify",
  "sortTasksForList",
  // taskDetailView: artifacts from tracks+refs, children, active/last run.
  "taskDetailView",
  "tick",
  // timelineView: the kernel-team-timeline projection (2026-08-11) - one
  // shared derivation for CLI + server endpoint + future web surfaces.
  "timelineView",
  "treeView",
  // validateWorkflowDefinition: one compile-only validator shared by every
  // loopany-js-v1 write surface; it never executes source.
  "validateWorkflowDefinition",
].sort();

describe("public surface", () => {
  it("exports exactly the pinned names", () => {
    expect(Object.keys(kernel).sort()).toEqual(EXPECTED);
  });
});
