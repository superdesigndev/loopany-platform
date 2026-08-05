import { describe, expect, it } from "vitest";

import { deriveGraphEdges, loopHealth, runDisplayState, type GraphTask } from "./views.js";
import type { Run } from "../db/schema.js";

/**
 * The pure halves of the view layer: the system graph's edge derivation and the
 * loop's health-from-runs. Both are the parts a screen would be WRONG about
 * silently, so both are tested against fixtures rather than only through the
 * integration suite.
 */

const task = (over: Partial<GraphTask>): GraphTask => ({
  id: "task-1", createdByLoop: "loop-a", watcher: "loop-a", pendingQuestion: null, ...over,
});

describe("deriveGraphEdges — one branch per spec §8.3 row", () => {
  // The edge is a fact settled AT CREATE (the filing loop named another loop as
  // the watcher). There is no re-pointing afterwards, so an edge can appear and
  // can close, but never move.
  it("a watcher that is not the creator is a hand-off", () => {
    expect(deriveGraphEdges([task({ watcher: "loop-b" })])).toEqual([{ from: "loop-a", to: "loop-b", kind: "hands-off", count: 1 }]);
  });

  it("a task a loop watches for ITSELF is not a flow between nodes", () => {
    expect(deriveGraphEdges([task({ watcher: "loop-a" })])).toEqual([]);
  });

  it("a question routes through you, and back to the watcher", () => {
    expect(deriveGraphEdges([task({ watcher: "loop-a", pendingQuestion: "post as drafted?" })])).toEqual([
      { from: "loop-a", to: "you", kind: "asks", count: 1 },
      { from: "you", to: "loop-a", kind: "answers", count: 1 },
    ]);
  });

  /**
   * THE POOL IS GONE, and with it the two edge kinds that only ever ran through
   * it (`produces`, `adopts`). Under the watcher rule a task always names a
   * watcher, so the `!watcher` branch is unreachable from real data; feeding it
   * anyway must draw NOTHING rather than resurrect a node the graph no longer
   * has, which would render as a dangling edge to a missing node.
   */
  it("draws no pool edge, even fed a watcher-less task", () => {
    expect(deriveGraphEdges([task({ watcher: null })])).toEqual([]);
    const kinds = new Set(deriveGraphEdges([
      task({ id: "t1", watcher: null }),
      task({ id: "t2", watcher: "loop-b" }),
      task({ id: "t3", watcher: "loop-a", pendingQuestion: "which one?" }),
    ]).map((edge) => edge.kind));
    expect(kinds).toEqual(new Set(["hands-off", "asks", "answers"]));
  });

  it("a question with no watcher asks, and nothing answers", () => {
    expect(deriveGraphEdges([task({ watcher: null, pendingQuestion: "which one?" })])).toEqual([
      { from: "loop-a", to: "you", kind: "asks", count: 1 },
    ]);
  });

  it("a human-created task uses the you node as its source", () => {
    expect(deriveGraphEdges([task({ createdByLoop: null, watcher: "loop-b" })])).toEqual([
      { from: "you", to: "loop-b", kind: "hands-off", count: 1 },
    ]);
  });

  it("groups by (from, to, kind) and counts the tasks in the window", () => {
    const edges = deriveGraphEdges([
      task({ id: "t1", watcher: "loop-b" }),
      task({ id: "t2", watcher: "loop-b" }),
      task({ id: "t3", watcher: "loop-c" }),
    ]);
    expect(edges).toEqual([
      { from: "loop-a", to: "loop-b", kind: "hands-off", count: 2 },
      { from: "loop-a", to: "loop-c", kind: "hands-off", count: 1 },
    ]);
  });
});

const NOW = new Date("2026-08-08T12:00:00.000Z");
/** A production run row: `ts` is when it started, `durationMs` how long it took,
 *  `phase` the ONE lifecycle. The rewrite's parallel queue/lease/timestamp
 *  columns retired in convergence S5. */
const run = (over: Partial<Run>): Run => ({
  id: "run-1", loopId: "loop-a", userId: "u", machineId: "m", phase: "done", role: "exec",
  ts: "2026-08-08T07:00:00.000Z", durationMs: 180_000, costUsd: 0.42,
  ...over,
} as Run);

describe("loopHealth — health from runs, never a stored field", () => {
  it("reads the newest run as the last outcome", () => {
    const health = loopHealth([
      run({ id: "old", ts: "2026-08-01T07:00:00.000Z", phase: "error" }),
      run({ id: "new", ts: "2026-08-08T07:00:00.000Z", phase: "done" }),
    ], NOW);
    expect(health.lastOutcome).toBe("success");
    expect(health.lastRunAt).toBe("2026-08-08T07:03:00.000Z");
  });

  it("counts a failure streak newest-first and stops at the first success", () => {
    const health = loopHealth([
      run({ id: "c", ts: "2026-08-08T07:00:00.000Z", phase: "error" }),
      run({ id: "b", ts: "2026-08-07T07:00:00.000Z", phase: "error" }),
      run({ id: "a", ts: "2026-08-06T07:00:00.000Z", phase: "done" }),
      run({ id: "z", ts: "2026-08-05T07:00:00.000Z", phase: "error" }),
    ], NOW);
    expect(health.consecutiveFailures).toBe(2);
  });

  it("is transparent to a queued or running run — neither is an outcome", () => {
    const health = loopHealth([
      run({ id: "live", ts: "2026-08-08T11:00:00.000Z", phase: "running", durationMs: null }),
      run({ id: "bad", ts: "2026-08-08T07:00:00.000Z", phase: "error" }),
    ], NOW);
    expect(health.lastOutcome).toBe("running");
    expect(health.consecutiveFailures).toBe(1);
  });

  it("windows the 7-day tallies and sums cost across them", () => {
    const health = loopHealth([
      run({ id: "in1", ts: "2026-08-08T07:00:00.000Z", phase: "done", costUsd: 1 }),
      run({ id: "in2", ts: "2026-08-05T07:00:00.000Z", phase: "error", costUsd: 0.5 }),
      run({ id: "out", ts: "2026-06-01T07:00:00.000Z", phase: "done", costUsd: 99 }),
    ], NOW);
    expect(health.runs7d).toEqual({ success: 1, failure: 1 });
    expect(health.costs7d.usd).toBe(1.5);
  });

  it("has no runs at all without inventing an outcome", () => {
    expect(loopHealth([], NOW)).toEqual({ lastOutcome: null, lastRunAt: null, consecutiveFailures: 0, runs7d: { success: 0, failure: 0 }, costs7d: { usd: 0 } });
  });
});

describe("runDisplayState — ONE lifecycle, read off the production phase", () => {
  it("maps a running row to running and a pending one to queued", () => {
    expect(runDisplayState({ phase: "running" })).toBe("running");
    expect(runDisplayState({ phase: "pending" })).toBe("queued");
  });
  it("maps the terminal phases to the words the screens render", () => {
    expect(runDisplayState({ phase: "done" })).toBe("success");
    expect(runDisplayState({ phase: "error" })).toBe("failure");
    // A superseded/deferred row is NEITHER success nor failure — quiet gray.
    expect(runDisplayState({ phase: "canceled" })).toBe("skipped");
  });
});
