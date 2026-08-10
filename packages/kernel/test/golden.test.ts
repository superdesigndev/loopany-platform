/**
 * The GOLDEN SCRIPT — a full product scenario driven only through the public
 * surface (decide/tick/apply). This same script is the M6 conformance gate:
 * run it against the local driver and the server driver and the outcomes must
 * match. Keep it scenario-shaped, not unit-shaped.
 *
 * Scenario: the SEO two-loop handoff (v1 design doc §6.4) compressed —
 * a bet manager loop opens a bet, the bet scores daily, wins on day 7,
 * a human approves the engine, the engine loop is born, the bet dies done.
 */
import { describe, expect, it } from "vitest";
import {
  type Command,
  type Provenance,
  decide,
  emptyWorld,
  inboxView,
  loopsView,
  tick,
  treeView,
  type World,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const OWNER: Provenance = { entrance: "human", actorId: "u-tim" };
const RUN = (n: number): Provenance => ({ entrance: "agent-run", actorId: `run-${n}`, sessionId: `sess-${n}` });

function exec(world: World, cmd: Command, actor: Provenance, now: string): World {
  const d = decide(cmd, world.snapshot, actor, now);
  if (!d.ok) throw new Error(`${cmd.op} refused: ${d.refusal.code} ${d.refusal.message}`);
  return foldToWorld(world, d.changeset);
}

function tickAll(world: World, now: string): World {
  return tick(world.snapshot, now).changesets.reduce(foldToWorld, world);
}

describe("golden: SEO two-loop lifecycle", () => {
  it("bet -> daily series -> verdict -> engine birth -> bet death", () => {
    let w = emptyWorld();
    const d0 = "2026-08-03T09:00:00.000Z";

    // Monday: the bet manager loop exists; its run opens a bet.
    w = exec(w, { op: "create", title: "seo bet manager", cron: "0 9 * * 1", timezone: "UTC", status: "in-progress", assignee: "mbp/claude" }, OWNER, d0);
    w = exec(w, { op: "doc-put", key: "seo bet ledger", body: "term | thesis | verdict\n" }, RUN(1), d0);
    w = exec(w, { op: "mirror-add", kind: "github-pr", coords: "site#611" }, RUN(1), d0);
    const prId = w.snapshot.objects["seo-bet-ledger"] ? Object.keys(w.snapshot.objects).find((k) => k.startsWith("m-")) : undefined;
    w = exec(
      w,
      {
        op: "create",
        title: "bet: claude code design prompts",
        parent: "seo-bet-manager",
        tracks: prId,
        assignee: "mbp/claude",
        followUpAt: "2026-08-04T07:00:00.000Z",
        body: "thesis: emerging head term",
      },
      RUN(1),
      d0,
    );

    // Days 2..7: the once trigger fires daily; the agent observes and re-arms.
    for (let day = 4; day <= 9; day++) {
      const at = `2026-08-${String(day).padStart(2, "0")}T07:05:00.000Z`;
      w = tickAll(w, at);
      const bet = w.snapshot.objects["bet-claude-code-design-prompts"];
      expect(bet.archetype === "task" && bet.status).toBe("todo"); // flipped by the clock
      if (day < 9) {
        w = exec(
          w,
          {
            op: "note",
            id: "bet-claude-code-design-prompts",
            note: `day${day - 3}: series read`,
            observation: { observedAt: at, sourceRevision: `gsc-${day}`, facts: { imp: day * 7 } },
          },
          RUN(day),
          at,
        );
        w = exec(
          w,
          {
            op: "update",
            id: "bet-claude-code-design-prompts",
            patch: { status: "follow-up", followUpAt: `2026-08-${String(day + 1).padStart(2, "0")}T07:00:00.000Z` },
          },
          RUN(day),
          at,
        );
      }
    }

    // Day 7: SCALE verdict — ledger row, approval shepherd to the owner, bet closes.
    const d7 = "2026-08-09T07:30:00.000Z";
    w = exec(w, { op: "doc-put", key: "seo bet ledger", body: "term | thesis | verdict\nccdp | emerging | SCALE\n" }, RUN(9), d7);
    w = exec(
      w,
      { op: "create", title: "approve engine: ccdp", tracks: "seo-bet-ledger", assignee: "tim@x.com", parent: "seo-bet-manager" },
      RUN(9),
      d7,
    );
    w = exec(w, { op: "update", id: "bet-claude-code-design-prompts", patch: { status: "done" }, note: "SCALE — handed to owner gate" }, RUN(9), d7);

    // The approval sits in Tim's inbox; nothing was dispatched for it.
    expect(inboxView(w.snapshot, "tim@x.com", d7)).toMatchObject([
      { task: { id: "approve-engine-ccdp" }, reason: "assigned" },
    ]);

    // Tim approves by handing it back to the agent (assignment IS dispatch).
    const d8 = "2026-08-09T12:00:00.000Z";
    w = exec(w, { op: "update", id: "approve-engine-ccdp", patch: { assignee: "mbp/claude" }, note: "approved" }, OWNER, d8);
    expect(w.snapshot.runs.filter((r) => r.state === "pending" && r.cause === "assignment")).toHaveLength(1);

    // The dispatched run births the engine (loop birth = create --cron) and closes the shepherd.
    const d9 = "2026-08-09T12:10:00.000Z";
    w = exec(
      w,
      { op: "create", title: "seo engine ccdp", cron: "0 9 * * 3", timezone: "UTC", status: "in-progress", assignee: "mbp/claude", body: "regime: land-grab" },
      RUN(10),
      d9,
    );
    w = exec(w, { op: "update", id: "approve-engine-ccdp", patch: { status: "done" }, note: "engine born" }, RUN(10), d9);

    // Final shape: two loops, a dead bet, a full audit trail.
    const loops = loopsView(w.snapshot);
    expect(loops.map((l) => l.task.id).sort()).toEqual(["seo-bet-manager", "seo-engine-ccdp"]);
    const tree = treeView(w.snapshot);
    const manager = tree.find((n) => n.task.id === "seo-bet-manager");
    expect(manager?.children.map((c) => c.task.id).sort()).toEqual([
      "approve-engine-ccdp",
      "bet-claude-code-design-prompts",
    ]);
    // Every agent action is attributable to a session.
    const agentEvents = w.events.filter((e) => e.provenance.entrance === "agent-run");
    expect(agentEvents.length).toBeGreaterThan(10);
    expect(agentEvents.every((e) => e.provenance.sessionId)).toBe(true);
    // The daily series survives as structured observations.
    expect(w.events.filter((e) => e.kind === "observation")).toHaveLength(5);
  });
});

describe("golden: zombie-loop revival", () => {
  it("done pauses the schedule, todo revives it, loudly", () => {
    let w = emptyWorld();
    const t0 = "2026-08-09T07:00:00.000Z";
    w = exec(w, { op: "create", title: "react doctor", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "mbp/claude" }, OWNER, t0);

    const off = decide({ op: "update", id: "react-doctor", patch: { status: "done" } }, w.snapshot, OWNER, t0);
    if (!off.ok) throw new Error("unreachable");
    w = foldToWorld(w, off.changeset);
    expect(tick(w.snapshot, "2026-08-20T08:00:00.000Z").changesets).toHaveLength(0); // silent while done

    // Revive to in-progress (a recurring loop's steady state — no assignment
    // dispatch, so the cron fire below is the sole run and the assertion is clean).
    const on = decide({ op: "update", id: "react-doctor", patch: { status: "in-progress" } }, w.snapshot, OWNER, "2026-08-21T09:00:00.000Z");
    if (!on.ok) throw new Error("unreachable");
    expect(on.notices.join()).toContain("re-armed");
    w = foldToWorld(w, on.changeset);
    const fired = tick(w.snapshot, "2026-08-22T07:05:00.000Z");
    const runMuts = fired.changesets.flatMap((c) => c.runs);
    expect(runMuts).toHaveLength(1); // it ticks again
    expect(runMuts[0].op === "insert" && runMuts[0].run.cause).toBe("cron");
  });
});
