import { boardView, type KernelEvent, type Snapshot, type TaskObject } from "@loopany/kernel";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { detailViewport, KanbanView } from "../src/kanban/app.js";
import { initialKanbanState, reduceKanban } from "../src/kanban/reducer.js";

const task: TaskObject = {
  archetype: "task",
  id: "ship-it",
  title: "Ship it",
  status: "todo",
  assignee: "claude",
  owner: "owner@example.com",
  priority: "P1",
  type: "goal",
  parent: null,
  tracks: null,
  refs: [],
  followUpAt: null,
  workdir: null,
  goal: null,
  body: "Make the release safe.",
  version: 3,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};
const snapshot: Snapshot = { objects: { [task.id]: task }, triggers: [], runs: [] };
const event: KernelEvent = {
  id: "event-1",
  objectId: task.id,
  kind: "note",
  at: "2026-08-11T01:00:00.000Z",
  note: "Ready for review",
  provenance: { entrance: "human", actorId: "cli" },
};

describe("wide text + color-disabled terminals", () => {
  it("CJK titles render without crashing and stay within truncation", () => {
    const cjk: TaskObject = { ...task, id: "cjk-task", title: "每周搜索引擎优化报告与投放实验回顾" };
    const snap: Snapshot = { objects: { [cjk.id]: cjk }, triggers: [], runs: [] };
    const out = renderToString(
      <KanbanView board={boardView(snap)} state={initialKanbanState(60, 24)} events={{}} snapshot={snap} />,
    );
    expect(out).toContain("每周搜索");
    expect(out).toContain("cjk-task");
  });

  it("renders identical content with color disabled (FORCE_COLOR=0)", async () => {
    const prev = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "0";
    try {
      const out = renderToString(
        <KanbanView board={boardView(snapshot)} state={initialKanbanState(80, 24)} events={{}} snapshot={snapshot} />,
      );
      expect(out).toContain("Ship it");
      expect(out).toContain("TODO (1)");
    } finally {
      if (prev === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prev;
    }
  });
});

describe("detailLines projections", () => {
  it("the detail pane reads taskDetailView: goal, run, artifacts (tracked marker), children", async () => {
    const { detailLines } = await import("../src/kanban/app.js");
    const doc = {
      archetype: "doc" as const,
      id: "weekly-report",
      key: "weekly-report",
      title: "Weekly report",
      body: "#",
      version: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const child: TaskObject = { ...task, id: "child-bet", title: "Child bet", parent: "rich", refs: [] };
    const rich: TaskObject = {
      ...task,
      id: "rich",
      title: "Rich task",
      goal: "reach 1k subs",
      tracks: "weekly-report",
      refs: ["weekly-report"],
    };
    const snap: Snapshot = {
      objects: { rich, "child-bet": child, "weekly-report": doc },
      triggers: [],
      runs: [
        {
          id: "run-9",
          taskId: "rich",
          cause: "cron",
          scheduledAt: "2026-08-11T07:00:00.000Z",
          state: "failed",
          assignee: "mbp/claude",
          triggerId: null,
          createdAt: "2026-08-11T07:00:00.000Z",
          note: "boom",
        },
      ],
    };
    const lines = detailLines(rich, [], 80, snap).join("\n");
    expect(lines).toContain("goal (finish line): reach 1k subs");
    expect(lines).toContain("run run-9: failed - boom");
    expect(lines).toContain("Artifacts");
    expect(lines).toContain("doc weekly-report  Weekly report  (tracked)");
    expect(lines).toContain("Children");
    expect(lines).toContain("child-bet  [todo]  Child bet");
    // Without a snapshot the pane degrades to the plain fields (old behavior).
    expect(detailLines(rich, [], 80).join("\n")).not.toContain("Artifacts");
  });
});

describe("KanbanView", () => {
  const board = boardView(snapshot);
  const events = { [task.id]: [event] };

  it("renders status columns and the active card", () => {
    const state = initialKanbanState(132, 30);
    const frame = renderToString(<KanbanView board={board} state={state} events={events} />, { columns: 132 });
    expect(frame).toContain("TODO (1)");
    expect(frame).toContain("Ship it");
    expect(frame).toContain("@claude");
  });

  it("renders task fields and Backend events in detail", () => {
    let state = initialKanbanState();
    state = reduceKanban(state, { type: "open" }, board);
    const frame = renderToString(<KanbanView board={board} state={state} events={events} />);
    expect(frame).toContain("Make the release safe.");
    expect(frame).toContain("Recent activity");
    expect(frame).toContain("Ready for review");
  });

  it("renders only whole cards that fit the terminal height", () => {
    const objects = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => {
        const item = {
          ...task,
          id: `bulk-${index}`,
          title: `Bulk ${index}`,
          createdAt: `2026-08-11T00:00:0${index}.000Z`,
        };
        return [item.id, item];
      }),
    );
    const crowded = boardView({ objects, triggers: [], runs: [] });
    const state = initialKanbanState(132, 13);
    const frame = renderToString(<KanbanView board={crowded} state={state} events={{}} />, { columns: 132 });
    expect(frame).toContain("Bulk 0");
    expect(frame).not.toContain("Bulk 1");
  });

  it("clips long detail content and renders a scroll position", () => {
    const longTask = {
      ...task,
      body: Array.from({ length: 12 }, (_, index) => `Body line ${String(index).padStart(2, "0")}`).join("\n"),
    };
    const longBoard = boardView({ objects: { [longTask.id]: longTask }, triggers: [], runs: [] });
    let state = initialKanbanState(80, 8);
    state = reduceKanban(state, { type: "open" }, longBoard);

    const first = renderToString(<KanbanView board={longBoard} state={state} events={{}} />);
    expect(first).toContain("Body line 00");
    expect(first).not.toContain("Body line 01");

    const viewport = detailViewport(longTask, [], state);
    state = reduceKanban(
      state,
      { type: "scroll", offset: 6, maxOffset: viewport.maxOffset },
      longBoard,
    );
    const scrolled = renderToString(<KanbanView board={longBoard} state={state} events={{}} />);
    expect(scrolled).not.toContain("Body line 00");
    expect(scrolled).toContain("Body line 01");
    expect(scrolled).toContain("7-12 of 20");
    expect(scrolled).not.toContain("Body line 07");
  });
});
