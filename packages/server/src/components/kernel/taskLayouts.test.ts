import { describe, expect, it } from "vitest";
import { BOARD_STATUSES, hiddenTaskCount, visibleTaskTree } from "./taskLayouts";

describe("kernel web task layouts", () => {
  it("uses the active workflow columns", () => {
    expect(BOARD_STATUSES).toEqual(["todo", "in-progress", "follow-up", "done"]);
  });

  it("hides idea and archived nodes without hiding active descendants", () => {
    const child = { task: { status: "todo", id: "child" }, children: [] };
    const tree = [{ task: { status: "idea", id: "parent" }, children: [child] }];
    expect(visibleTaskTree(tree, false)).toEqual([child]);
    expect(visibleTaskTree(tree, true)).toEqual(tree);
    expect(hiddenTaskCount([{ status: "idea" }, { status: "todo" }, { status: "archived" }])).toBe(2);
  });
});
