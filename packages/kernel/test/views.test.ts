import { describe, expect, it } from "vitest";
import {
  type Command,
  type Provenance,
  type TaskObject,
  decide,
  emptyWorld,
  boardView,
  inboxView,
  loopsView,
  treeView,
  type World,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const HUMAN: Provenance = { entrance: "human", actorId: "u" };
const T0 = "2026-08-09T07:00:00.000Z";

function seed(...cmds: Command[]): World {
  let world = emptyWorld();
  for (const cmd of cmds) {
    const d = decide(cmd, world.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error(`seed refused: ${d.refusal.message}`);
    world = foldToWorld(world, d.changeset);
  }
  return world;
}

describe("treeView", () => {
  it("builds roots-first with P-then-age sibling order", () => {
    const w = seed(
      { op: "create", title: "root" },
      { op: "create", title: "late-p0", parent: "root", priority: "P0" },
      { op: "create", title: "early-p2", parent: "root", priority: "P2" },
    );
    const tree = treeView(w.snapshot);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.task.id)).toEqual(["late-p0", "early-p2"]);
  });

  it("renders a hand-broken parent cycle as roots instead of hanging", () => {
    const w = seed({ op: "create", title: "a" }, { op: "create", title: "b", parent: "a" });
    const broken = {
      ...w.snapshot,
      objects: {
        ...w.snapshot.objects,
        a: { ...(w.snapshot.objects["a"] as TaskObject), parent: "b" },
      },
    };
    const tree = treeView(broken);
    expect(tree.length).toBeGreaterThan(0); // terminates, surfaces the cycle members
  });
});

describe("inboxView", () => {
  it("my assigned work plus expired-but-unticked waits; terminal excluded", () => {
    const w = seed(
      { op: "create", title: "mine", assignee: "me@x.com" },
      { op: "create", title: "not-mine", assignee: "you@x.com" },
      { op: "create", title: "done-one", assignee: "me@x.com", status: "done" },
      { op: "create", title: "due-wait", followUpAt: "2026-08-08T00:00:00.000Z" },
    );
    const items = inboxView(w.snapshot, "me@x.com", T0);
    expect(items.map((i) => `${i.task.id}:${i.reason}`).sort()).toEqual([
      "due-wait:due",
      "mine:assigned",
    ]);
  });
});

describe("loopsView / boardView", () => {
  it("a loop is exactly a task with a cron trigger", () => {
    const w = seed(
      { op: "create", title: "loop", cron: "0 7 * * *", status: "in-progress" },
      { op: "create", title: "plain" },
    );
    const loops = loopsView(w.snapshot);
    expect(loops.map((l) => l.task.id)).toEqual(["loop"]);
    expect(loops[0].trigger.spec).toBe("0 7 * * *");
    const board = boardView(w.snapshot);
    expect(board["todo"].map((t) => t.id)).toEqual(["plain"]);
    expect(board["in-progress"].map((t) => t.id)).toEqual(["loop"]);
  });
});
