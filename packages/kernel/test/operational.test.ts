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

  it("does not invent remote machine presence or manual dispatch for an inert idea", () => {
    const command = { op: "create", title: "Maybe later", assignee: "mbp/codex", status: "idea" } as const;
    const decision = decide(command, emptySnapshot(), actor, now);
    if (!decision.ok) throw new Error(decision.refusal.message);
    const applied = applyChangeset(emptySnapshot(), decision.changeset);
    if (!applied.ok) throw new Error(applied.conflict.message);

    const context = projectOperationalContext(command, decision.changeset, applied.snapshot);
    expect(context.machine).toEqual({ alias: "mbp", presence: "unavailable" });
    expect(context.action).toBeNull();
    expect(context.nextCommand).toBeNull();
  });

  it("describes a manual run as queued even when the task also has a future trigger", () => {
    const create = { op: "create", title: "Loop", id: "loop", assignee: "mbp/codex", status: "in-progress", cron: "0 9 * * *", timezone: "Asia/Singapore" } as const;
    const born = decide(create, emptySnapshot(), actor, now);
    if (!born.ok) throw new Error(born.refusal.message);
    const seeded = applyChangeset(emptySnapshot(), born.changeset);
    if (!seeded.ok) throw new Error(seeded.conflict.message);
    const run = { op: "run", id: "loop" } as const;
    const decision = decide(run, seeded.snapshot, actor, now);
    if (!decision.ok) throw new Error(decision.refusal.message);
    const applied = applyChangeset(seeded.snapshot, decision.changeset);
    if (!applied.ok) throw new Error(applied.conflict.message);

    const context = projectOperationalContext(run, decision.changeset, applied.snapshot, { mbp: "online" });
    expect(context.run.consequence).toBe("created");
    expect(context.action).toBe("no action required; the run is queued for delivery");
  });
});
