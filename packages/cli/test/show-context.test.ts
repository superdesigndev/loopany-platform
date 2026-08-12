import { describe, expect, it } from "vitest";
import type { KernelEvent, Snapshot, TaskObject } from "@loopany/kernel";
import { renderShow } from "../src/render.js";

const task: TaskObject = {
  archetype: "task",
  id: "support-inbox-triage",
  title: "Support inbox triage",
  status: "in-progress",
  assignee: "stonex-mbp/codex",
  priority: null,
  type: null,
  parent: null,
  tracks: null,
  owner: "owner@example.com",
  workdir: "/workspace",
  goal: null,
  refs: [],
  followUpAt: null,
  body: "## Spec\n\nTriage the inbox.",
  version: 3,
  createdAt: "2026-08-12T14:00:00.000Z",
  updatedAt: "2026-08-12T15:00:00.000Z",
};

function event(over: Partial<KernelEvent> & Pick<KernelEvent, "kind" | "at">): KernelEvent {
  return {
    id: `ev-${over.at}-${over.kind}`,
    objectId: task.id,
    provenance: { entrance: "device", actorId: "shared" },
    ...over,
  };
}

describe("task show current context semantics", () => {
  it("clears a historical dispatch block after that run completed successfully", () => {
    const events = [
      event({ kind: "created", at: "2026-08-12T14:00:00.000Z", note: task.title }),
      event({
        kind: "note",
        at: "2026-08-12T14:07:00.000Z",
        note: "dispatch blocked (run run-old): unknown machine alias",
        provenance: { entrance: "clock", actorId: "kernel-dispatch" },
      }),
      event({ kind: "run-started", at: "2026-08-12T14:30:00.000Z", note: "run run-old started" }),
      event({ kind: "run-returned", at: "2026-08-12T15:00:00.000Z", note: "run run-old returned done" }),
    ];
    const snapshot: Snapshot = {
      objects: { [task.id]: task },
      triggers: [],
      runs: [{
        id: "run-old",
        taskId: task.id,
        triggerId: null,
        cause: "assignment",
        state: "done",
        assignee: task.assignee,
        scheduledAt: "2026-08-12T14:00:00.000Z",
        createdAt: "2026-08-12T14:00:00.000Z",
        note: "completed",
      }],
    };

    const out = renderShow(task, snapshot, null, [], false, { "stonex-mbp": "online" }, events);
    expect(out).not.toContain("blocking condition:");
    expect(out).not.toContain("resolve the machine/configuration issue");
    expect(out).toContain("next: continue the task");
  });

  it("does not present a created-event title as a handoff reason", () => {
    const events = [event({ kind: "created", at: "2026-08-12T14:00:00.000Z", note: "Daily PostHog" })];
    const snapshot: Snapshot = { objects: { [task.id]: task }, triggers: [], runs: [] };

    const out = renderShow(task, snapshot, null, [], false, {}, events);
    expect(out).not.toContain("handoff:");
    expect(out).not.toContain("Daily PostHog");
  });

  it("shows a meaningful assignee-change note as the handoff", () => {
    const events = [
      event({ kind: "created", at: "2026-08-12T14:00:00.000Z", note: task.title }),
      event({
        kind: "assignee-changed",
        at: "2026-08-12T14:05:00.000Z",
        note: "Review the repaired routing behavior",
        diff: { assignee: { old: "owner@example.com", new: task.assignee } },
      }),
    ];
    const snapshot: Snapshot = { objects: { [task.id]: task }, triggers: [], runs: [] };

    const out = renderShow(task, snapshot, null, [], false, {}, events);
    expect(out).toContain("handoff:\n  Review the repaired routing behavior");
  });

  it("uses the same-write note when a combined status and assignee update carries it on the status event", () => {
    const at = "2026-08-12T14:05:00.000Z";
    const provenance = { entrance: "agent-run" as const, actorId: "run-review" };
    const events = [
      event({ kind: "created", at: "2026-08-12T14:00:00.000Z", note: task.title }),
      event({
        kind: "status-changed",
        at,
        note: "Review commit 4aa1407 and its regression coverage",
        diff: { status: { old: "in-progress", new: "todo" } },
        provenance,
      }),
      event({
        kind: "assignee-changed",
        at,
        diff: { assignee: { old: task.assignee, new: "owner@example.com" } },
        provenance,
      }),
    ];
    const snapshot: Snapshot = { objects: { [task.id]: task }, triggers: [], runs: [] };

    const out = renderShow(task, snapshot, null, [], false, {}, events);
    expect(out).toContain("handoff:\n  Review commit 4aa1407 and its regression coverage");
  });

  it("does not tell a terminal task to continue", () => {
    const done = { ...task, status: "done" as const };
    const snapshot: Snapshot = { objects: { [done.id]: done }, triggers: [], runs: [] };

    const out = renderShow(done, snapshot, null, [], false, {}, []);
    expect(out).toContain("next: none - task is done");
    expect(out).toContain(`reopen: loopany-kernel update ${done.id} status=todo`);
    expect(out).not.toContain("continue the task");
  });
});
