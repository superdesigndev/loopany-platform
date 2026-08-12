import { describe, expect, it } from "vitest";
import { applyChangeset, decide, emptySnapshot, projectOperationalContext, type Snapshot } from "../src/index.js";

const actor = { entrance: "human" as const, actorId: "owner@example.com" };
const now = "2026-08-12T00:00:00.000Z";

describe("write operational context", () => {
  it("attributes runs from the applied changeset, never unrelated concurrent snapshot rows", () => {
    const created = decide({ op: "create", title: "Target", assignee: "mbp/codex", status: "todo" }, emptySnapshot(), actor, now);
    if (!created.ok) throw new Error(created.refusal.message);
    const applied = applyChangeset(emptySnapshot(), created.changeset);
    if (!applied.ok) throw new Error(applied.conflict.message);
    const ownRun = created.changeset.runs.find((m) => m.op === "insert")!.run;
    const concurrentRun = { ...ownRun, id: "run-concurrent", scheduledAt: "2026-08-12T00:00:01.000Z" };
    const laterSnapshot: Snapshot = { ...applied.snapshot, runs: [...applied.snapshot.runs, concurrentRun] };

    const context = projectOperationalContext(
      { op: "create", title: "Target", assignee: "mbp/codex", status: "todo" },
      created.changeset,
      laterSnapshot,
      { mbp: "online" },
    );

    expect(context.run.createdId).toBe(ownRun.id);
    expect(context.run.createdId).not.toBe(concurrentRun.id);
  });
});
