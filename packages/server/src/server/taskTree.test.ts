import { describe, expect, it } from "vitest";

import { buildTaskTree, childrenOf, filterTasks, resolveRows, type TaskRow } from "./taskTree.js";

/** Minimal row factory — everything null unless overridden. */
function row(over: Partial<TaskRow> & { loopId: string }): TaskRow {
  return {
    slug: null,
    title: over.loopId,
    type: null,
    status: null,
    priority: null,
    owner: null,
    assignee: null,
    parent: null,
    follow_up_date: null,
    refs: null,
    order: null,
    cron: null,
    enabled: true,
    machineId: "m1",
    teamId: null,
    taskFile: null,
    ...over,
  };
}

const TREE: TaskRow[] = [
  row({ loopId: "l1", slug: "revenue-growth", title: "Revenue growth", type: "goal", priority: "P0" }),
  row({ loopId: "l2", slug: "acquisition", title: "Acquisition", type: "strategy", parent: "revenue-growth", priority: "P1" }),
  row({ loopId: "l3", slug: "prompt-library-seo", title: "Prompt library SEO", type: "experiment", parent: "acquisition", status: "in-progress", cron: "0 9 * * 1", priority: "P1" }),
  row({ loopId: "l4", slug: "payer-geo-ads", title: "Payer-geo ads shift", type: "task", parent: "acquisition", status: "todo", priority: "P1" }),
  row({ loopId: "l5", slug: "monetization", title: "Monetization", type: "strategy", parent: "revenue-growth", priority: "P0" }),
  row({ loopId: "l6", slug: "billing-interval", title: "Billing default interval", parent: "monetization", status: "follow-up", follow_up_date: "2026-07-01", priority: "P0" }),
  row({ loopId: "l7", slug: null, title: "Legacy loop (no front matter)", cron: "0 8 * * *" }),
];

describe("buildTaskTree", () => {
  it("builds roots (no parent / no slug) and nests children, priority band first", () => {
    const tree = buildTaskTree(TREE, { depth: 3 });
    expect(tree.map((n) => n.loopId)).toEqual(["l1", "l7"]); // P0 goal, then unprioritized legacy
    const growth = tree[0]!;
    expect(growth.children.map((c) => c.slug)).toEqual(["monetization", "acquisition"]); // P0 band before P1
    const acq = growth.children[1]!;
    expect(acq.children.map((c) => c.slug)).toEqual(["payer-geo-ads", "prompt-library-seo"]); // same band → title order
  });

  it("bounds depth and stamps childrenTruncated with the hidden count", () => {
    const tree = buildTaskTree(TREE, { depth: 1 });
    const growth = tree[0]!;
    expect(growth.children).toHaveLength(2);
    expect(growth.children[0]!.children).toEqual([]);
    expect(growth.children[0]!.childrenTruncated).toBe(1); // monetization's hidden child
  });

  it("scopes to a subtree via rootId (slug or loop id)", () => {
    const bySlug = buildTaskTree(TREE, { rootId: "acquisition", depth: 2 });
    expect(bySlug).toHaveLength(1);
    expect(bySlug[0]!.children).toHaveLength(2);
    const byId = buildTaskTree(TREE, { rootId: "l2", depth: 2 });
    expect(byId[0]!.slug).toBe("acquisition");
  });

  it("degrades a parent CYCLE to roots (never hangs, nothing disappears)", () => {
    const cyclic = [
      row({ loopId: "a", slug: "a", parent: "b" }),
      row({ loopId: "b", slug: "b", parent: "a" }),
      row({ loopId: "c", slug: "c", parent: "a" }),
    ];
    const tree = buildTaskTree(cyclic, { depth: 5 });
    const ids = new Set<string>();
    const walk = (nodes: typeof tree): void => nodes.forEach((n) => (ids.add(n.loopId), walk(n.children)));
    walk(tree);
    expect(ids).toEqual(new Set(["a", "b", "c"])); // all visible
  });

  it("treats an orphaned parent reference as a root", () => {
    const orphan = [row({ loopId: "x", slug: "x", parent: "does-not-exist" })];
    expect(buildTaskTree(orphan).map((n) => n.loopId)).toEqual(["x"]);
  });
});

describe("filterTasks", () => {
  it("filters by status with breadcrumb ancestor paths", () => {
    const out = filterTasks(TREE, { status: "follow-up" });
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe("billing-interval");
    expect(out[0]!.breadcrumb).toEqual(["Revenue growth", "Monetization"]);
  });

  it("--due = review nodes whose follow_up_date has arrived (date-only compare)", () => {
    const due = filterTasks(TREE, { due: true }, new Date("2026-07-01T05:00:00Z"));
    expect(due.map((r) => r.slug)).toEqual(["billing-interval"]);
    const notYet = filterTasks(TREE, { due: true }, new Date("2026-06-30T23:00:00Z"));
    expect(notYet).toHaveLength(0);
  });

  it("--recurring keeps only cron-bearing tasks", () => {
    expect(filterTasks(TREE, { recurring: true }).map((r) => r.loopId).sort()).toEqual(["l3", "l7"]);
  });

  it("parentId scopes to the node + all descendants", () => {
    const scoped = filterTasks(TREE, { parentId: "acquisition", status: "todo" });
    expect(scoped.map((r) => r.slug)).toEqual(["payer-geo-ads"]);
    const outside = filterTasks(TREE, { parentId: "monetization", status: "todo" });
    expect(outside).toHaveLength(0);
  });
});

describe("resolveRows / childrenOf", () => {
  it("loop id wins over slug; slug collisions return all matches", () => {
    const dup = [...TREE, row({ loopId: "l8", slug: "acquisition", title: "Dup slug" })];
    expect(resolveRows(dup, "l2").map((r) => r.loopId)).toEqual(["l2"]);
    expect(resolveRows(dup, "acquisition")).toHaveLength(2);
  });

  it("childrenOf sorts siblings by band; slug-less rows have no children", () => {
    const acq = TREE.find((r) => r.slug === "acquisition")!;
    expect(childrenOf(TREE, acq).map((c) => c.slug)).toEqual(["payer-geo-ads", "prompt-library-seo"]);
    expect(childrenOf(TREE, TREE.find((r) => r.loopId === "l7")!)).toEqual([]);
  });
});

describe("toTaskRow completedAt overlay", () => {
  // Minimal Loop shape — only the fields toTaskRow reads.
  const loop = (over: Record<string, unknown>) =>
    ({
      id: "loop-x",
      name: "Migration",
      taskMeta: { id: "migration", title: "Migration", type: "task", status: "in-progress" },
      cron: null,
      enabled: false,
      machineId: "m1",
      teamId: null,
      taskFile: null,
      completedAt: null,
      ...over,
    }) as never;

  it("a finished loop projects status done even when the README front matter lags", async () => {
    const { toTaskRow } = await import("./taskTree.js");
    // finish stamped completedAt; the file still says in-progress (the server
    // cannot write the README — sync is one-way up). The READ layer unifies.
    expect(toTaskRow(loop({ completedAt: "2026-07-24T00:00:00Z" })).status).toBe("done");
    expect(toTaskRow(loop({})).status).toBe("in-progress");
  });

  it("never fabricates done for an incomplete loop with no front matter", async () => {
    const { toTaskRow } = await import("./taskTree.js");
    expect(toTaskRow(loop({ taskMeta: null })).status).toBeNull();
    expect(toTaskRow(loop({ taskMeta: null, completedAt: "2026-07-24T00:00:00Z" })).status).toBe("done");
  });
});
