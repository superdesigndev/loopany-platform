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
  id: "task-1", createdByLoop: "loop-a", watcher: null, pendingQuestion: null, adopted: false, ...over,
});

describe("deriveGraphEdges — one branch per spec §8.3 row", () => {
  it("an unwatched product flows to the pool", () => {
    expect(deriveGraphEdges([task({ watcher: null })])).toEqual([{ from: "loop-a", to: "pool", kind: "produces", count: 1 }]);
  });

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

  it("a question with no watcher asks, and nothing answers", () => {
    expect(deriveGraphEdges([task({ watcher: null, pendingQuestion: "which one?" })])).toEqual([
      { from: "loop-a", to: "you", kind: "asks", count: 1 },
    ]);
  });

  it("an adopted task keeps its original produces edge AND gains the adoption", () => {
    expect(deriveGraphEdges([task({ watcher: "loop-b", adopted: true })])).toEqual([
      { from: "loop-a", to: "pool", kind: "produces", count: 1 },
      { from: "pool", to: "loop-b", kind: "adopts", count: 1 },
    ]);
  });

  it("a human-created task uses the you node as its source", () => {
    expect(deriveGraphEdges([task({ createdByLoop: null, watcher: "loop-b" })])).toEqual([
      { from: "you", to: "loop-b", kind: "hands-off", count: 1 },
    ]);
  });

  it("groups by (from, to, kind) and counts the tasks in the window", () => {
    const edges = deriveGraphEdges([
      task({ id: "t1", watcher: null }),
      task({ id: "t2", watcher: null }),
      task({ id: "t3", watcher: "loop-b" }),
    ]);
    expect(edges).toEqual([
      { from: "loop-a", to: "pool", kind: "produces", count: 2 },
      { from: "loop-a", to: "loop-b", kind: "hands-off", count: 1 },
    ]);
  });
});

const NOW = new Date("2026-08-08T12:00:00.000Z");
const run = (over: Partial<Run>): Run => ({
  id: "run-1", loopId: "loop-a", userId: "u", machineId: "m", phase: "done", role: "exec",
  ts: "2026-08-08T07:00:00.000Z", queueState: "success", startedAt: "2026-08-08T07:00:00.000Z",
  finishedAt: "2026-08-08T07:03:00.000Z", costUsd: 0.42, attempts: 1,
  ...over,
} as Run);

describe("loopHealth — health from runs, never a stored field", () => {
  it("reads the newest run as the last outcome", () => {
    const health = loopHealth([
      run({ id: "old", startedAt: "2026-08-01T07:00:00.000Z", queueState: "failure" }),
      run({ id: "new", startedAt: "2026-08-08T07:00:00.000Z", queueState: "success" }),
    ], NOW);
    expect(health.lastOutcome).toBe("success");
    expect(health.lastRunAt).toBe("2026-08-08T07:03:00.000Z");
  });

  it("counts a failure streak newest-first and stops at the first success", () => {
    const health = loopHealth([
      run({ id: "c", startedAt: "2026-08-08T07:00:00.000Z", queueState: "failure" }),
      run({ id: "b", startedAt: "2026-08-07T07:00:00.000Z", queueState: "failure" }),
      run({ id: "a", startedAt: "2026-08-06T07:00:00.000Z", queueState: "success" }),
      run({ id: "z", startedAt: "2026-08-05T07:00:00.000Z", queueState: "failure" }),
    ], NOW);
    expect(health.consecutiveFailures).toBe(2);
  });

  it("is transparent to a queued or running run — neither is an outcome", () => {
    const health = loopHealth([
      run({ id: "live", startedAt: "2026-08-08T11:00:00.000Z", queueState: "claimed", finishedAt: null }),
      run({ id: "bad", startedAt: "2026-08-08T07:00:00.000Z", queueState: "failure" }),
    ], NOW);
    expect(health.lastOutcome).toBe("running");
    expect(health.consecutiveFailures).toBe(1);
  });

  it("windows the 7-day tallies and sums cost across them", () => {
    const health = loopHealth([
      run({ id: "in1", startedAt: "2026-08-08T07:00:00.000Z", finishedAt: "2026-08-08T07:03:00.000Z", queueState: "success", costUsd: 1 }),
      run({ id: "in2", startedAt: "2026-08-05T07:00:00.000Z", finishedAt: "2026-08-05T07:03:00.000Z", queueState: "failure", costUsd: 0.5 }),
      run({ id: "out", startedAt: "2026-06-01T07:00:00.000Z", finishedAt: "2026-06-01T07:03:00.000Z", queueState: "success", costUsd: 99 }),
    ], NOW);
    expect(health.runs7d).toEqual({ success: 1, failure: 1 });
    expect(health.costs7d.usd).toBe(1.5);
  });

  it("has no runs at all without inventing an outcome", () => {
    expect(loopHealth([], NOW)).toEqual({ lastOutcome: null, lastRunAt: null, consecutiveFailures: 0, runs7d: { success: 0, failure: 0 }, costs7d: { usd: 0 } });
  });
});

describe("runDisplayState — the rewrite column wins, legacy rows still read", () => {
  it("maps claimed to running", () => expect(runDisplayState({ queueState: "claimed", phase: "running" })).toBe("running"));
  it("passes success and failure through", () => expect(runDisplayState({ queueState: "failure", phase: "error" })).toBe("failure"));
  it("falls back to the legacy phase on a migrated loop's old run", () => {
    expect(runDisplayState({ queueState: null, phase: "done" })).toBe("success");
    expect(runDisplayState({ queueState: null, phase: "canceled" })).toBe("skipped");
  });
});
