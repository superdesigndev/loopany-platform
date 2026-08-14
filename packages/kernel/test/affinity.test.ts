import { describe, expect, it } from "vitest";
import { emptySnapshot, taskExecutionMachine, type RunRecord, type TaskObject } from "../src/index.js";

const task = (id: string, patch: Partial<TaskObject> = {}): TaskObject => ({
  archetype: "task", id, title: id, status: "todo", assignee: null, owner: null,
  priority: null, type: null, parent: null, tracks: null, refs: [],
  followUpAt: null, workdir: "/work/project", goal: null, workflow: null,
  body: "", version: 1, createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z", ...patch,
});

const run = (id: string, taskId: string, assignee: string): RunRecord => ({
  id, taskId, assignee, cause: "manual", scheduledAt: "2026-08-14T00:00:00.000Z",
  state: "done", triggerId: null, createdAt: "2026-08-14T00:00:00.000Z",
});

describe("derived Task execution Machine", () => {
  it("uses the nearest ancestor address for a machine-local child", () => {
    const parent = task("loop", { assignee: "stone-mbp/claude" });
    const child = task("child", { parent: parent.id, assignee: "person:tim" });
    const snapshot = { ...emptySnapshot(), objects: { loop: parent, child } };
    expect(taskExecutionMachine(snapshot, child)).toBe("stone-mbp");
  });

  it("falls back to Run history after a root Task is handed to a person", () => {
    const root = task("root", { assignee: "person:tim" });
    const snapshot = { ...emptySnapshot(), objects: { root }, runs: [run("run-1", root.id, "jason-mbp/codex")] };
    expect(taskExecutionMachine(snapshot, root)).toBe("jason-mbp");
  });

  it("keeps a null-workdir Task portable even under a bound parent", () => {
    const parent = task("loop", { assignee: "stone-mbp/claude" });
    const child = task("portable", { parent: parent.id, workdir: null });
    const snapshot = { ...emptySnapshot(), objects: { loop: parent, portable: child } };
    expect(taskExecutionMachine(snapshot, child)).toBeNull();
  });
});
