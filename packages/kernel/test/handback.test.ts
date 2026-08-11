/**
 * HUMAN HAND-BACK (kernel-human-handoff): the atomic comment-and-hand-back is
 * ONE ordinary update - `assignee=<agent-addr> status=todo --note "<reply>"` -
 * whose single decision records the reply on the assignee-changed event AND
 * mints the assignment run (haiku-4 handoff semantics). Duplicate submission
 * resolves by CAS with no duplicate run.
 */
import { describe, expect, it } from "vitest";
import {
  type Command,
  type Provenance,
  type World,
  applyChangeset,
  decide,
  emptyWorld,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const TIM: Provenance = { entrance: "human", actorId: "tim@x.co" };
const T0 = "2026-08-09T07:00:00.000Z";
const T1 = "2026-08-09T09:00:00.000Z";

function seed(...cmds: Command[]): World {
  let world = emptyWorld();
  for (const cmd of cmds) {
    const d = decide(cmd, world.snapshot, TIM, T0);
    if (!d.ok) throw new Error(`seed refused: ${d.refusal.code} ${d.refusal.message}`);
    world = foldToWorld(world, d.changeset);
  }
  return world;
}

/** An agent minted a decision task for tim: person assignee = inbox work, no run. */
function decisionSeed(): World {
  return seed({
    op: "create",
    title: "decide: ship variant A or B",
    id: "decide-brand",
    assignee: "tim@x.co",
    parent: undefined,
    tracks: undefined,
  });
}

const HANDBACK: Command = {
  op: "update",
  id: "decide-brand",
  patch: { assignee: "mbp/claude", status: "todo" },
  note: "ship variant B - the landing metrics favor it; keep A's headline",
};

describe("atomic comment-and-hand-back", () => {
  it("a person assignee mints NO run (inbox work), the hand-back mints exactly one assignment run with the reply", () => {
    const w = decisionSeed();
    expect(w.snapshot.runs).toHaveLength(0); // waiting on the human, nothing dispatched

    const d = decide(HANDBACK, w.snapshot, TIM, T1);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const w2 = foldToWorld(w, d.changeset);

    // ONE decision produced BOTH effects: the reply on the assignee-changed
    // event, and the assignment run toward the agent.
    const reply = w2.events.find((e) => e.kind === "assignee-changed" && e.note?.includes("ship variant B"));
    expect(reply).toBeDefined();
    const runs = w2.snapshot.runs.filter((r) => r.taskId === "decide-brand");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ cause: "assignment", state: "pending", assignee: "mbp/claude" });
  });

  it("duplicate submission resolves by CAS: the second identical hand-back cannot double-dispatch", () => {
    const w = decisionSeed();
    // Two browser tabs decide off the SAME snapshot.
    const d1 = decide(HANDBACK, w.snapshot, TIM, T1);
    const d2 = decide(HANDBACK, w.snapshot, TIM, T1);
    expect(d1.ok && d2.ok).toBe(true);
    if (!d1.ok || !d2.ok) return;

    const first = applyChangeset(w.snapshot, d1.changeset);
    expect(first.ok).toBe(true);
    const second = applyChangeset(first.ok ? first.snapshot : w.snapshot, d2.changeset);
    expect(second.ok).toBe(false); // stale version lost the CAS

    const runs = (first.ok ? first.snapshot : w.snapshot).runs.filter((r) => r.taskId === "decide-brand");
    expect(runs).toHaveLength(1); // exactly one dispatch
  });

  it("a SEQUENTIAL re-submit after the hand-back landed is a NO_OP, never a second run", () => {
    const w = decisionSeed();
    const d1 = decide(HANDBACK, w.snapshot, TIM, T1);
    if (!d1.ok) throw new Error("first handback refused");
    const w2 = foldToWorld(w, d1.changeset);

    const d2 = decide(HANDBACK, w2.snapshot, TIM, T1);
    // Same assignee + same status: nothing changes, and the active pending run
    // guard means no second dispatch either way.
    if (d2.ok) {
      const w3 = foldToWorld(w2, d2.changeset);
      expect(w3.snapshot.runs.filter((r) => r.taskId === "decide-brand")).toHaveLength(1);
    } else {
      expect(d2.refusal.code).toBe("NO_OP");
    }
  });

  it("a hand-back while a STALE pending run points at the human supersedes it (haiku-4 pin)", () => {
    // The agent handed OFF to tim while its own pending run existed - a manual
    // re-dispatch toward tim would be person-ineligible, so seed the stale run
    // shape directly: agent-assigned with a pending run, then reassigned to tim.
    let w = seed({ op: "create", title: "loopish", id: "loopish", assignee: "mbp/claude" });
    expect(w.snapshot.runs).toHaveLength(1); // the create dispatched
    const toTim = decide({ op: "update", id: "loopish", patch: { assignee: "tim@x.co" }, note: "your call" }, w.snapshot, TIM, T1);
    if (!toTim.ok) throw new Error(toTim.refusal.code);
    w = foldToWorld(w, toTim.changeset);

    const stale = w.snapshot.runs.filter((r) => r.taskId === "loopish" && r.state === "pending");
    expect(stale).toHaveLength(0); // the old agent-bound run was superseded
    expect(w.snapshot.runs.some((r) => r.state === "superseded")).toBe(true);
  });
});
