import { describe, expect, it } from "vitest";
import { BOARD_STATUSES, filterTaskTree, hiddenTaskCount, resumeCommand, visibleTaskTree } from "./taskLayouts";

describe("kernel web task layouts", () => {
  it("uses the active workflow columns", () => {
    expect(BOARD_STATUSES).toEqual(["todo", "in-progress", "follow-up", "done"]);
  });

  it("hides idea, done, and archived nodes without hiding active descendants", () => {
    const child = { task: { status: "todo", id: "child" }, children: [] };
    const doneParent = { task: { status: "done", id: "done-parent" }, children: [child] };
    const tree = [{ task: { status: "idea", id: "parent" }, children: [doneParent] }];
    expect(visibleTaskTree(tree, false)).toEqual([child]);
    expect(visibleTaskTree(tree, true)).toEqual(tree);
    expect(hiddenTaskCount([{ status: "idea" }, { status: "todo" }, { status: "done" }, { status: "archived" }])).toBe(3);
  });

  it("keeps non-matching ancestors as context for matching descendants", () => {
    const tree = [{
      task: { id: "parent", title: "Parent", status: "done", owner: "person:one" },
      children: [{ task: { id: "child", title: "Fix daemon", status: "todo", owner: "person:two" }, children: [] }],
    }];
    expect(filterTaskTree(tree, { query: "daemon", owner: "person:two", statuses: ["todo"] })).toEqual([{
      ...tree[0],
      contextOnly: true,
      children: [{ ...tree[0]!.children[0], contextOnly: false }],
    }]);
  });

  it("supports unowned and arbitrary status combinations", () => {
    const tree = [
      { task: { id: "idea", title: "Idea", status: "idea", owner: null }, children: [] },
      { task: { id: "done", title: "Done", status: "done", owner: null }, children: [] },
      { task: { id: "owned", title: "Owned", status: "todo", owner: "person:one" }, children: [] },
    ];
    expect(filterTaskTree(tree, { query: "", owner: "unowned", statuses: ["idea", "done"] }).map((node) => node.task.id)).toEqual(["idea", "done"]);
  });

  it("resumes an agent session from its task workdir with shell-safe values", () => {
    expect(resumeCommand("claude", "session-1", "/Users/tim/My Project")).toBe(
      "cd -- '/Users/tim/My Project' && claude --resume 'session-1'",
    );
    expect(resumeCommand("codex", "session'2", "/tmp/tim's repo")).toBe(
      `cd -- '/tmp/tim'"'"'s repo' && codex resume 'session'"'"'2'`,
    );
    expect(resumeCommand("claude", "session-3")).toBe("claude --resume 'session-3'");
  });
});
