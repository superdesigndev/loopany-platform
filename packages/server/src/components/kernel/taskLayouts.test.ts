import { describe, expect, it } from "vitest";
import { BOARD_STATUSES, hiddenTaskCount, resumeCommand, visibleTaskTree } from "./taskLayouts";

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
