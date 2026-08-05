import { describe, expect, it } from "vitest";

import {
  assignableLoops,
  loopRefOf,
  missingLoopRecord,
  prodLoopRecord,
  type LoopIndex,
} from "./loopRefs.js";
import type { Loop } from "../db/schema.js";

/**
 * The pure half of the loop reference: how a production row becomes ONE
 * reference, and the two answers a lookup can give. The database half is driven
 * end to end by `views.integration.test.ts`; what is worth pinning without a
 * database is the MAPPING, because every one of these decisions is a ruling
 * rather than a translation.
 */

const prodLoop = (over: Partial<Loop> = {}): Loop => ({
  id: "loop-mqkxn6lq-4c81d1b2", userId: "u", teamId: "team-a", channelId: null, machineId: "m-1",
  name: "React Doctor", cron: "0 6 * * *", timezone: "Asia/Shanghai", workdir: null, taskFile: null,
  taskFileContent: null, taskFileSyncedAt: null, workflow: null, ui: null, stateSchema: null,
  notify: "auto", allowControl: true, goal: null, completedAt: null, completionReason: null,
  model: null, agent: "claude-code", enabled: true, nextRunAt: null, state: null,
  evolvedRunCount: null, evolveDue: null, editRequest: null,
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", ...over,
} as Loop);

describe("one reference, one roster", () => {
  it("reads a production loop's name as its title and its enablement as its status", () => {
    expect(prodLoopRecord(prodLoop())).toEqual({
      id: "loop-mqkxn6lq-4c81d1b2", title: "React Doctor", source: "prod", status: "active",
      cron: "0 6 * * *", assignable: true,
    });
    // ENABLED OR NOT: a disabled loop still resolves, still renders, and is
    // still a legal hand-off target — it acts the next time it runs. The
    // `enabled` gate belongs to the due scan, not to reading.
    expect(prodLoopRecord(prodLoop({ enabled: false }))).toMatchObject({ status: "paused", assignable: true });
    // A COMPLETED closed loop has declared its goal met: re-enabling reopens it,
    // so nothing is frozen, but it is not a hand-off target either.
    expect(prodLoopRecord(prodLoop({ enabled: false, goal: "ship", completedAt: "2026-08-02T00:00:00.000Z" })))
      .toMatchObject({ status: "completed", assignable: false });
  });

  /** A converged loop kept its short kernel id VERBATIM, so both id shapes are
   *  ordinary opaque `loop-` text here — there is no alias table and no branch. */
  it("uses a converged loop's short id as-is", () => {
    expect(prodLoopRecord(prodLoop({ id: "loop-605e39", name: "Housekeeper" })))
      .toMatchObject({ id: "loop-605e39", title: "Housekeeper", source: "prod", assignable: true });
  });
});

describe("resolving a reference", () => {
  const index: LoopIndex = new Map([
    ["loop-605e39", prodLoopRecord(prodLoop({ id: "loop-605e39", name: "Housekeeper", cron: "0 7 * * *" }))],
    ["loop-mqkxn6lq-4c81d1b2", prodLoopRecord(prodLoop())],
  ]);

  it("returns null only for an ABSENT id — never for an unresolvable one", () => {
    expect(loopRefOf(null, index)).toBe(null);
    expect(loopRefOf(undefined, index)).toBe(null);
    expect(loopRefOf("loop-605e39", index)).toEqual({ id: "loop-605e39", title: "Housekeeper", source: "prod" });
    expect(loopRefOf("loop-mqkxn6lq-4c81d1b2", index)).toEqual({ id: "loop-mqkxn6lq-4c81d1b2", title: "React Doctor", source: "prod" });
  });

  /**
   * THE TOMBSTONE. A production loop can be hard-deleted while tasks still name
   * it: there is no foreign key, nothing cascades, and the ruling is
   * warn-never-block. Resolving that to `null` would render as "no watcher" — a
   * state the watcher rule abolished — so it resolves to a fact instead.
   */
  it("resolves a deleted loop to a tombstone, not to null", () => {
    expect(loopRefOf("loop-gone", index)).toEqual({ id: "loop-gone", title: null, source: "missing" });
    expect(missingLoopRecord("loop-gone").assignable).toBe(false);
  });
});

describe("the hand-off roster", () => {
  it("drops what can never act again, and orders by the label read", () => {
    const index: LoopIndex = new Map([
      ["loop-z", prodLoopRecord(prodLoop({ id: "loop-z", name: "Zeta" }))],
      ["loop-prod", prodLoopRecord(prodLoop({ id: "loop-prod", name: "Alpha" }))],
      ["loop-done", prodLoopRecord(prodLoop({ id: "loop-done", name: "Finished", goal: "g", completedAt: "2026-08-02T00:00:00.000Z" }))],
      ["loop-nameless", prodLoopRecord(prodLoop({ id: "loop-nameless", name: null }))],
    ]);
    expect(assignableLoops(index)).toEqual([
      { id: "loop-prod", title: "Alpha" },
      { id: "loop-nameless", title: null },
      { id: "loop-z", title: "Zeta" },
    ]);
  });
});
