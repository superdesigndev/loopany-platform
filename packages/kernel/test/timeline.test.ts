/**
 * TEAM TIMELINE projection: meaningful-by-default filtering, one-item run
 * collapse, deterministic newest-first ordering, --since/--task/--actor/--all
 * filters, bounded summaries, and the limit.
 */
import { describe, expect, it } from "vitest";
import {
  type Command,
  type Provenance,
  type World,
  decide,
  emptyWorld,
  timelineView,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const TIM: Provenance = { entrance: "human", actorId: "tim@x.co" };
const T0 = "2026-08-09T07:00:00.000Z";
const T1 = "2026-08-09T08:00:00.000Z";
const T2 = "2026-08-09T09:00:00.000Z";
const T3 = "2026-08-09T10:00:00.000Z";

function step(world: World, cmd: Command, actor: Provenance, now: string): World {
  const d = decide(cmd, world.snapshot, actor, now);
  if (!d.ok) throw new Error(`${d.refusal.code}: ${d.refusal.message}`);
  return foldToWorld(world, d.changeset);
}

/** A realistic day: a loop task, one full agent pass (claim, doc artifact,
 *  attach, status, return), a human note, and a hand-back. */
function busyWorld(): World {
  let w = emptyWorld();
  w = step(w, { op: "create", title: "seo loop", id: "seo", cron: "0 7 * * *", status: "in-progress", assignee: "mbp/claude" }, TIM, T0);
  // The cron fire + claim + agent pass (all under the run's provenance).
  const runId = "run-1";
  const AGENT: Provenance = { entrance: "agent-run", actorId: runId, sessionId: "s1" };
  // seed a pending run via the manual path? — simpler: drive the run lifecycle
  // through decide is heavy here; instead the agent writes artifacts directly
  // under its run provenance (what collapse actually keys on).
  w = step(w, { op: "doc-put", key: "seo-report-2026W33", body: "# w33", attachTask: "seo" }, AGENT, T1);
  w = step(w, { op: "note", id: "seo", note: "nothing else actionable" }, AGENT, T1);
  // A human note + a decision hand-off.
  w = step(w, { op: "note", id: "seo", note: "please prioritize the pricing page" }, TIM, T2);
  w = step(w, { op: "create", title: "decide: variant A or B", id: "decide-v", assignee: "tim@x.co" }, AGENT, T2);
  w = step(w, { op: "update", id: "decide-v", patch: { assignee: "mbp/claude", status: "todo" }, note: "ship B" }, TIM, T3);
  return w;
}

describe("timelineView", () => {
  it("collapses one run's writes into ONE item and keeps human activity as its own items", () => {
    const w = busyWorld();
    const items = timelineView(w.snapshot, w.events, {});

    // The agent pass (doc + attach + minted decision task + note) is ONE item.
    const runItems = items.filter((i) => i.runId === "run-1");
    expect(runItems).toHaveLength(1);
    expect(runItems[0]!.kind).toBe("run-activity");
    expect(runItems[0]!.summary).toContain("doc "); // doc artifact named as an artifact, not a task
    expect(runItems[0]!.summary).toContain("+decide-v"); // minted task named
    expect(runItems[0]!.eventIds.length).toBeGreaterThan(2); // drill-down preserved

    // Human note + hand-back are individually visible.
    expect(items.some((i) => i.kind === "human-note" && i.summary.includes("pricing page"))).toBe(true);
    const handoff = items.find((i) => i.kind === "handoff" && i.objectId === "decide-v");
    expect(handoff?.summary).toContain("ship B");

    // Newest first, deterministic.
    const ats = items.map((i) => i.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it("task scope keeps cross-object artifacts written by that task's run", () => {
    let w = busyWorld();
    // Associate the synthetic run provenance with its home task, as a real
    // claimed run is represented in the snapshot.
    w = {
      ...w,
      snapshot: {
        ...w.snapshot,
        runs: [{
          id: "run-1", taskId: "seo", cause: "manual", scheduledAt: T1,
          state: "done", assignee: "mbp/claude", triggerId: null, createdAt: T1,
          agentSessionId: "claude-session-opaque-123",
        }],
      },
    };
    const item = timelineView(w.snapshot, w.events, { taskId: "seo" }).find((i) => i.runId === "run-1");
    expect(item?.summary).toContain("doc seo-report-2026w33");
    expect(item?.summary).toContain("nothing else actionable");
    expect(item?.summary).not.toBe("refs");
    expect(item?.agentSessionId).toBe("claude-session-opaque-123");
    expect(item?.agent).toBe("claude");
  });

  it("hides mechanical activity by default; --all reveals it", () => {
    let w = emptyWorld();
    w = step(w, { op: "create", title: "plain", id: "plain" }, TIM, T0);
    // A version-bump-ish field edit (body tweak): mechanical.
    w = step(w, { op: "update", id: "plain", patch: { body: "tweaked" } }, TIM, T1);

    const def = timelineView(w.snapshot, w.events, {});
    expect(def.some((i) => i.kind === "mechanical")).toBe(false);
    expect(def.some((i) => i.kind === "task-created")).toBe(true);

    const all = timelineView(w.snapshot, w.events, { all: true });
    expect(all.some((i) => i.kind === "mechanical")).toBe(true);
  });

  it("a note-only agent pass (the repeated no-op check) is hidden by default", () => {
    let w = emptyWorld();
    w = step(w, { op: "create", title: "quiet loop", id: "quiet" }, TIM, T0);
    const AGENT: Provenance = { entrance: "agent-run", actorId: "run-noop", sessionId: "s" };
    w = step(w, { op: "note", id: "quiet", note: "nothing actionable" }, AGENT, T1);

    const items = timelineView(w.snapshot, w.events, {});
    expect(items.some((i) => i.runId === "run-noop")).toBe(false);
    const all = timelineView(w.snapshot, w.events, { all: true });
    expect(all.some((i) => i.runId === "run-noop" && i.kind === "mechanical")).toBe(true);
  });

  it("keeps a substantive note-only run in the default timeline", () => {
    let w = emptyWorld();
    w = step(w, { op: "create", title: "provider balances", id: "balances" }, TIM, T0);
    const AGENT: Provenance = { entrance: "agent-run", actorId: "run-diagnosis", sessionId: "claude-session" };
    w = step(w, { op: "note", id: "balances", note: "seranking: RESOLVED - subscription renewed" }, AGENT, T1);
    w = {
      ...w,
      snapshot: {
        ...w.snapshot,
        runs: [{
          id: "run-diagnosis", taskId: "balances", cause: "assignment", scheduledAt: T1,
          state: "done", assignee: "jason-mbp/claude", triggerId: null, createdAt: T1,
          agentSessionId: "claude-native-session",
        }],
      },
    };

    const item = timelineView(w.snapshot, w.events, {}).find((i) => i.runId === "run-diagnosis");
    expect(item).toMatchObject({
      kind: "run-activity",
      objectId: "balances",
      summary: "seranking: RESOLVED - subscription renewed",
      agent: "claude",
      agentSessionId: "claude-native-session",
    });
  });

  it("since/task/actor filters narrow; limit bounds; completion and blocked notes surface", () => {
    let w = busyWorld();
    // A closed-goal completion + a dispatch-blocked clock note.
    w = step(w, { op: "update", id: "decide-v", patch: { goal: "decided" } }, TIM, T3);
    w = step(w, { op: "update", id: "decide-v", patch: { status: "done" }, note: "B shipped" }, TIM, "2026-08-09T11:00:00.000Z");
    w = step(w, { op: "note", id: "seo", note: 'dispatch blocked (run run-9): no machine in this team has alias "mbp"' }, { entrance: "clock", actorId: "kernel-dispatch" }, "2026-08-09T12:00:00.000Z");

    const items = timelineView(w.snapshot, w.events, {});
    expect(items.some((i) => i.kind === "completed" && i.summary.includes("B shipped"))).toBe(true);
    expect(items.some((i) => i.kind === "blocked" && i.summary.includes("dispatch blocked"))).toBe(true);

    // --since excludes older activity.
    const late = timelineView(w.snapshot, w.events, { since: "2026-08-09T10:30:00.000Z" });
    expect(late.every((i) => i.at > "2026-08-09T10:30:00.000Z")).toBe(true);
    // --task scopes to one stream.
    const seoOnly = timelineView(w.snapshot, w.events, { taskId: "seo" });
    expect(seoOnly.every((i) => i.objectId === "seo" || i.runId !== undefined)).toBe(true);
    // --actor scopes to one writer.
    const timOnly = timelineView(w.snapshot, w.events, { actor: "tim@x.co" });
    expect(timOnly.every((i) => i.actor === "human:tim@x.co")).toBe(true);
    // limit bounds the output.
    expect(timelineView(w.snapshot, w.events, { limit: 2 })).toHaveLength(2);
  });
});
