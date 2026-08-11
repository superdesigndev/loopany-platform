/**
 * CLOSED GOAL (kernel-closed-goal): `task.goal` is the FINISH LINE - null =
 * open work, non-null = the task COMPLETES. The contract: done needs a
 * completion note (never silent), completion pauses triggers (the EXISTING
 * terminal invariant #2 - no goal-specific trigger machinery), reopen re-arms
 * deterministically (#2'), and an open recurring task never needs any of it.
 */
import { describe, expect, it } from "vitest";
import {
  type Command,
  type Decision,
  type Provenance,
  type TaskObject,
  type World,
  decide,
  emptyWorld,
  tick,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const HUMAN: Provenance = { entrance: "human", actorId: "u" };
const T0 = "2026-08-09T07:00:00.000Z";
const LATER = "2026-08-20T07:30:00.000Z";

function run(world: World, cmd: Command, now = T0): { world: World; d: Decision } {
  const d = decide(cmd, world.snapshot, HUMAN, now);
  return { world: d.ok ? foldToWorld(world, d.changeset) : world, d };
}

function seed(...cmds: Command[]): World {
  let world = emptyWorld();
  for (const cmd of cmds) {
    const d = decide(cmd, world.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error(`seed refused: ${d.refusal.code} ${d.refusal.message}`);
    world = foldToWorld(world, d.changeset);
  }
  return world;
}

const CLOSED_LOOP: Command = {
  op: "create",
  title: "reach 1k subscribers",
  id: "subs",
  goal: "newsletter reaches 1000 confirmed subscribers",
  cron: "0 7 * * *",
  status: "in-progress",
  assignee: "mbp/claude",
};

describe("closed-goal completion contract", () => {
  it("create --goal persists the finish line; goal is editable and clearable via update", () => {
    let w = seed(CLOSED_LOOP);
    expect((w.snapshot.objects.subs as TaskObject).goal).toBe("newsletter reaches 1000 confirmed subscribers");

    ({ world: w } = run(w, { op: "update", id: "subs", patch: { goal: "reach 2000 subscribers" } }));
    expect((w.snapshot.objects.subs as TaskObject).goal).toBe("reach 2000 subscribers");

    // Clearing the goal reopens it as ordinary open work.
    ({ world: w } = run(w, { op: "update", id: "subs", patch: { goal: null } }));
    expect((w.snapshot.objects.subs as TaskObject).goal).toBeNull();
  });

  it("a closed goal CANNOT silently become done: no note refuses GOAL_NEEDS_NOTE", () => {
    const w = seed(CLOSED_LOOP);
    const { d } = run(w, { op: "update", id: "subs", patch: { status: "done" } });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.refusal.code).toBe("GOAL_NEEDS_NOTE");
      expect(d.refusal.hint).toContain("--note");
    }
  });

  it("done WITH a completion note completes: note on the status event, cron paused by the terminal invariant", () => {
    let w = seed(CLOSED_LOOP);
    const { world: w2, d } = run(w, {
      op: "update",
      id: "subs",
      patch: { status: "done" },
      note: "hit 1042 confirmed subscribers on 2026-08-09 (see weekly-report doc)",
    });
    expect(d.ok).toBe(true);
    w = w2;
    expect((w.snapshot.objects.subs as TaskObject).status).toBe("done");

    // The completion EVENT exists and carries the evidence.
    const completion = w.events.find((e) => e.objectId === "subs" && e.kind === "status-changed" && e.note?.includes("1042"));
    expect(completion).toBeDefined();

    // Triggers paused via the EXISTING terminal invariant - future fires stop.
    const cron = w.snapshot.triggers.find((t) => t.taskId === "subs" && t.kind === "cron");
    expect(cron).toMatchObject({ enabled: false, disabledBy: "invariant" });
    expect(tick(w.snapshot, LATER).changesets).toHaveLength(0); // nothing mints
  });

  it("reopen is deterministic: leaving done re-arms the cron (#2') and fires again", () => {
    let w = seed(CLOSED_LOOP);
    ({ world: w } = run(w, { op: "update", id: "subs", patch: { status: "done" }, note: "goal met" }));
    ({ world: w } = run(w, { op: "update", id: "subs", patch: { status: "in-progress" }, note: "reopening - bar moved" }, LATER));

    const cron = w.snapshot.triggers.find((t) => t.taskId === "subs" && t.kind === "cron");
    expect(cron?.enabled).toBe(true);
    expect(cron?.disabledBy).toBeNull();
    expect(cron?.nextFireAt && cron.nextFireAt > LATER).toBe(true); // future fire re-computed
  });

  it("OPEN work (goal null) keeps today's semantics: done without a note is fine, loops run forever", () => {
    let w = seed({ op: "create", title: "tidy the docs", id: "tidy" });
    const { d } = run(w, { op: "update", id: "tidy", patch: { status: "done" } });
    expect(d.ok).toBe(true);

    // An open recurring task just keeps running - no completion pressure.
    w = seed({ op: "create", title: "daily seo", id: "seo", cron: "0 7 * * *", status: "in-progress", assignee: "mbp/claude" });
    expect((w.snapshot.objects.seo as TaskObject).goal).toBeNull();
    expect(tick(w.snapshot, LATER).changesets.length).toBeGreaterThan(0);
  });
});
