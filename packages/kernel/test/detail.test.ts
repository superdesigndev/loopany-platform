/**
 * TASK DETAIL + LOOPS projections (kernel-product-visibility): products resolve
 * from tracks+refs (latest key doc findable WITHOUT raw events), children and
 * the run pair ride along; loopsView derives last result + the blocked note.
 */
import { describe, expect, it } from "vitest";
import {
  type Command,
  type Provenance,
  type World,
  decide,
  emptyWorld,
  loopsView,
  taskDetailView,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const TIM: Provenance = { entrance: "human", actorId: "tim@x.co" };
const T0 = "2026-08-09T07:00:00.000Z";
const T1 = "2026-08-09T08:00:00.000Z";

function step(world: World, cmd: Command, actor: Provenance = TIM, now = T0): World {
  const d = decide(cmd, world.snapshot, actor, now);
  if (!d.ok) throw new Error(`${d.refusal.code}: ${d.refusal.message}`);
  return foldToWorld(world, d.changeset);
}

describe("taskDetailView", () => {
  it("resolves products from tracks (first) + refs, lists children, finds the run pair", () => {
    let w = emptyWorld();
    w = step(w, { op: "create", title: "seo loop", id: "seo", cron: "0 7 * * *", status: "in-progress", assignee: "mbp/claude" });
    const AGENT: Provenance = { entrance: "agent-run", actorId: "run-1" };
    w = step(w, { op: "doc-put", key: "seo-portfolio", body: "# window", attachTask: "seo" }, AGENT, T1);
    w = step(w, { op: "doc-put", key: "seo-report-2026W33", body: "# w33", attachTask: "seo" }, AGENT, T1);
    w = step(w, { op: "update", id: "seo", patch: { tracks: "seo-portfolio" } }, TIM, T1);
    w = step(w, { op: "create", title: "child bet", id: "bet-child", parent: "seo" }, AGENT, T1);

    const d = taskDetailView(w.snapshot, "seo", w.events)!;
    expect(d.task.id).toBe("seo");
    // tracks FIRST, then the refs docs, deduped.
    expect(d.products[0]!.product.id).toBe("seo-portfolio");
    expect(d.products.map((p) => p.product.id)).toContain("seo-report-2026w33");
    // PRODUCER PROVENANCE joins the product's creating event - traceable to the
    // run + session without renderers re-reading raw events.
    expect(d.products[0]!.producedBy).toMatchObject({ actor: "agent-run:run-1", runId: "run-1" });
    // The COHERENT recent-activity view is the task-scoped timeline projection.
    expect(d.recent.length).toBeGreaterThan(0);
    expect(d.recent.every((i) => typeof i.summary === "string")).toBe(true);
    expect(d.children.map((c) => c.id)).toEqual(["bet-child"]);
    // Non-task / unknown ids never crash it.
    expect(taskDetailView(w.snapshot, "seo-portfolio")).toBeNull();
    expect(taskDetailView(w.snapshot, "ghost")).toBeNull();
  });
});

describe("loopsView last result + blocked note", () => {
  it("carries the last settled run and surfaces the dispatcher blocked note for a stuck pending run", () => {
    let w = emptyWorld();
    w = step(w, { op: "create", title: "loopy", id: "loopy", cron: "0 7 * * *", status: "in-progress", assignee: "mbp/claude" });
    // A stuck pending run + the blocked note the dispatcher records.
    w = step(w, { op: "run", id: "loopy" }, TIM, T1);
    const runId = w.snapshot.runs[0]!.id;
    w = step(
      w,
      { op: "note", id: "loopy", note: `dispatch blocked (run ${runId}): no machine in this team has alias "mbp"` },
      { entrance: "clock", actorId: "kernel-dispatch" },
      T1,
    );

    const rows = loopsView(w.snapshot, w.events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blockedNote).toContain("no machine in this team");
    // Without events the derivation stands down (null, never wrong).
    expect(loopsView(w.snapshot)[0]!.blockedNote).toBeNull();

    // MACHINE AVAILABILITY rides a presence map keyed by the assignee's machine
    // segment; absent map / unknown alias = null, never a guess.
    expect(loopsView(w.snapshot, w.events, { mbp: "offline" })[0]!.machinePresence).toBe("offline");
    expect(loopsView(w.snapshot, w.events, { other: "online" })[0]!.machinePresence).toBeNull();
    expect(rows[0]!.machinePresence).toBeNull();
  });
});
