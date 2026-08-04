import { describe, expect, it } from "vitest";

import {
  assignableLoops,
  kernelLoopRecord,
  loopRefOf,
  missingLoopRecord,
  prodLoopRecord,
  type LoopIndex,
} from "./loopRefs.js";
import type { KernelObject } from "../db/kernel-schema.js";
import type { Loop } from "../db/schema.js";

/**
 * The pure half of the S1 dual-read: how each world's row becomes ONE reference,
 * and the three answers a lookup can give. The database half is driven end to end
 * by `views.integration.test.ts`; what is worth pinning without a database is the
 * MAPPING, because every one of these decisions is a ruling rather than a
 * translation.
 */

const kernelLoop = (over: Partial<KernelObject> = {}): KernelObject => ({
  id: "loop-605e39", teamId: "team-a", kind: "loop", status: "active", title: "Housekeeper",
  cron: "0 7 * * *", timezone: null, nextFire: null, workdir: null, followUpAt: null,
  pendingQuestion: null, watcher: null, parentId: null, format: null, mirrorKind: null,
  mirrorCoords: null, attachedTo: null, key: null, payload: null, body: null,
  createdByRun: null, createdByLoop: null, createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z", closedAt: null, ...over,
});

const prodLoop = (over: Partial<Loop> = {}): Loop => ({
  id: "loop-mqkxn6lq-4c81d1b2", userId: "u", teamId: "team-a", channelId: null, machineId: "m-1",
  name: "React Doctor", cron: "0 6 * * *", timezone: "Asia/Shanghai", workdir: null, taskFile: null,
  taskFileContent: null, taskFileSyncedAt: null, workflow: null, ui: null, stateSchema: null,
  notify: "auto", allowControl: true, goal: null, completedAt: null, completionReason: null,
  model: null, agent: "claude-code", enabled: true, nextRunAt: null, state: null,
  evolvedRunCount: null, evolveDue: null, editRequest: null,
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", ...over,
} as Loop);

describe("one reference, two worlds", () => {
  it("carries the kernel loop's own status vocabulary", () => {
    expect(kernelLoopRecord(kernelLoop())).toMatchObject({ source: "kernel", status: "active", assignable: true });
    expect(kernelLoopRecord(kernelLoop({ status: "paused" })).assignable).toBe(true);
    // Retirement is terminal and the charter is frozen — it never acts again.
    expect(kernelLoopRecord(kernelLoop({ status: "retired" })).assignable).toBe(false);
  });

  it("reads a production loop's name as its title and its enablement as its status", () => {
    expect(prodLoopRecord(prodLoop())).toEqual({
      id: "loop-mqkxn6lq-4c81d1b2", title: "React Doctor", source: "prod", status: "active",
      cron: "0 6 * * *", assignable: true,
    });
    // ENABLED OR NOT: a disabled loop still resolves, still renders, and is
    // still a legal hand-off target — it acts the next time it runs. The
    // `enabled` gate belongs to the due scan, not to reading.
    expect(prodLoopRecord(prodLoop({ enabled: false }))).toMatchObject({ status: "paused", assignable: true });
    // A COMPLETED closed loop has declared its goal met. Not `retired` (the
    // charter is not frozen and re-enabling reopens it) and not a target.
    expect(prodLoopRecord(prodLoop({ enabled: false, goal: "ship", completedAt: "2026-08-02T00:00:00.000Z" })))
      .toMatchObject({ status: "completed", assignable: false });
  });
});

describe("resolving a reference", () => {
  const index: LoopIndex = new Map([
    ["loop-605e39", kernelLoopRecord(kernelLoop())],
    ["loop-mqkxn6lq-4c81d1b2", prodLoopRecord(prodLoop())],
  ]);

  it("returns null only for an ABSENT id — never for an unresolvable one", () => {
    expect(loopRefOf(null, index)).toBe(null);
    expect(loopRefOf(undefined, index)).toBe(null);
    expect(loopRefOf("loop-605e39", index)).toEqual({ id: "loop-605e39", title: "Housekeeper", source: "kernel" });
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
  it("spans both worlds, drops what can never act again, and orders by the label read", () => {
    const index: LoopIndex = new Map([
      ["loop-z", kernelLoopRecord(kernelLoop({ id: "loop-z", title: "Zeta" }))],
      ["loop-dead", kernelLoopRecord(kernelLoop({ id: "loop-dead", title: "Retired", status: "retired" }))],
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
