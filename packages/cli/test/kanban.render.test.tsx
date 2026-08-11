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

describe("KanbanView", () => {
  const board = boardView(snapshot);
  const events = { [task.id]: [event] };

  it("renders status columns and the active card", () => {
    const state = reduceKanban(initialKanbanState(132, 30), { type: "right" }, board);
    const frame = renderToString(<KanbanView board={board} state={state} events={events} />, { columns: 132 });
    expect(frame).toContain("TODO (1)");
    expect(frame).toContain("Ship it");
    expect(frame).toContain("@claude");
  });

  it("renders task fields and Backend events in detail", () => {
    let state = reduceKanban(initialKanbanState(), { type: "right" }, board);
    state = reduceKanban(state, { type: "open" }, board);
    const frame = renderToString(<KanbanView board={board} state={state} events={events} />);
    expect(frame).toContain("Make the release safe.");
    expect(frame).toContain("Recent events");
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
    const state = reduceKanban(initialKanbanState(132, 13), { type: "right" }, crowded);
    const frame = renderToString(<KanbanView board={crowded} state={state} events={{}} />, { columns: 132 });
    expect(frame).toContain("Bulk 0");
    expect(frame).toContain("Bulk 1");
    expect(frame).not.toContain("Bulk 2");
  });

  it("clips long detail content and renders a scroll position", () => {
    const longTask = {
      ...task,
      body: Array.from({ length: 12 }, (_, index) => `Body line ${String(index).padStart(2, "0")}`).join("\n"),
    };
    const longBoard = boardView({ objects: { [longTask.id]: longTask }, triggers: [], runs: [] });
    let state = reduceKanban(initialKanbanState(80, 8), { type: "right" }, longBoard);
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
