import { describe, expect, it } from "vitest";
import {
  type Command,
  type Provenance,
  decide,
  emptyWorld,
  tick,
  type World,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const HUMAN: Provenance = { entrance: "human", actorId: "u-tim" };
const T0 = "2026-08-09T07:00:00.000Z";
const DUE = "2026-08-10T07:00:00.000Z";
const LATE = "2026-08-10T09:30:00.000Z";

function seed(...cmds: Command[]): World {
  let world = emptyWorld();
  for (const cmd of cmds) {
    const d = decide(cmd, world.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error(`seed refused: ${d.refusal.message}`);
    world = foldToWorld(world, d.changeset);
  }
  return world;
}

function tickWorld(world: World, now: string): World {
  const r = tick(world.snapshot, now);
  return r.changesets.reduce(foldToWorld, world);
}

describe("cron fire", () => {
  it("creates run(pending) with derived id and advances nextFireAt", () => {
    const w0 = seed({ op: "create", title: "react doctor", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "claude" });
    const w1 = tickWorld(w0, LATE);
    expect(w1.snapshot.runs).toMatchObject([
      { cause: "cron", state: "pending", scheduledAt: DUE, assignee: "claude" },
    ]);
    expect(Date.parse(w1.snapshot.triggers[0].nextFireAt as string)).toBeGreaterThan(Date.parse(LATE));
    // recurring: the task's status is untouched by dispatch
    const t = w1.snapshot.objects["react-doctor"];
    expect(t.archetype === "task" && t.status).toBe("in-progress");
  });

  it("is idempotent under replay (derived run id is the dedup)", () => {
    const w0 = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const w1 = tickWorld(w0, LATE);
    // Replay the same due window against the ALREADY-applied state but with the
    // trigger rewound (simulates a crash before the cursor advanced).
    const rewound: World = {
      ...w1,
      snapshot: {
        ...w1.snapshot,
        triggers: w1.snapshot.triggers.map((t) => ({ ...t, nextFireAt: DUE })),
      },
    };
    const w2 = tickWorld(rewound, LATE);
    expect(w2.snapshot.runs).toHaveLength(1); // no duplicate dispatch
  });

  it("a new fire supersedes a still-pending cron run; a claimed run forbids overlap", () => {
    const w0 = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const w1 = tickWorld(w0, LATE);
    const nextDue = "2026-08-11T07:05:00.000Z";
    const w2 = tickWorld(w1, nextDue);
    expect(w2.snapshot.runs.map((r) => r.state).sort()).toEqual(["pending", "superseded"]);

    const claimed: World = {
      ...w2,
      snapshot: {
        ...w2.snapshot,
        runs: w2.snapshot.runs.map((r) => (r.state === "pending" ? { ...r, state: "claimed" } : r)),
      },
    };
    const w3 = tickWorld(claimed, "2026-08-12T07:05:00.000Z");
    expect(w3.snapshot.runs.filter((r) => r.state === "pending")).toHaveLength(0); // overlap forbid
    expect(Date.parse(w3.snapshot.triggers[0].nextFireAt as string)).toBeGreaterThan(
      Date.parse("2026-08-12T07:05:00.000Z"), // the clock still advanced
    );
  });
});

describe("once fire", () => {
  it("flips follow-up -> todo with clock provenance, dispatches, consumes the trigger", () => {
    const w0 = seed({ op: "create", title: "bet", followUpAt: DUE, assignee: "claude" });
    const w1 = tickWorld(w0, LATE);
    const t = w1.snapshot.objects["bet"];
    expect(t.archetype === "task" && t.status).toBe("todo");
    expect(t.archetype === "task" && t.followUpAt).toBeNull();
    expect(w1.snapshot.triggers).toHaveLength(0);
    expect(w1.snapshot.runs).toMatchObject([{ cause: "once", state: "pending" }]);
    expect(w1.events.at(-1)).toMatchObject({
      kind: "status-changed",
      provenance: { entrance: "clock", actorId: "trg-bet-once" },
    });
  });

  it("a person's wait surfaces without a run (inbox, not dispatch)", () => {
    const w0 = seed({ op: "create", title: "bet", followUpAt: DUE, assignee: "tim@x.com" });
    const w1 = tickWorld(w0, LATE);
    const t = w1.snapshot.objects["bet"];
    expect(t.archetype === "task" && t.status).toBe("todo");
    expect(w1.snapshot.runs).toHaveLength(0);
  });

  it("a stale alarm never wakes the task (the slot value is the generation)", () => {
    const w0 = seed({ op: "create", title: "bet", followUpAt: DUE });
    // Task moved on since the alarm was set (human closed it without a tick).
    const moved: World = {
      ...w0,
      snapshot: {
        ...w0.snapshot,
        objects: {
          ...w0.snapshot.objects,
          bet: { ...(w0.snapshot.objects["bet"] as never as object), status: "done", followUpAt: null } as never,
        },
      },
    };
    const w1 = tickWorld(moved, LATE);
    const t = w1.snapshot.objects["bet"];
    expect(t.archetype === "task" && t.status).toBe("done"); // untouched
    expect(w1.snapshot.runs).toHaveLength(0);
    expect(w1.snapshot.triggers).toHaveLength(0); // consumed
    expect(w1.events.at(-1)).toMatchObject({ kind: "trigger-discarded" });
  });
});

describe("housekeeping", () => {
  it("not-yet-due triggers do not fire", () => {
    const w0 = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress" });
    const r = tick(w0.snapshot, "2026-08-09T08:00:00.000Z"); // next fire is tomorrow 07:00
    expect(r.changesets).toHaveLength(0);
  });

  it("an orphan trigger is dropped", () => {
    const w0 = seed({ op: "create", title: "x", followUpAt: DUE });
    const orphaned: World = {
      ...w0,
      snapshot: { ...w0.snapshot, objects: {} },
    };
    const w1 = tickWorld(orphaned, LATE);
    expect(w1.snapshot.triggers).toHaveLength(0);
  });
});
