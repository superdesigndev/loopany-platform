import { describe, expect, it } from "vitest";
import { runArtifactsView, type KernelEvent, type Snapshot } from "../src/index.js";

const snapshot: Snapshot = {
  objects: {
    report: { archetype: "doc", id: "report", key: "report", title: "Report", body: "body", version: 2, createdAt: "2026-08-12T01:00:00Z", updatedAt: "2026-08-12T02:00:00Z" },
    source: { archetype: "mirror", id: "source", kind: "url", coords: "https://example.com", version: 1, createdAt: "2026-08-12T01:00:00Z", updatedAt: "2026-08-12T01:00:00Z" },
  },
  triggers: [], runs: [],
};
const provenance = { entrance: "agent-run", actorId: "run-1" } as const;

describe("runArtifactsView", () => {
  it("derives created, updated, and newly attached artifacts from run events", () => {
    const events: KernelEvent[] = [
      { id: "1", objectId: "report", kind: "created", at: "2026-08-12T01:00:00Z", provenance },
      { id: "2", objectId: "report", kind: "doc-updated", at: "2026-08-12T02:00:00Z", provenance },
      { id: "3", objectId: "task-a", kind: "fields-changed", at: "2026-08-12T03:00:00Z", diff: { refs: { old: ["report"], new: ["report", "source"] } }, provenance },
      { id: "4", objectId: "source", kind: "created", at: "2026-08-12T04:00:00Z", provenance: { entrance: "agent-run", actorId: "other-run" } },
    ];
    expect(runArtifactsView(snapshot, events, "run-1")).toEqual([
      { artifact: snapshot.objects.source, actions: ["attached"], lastTouchedAt: "2026-08-12T03:00:00Z" },
      { artifact: snapshot.objects.report, actions: ["created", "updated"], lastTouchedAt: "2026-08-12T02:00:00Z" },
    ]);
  });
});
