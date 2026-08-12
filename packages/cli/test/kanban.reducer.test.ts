import { TASK_STATUSES, boardView, type Snapshot, type TaskObject } from "@loopany/kernel";
import { describe, expect, it } from "vitest";
import {
  filterBoard,
  ACTIVE_STATUSES,
  activeStatus,
  initialKanbanState,
  kanbanInputIntent,
  reduceKanban,
  visibleCardWindow,
  visibleColumnIndexes,
} from "../src/kanban/reducer.js";

function task(id: string, status: TaskObject["status"], priority = "P2"): TaskObject {
  return {
    archetype: "task",
    id,
    title: `Task ${id}`,
    status,
    assignee: null,
    owner: null,
    priority,
    type: null,
    parent: null,
    tracks: null,
    refs: [],
    followUpAt: null,
    workdir: null,
    goal: null,
    body: "",
    version: 1,
    createdAt: `2026-08-11T00:00:0${id.length}.000Z`,
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

const snapshot: Snapshot = {
  objects: {
    first: task("first", "todo", "P1"),
    second: task("second", "todo", "P2"),
    doing: task("doing", "in-progress"),
  },
  triggers: [],
  runs: [],
};

describe("kanban reducer", () => {
  const board = boardView(snapshot);

  it("navigates columns/cards and enters then leaves detail", () => {
    let state = initialKanbanState();
    expect(activeStatus(state)).toBe("todo");
    state = reduceKanban(state, { type: "down" }, board);
    expect(state.selected.todo).toBe(1);
    state = reduceKanban(state, { type: "open" }, board);
    expect(state.detailId).toBe("second");
    expect(reduceKanban(state, { type: "right" }, board)).toBe(state);
    state = reduceKanban(state, { type: "scroll", offset: 99, maxOffset: 4 }, board);
    expect(state.detailOffset).toBe(4);
    state = reduceKanban(state, { type: "scroll", offset: -1, maxOffset: 4 }, board);
    expect(state.detailOffset).toBe(0);
    state = reduceKanban(state, { type: "back" }, board);
    expect(state.detailId).toBeNull();
    expect(state.detailOffset).toBe(0);
  });

  it("clamps every edge and derives a resize-aware column window (ACTIVE columns by default, f reveals all)", () => {
    let state = initialKanbanState(44, 20);
    state = reduceKanban(state, { type: "left" }, board);
    expect(state.column).toBe(0);
    // The DEFAULT strip is actionable work - idea/done/archived stay behind f.
    for (let index = 0; index < 20; index += 1) state = reduceKanban(state, { type: "right" }, board);
    expect(state.column).toBe(ACTIVE_STATUSES.length - 1);
    // f reveals all six; navigation then reaches the terminal columns.
    state = reduceKanban(state, { type: "toggle-all" }, board);
    for (let index = 0; index < 20; index += 1) state = reduceKanban(state, { type: "right" }, board);
    expect(state.column).toBe(TASK_STATUSES.length - 1);
    expect(visibleColumnIndexes(state)).toEqual([4, 5]);
    state = reduceKanban(state, { type: "resize", width: 200, height: 0 }, board);
    expect(visibleColumnIndexes(state)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(state.height).toBe(1);
    // Toggling BACK clamps the cursor into the shorter strip.
    state = reduceKanban(state, { type: "toggle-all" }, board);
    expect(state.column).toBe(ACTIVE_STATUSES.length - 1);
  });

  it("slash search: captures input, commits, filters the board, Esc clears", () => {
    let state = initialKanbanState(80, 24);
    expect(kanbanInputIntent(state, "/", {})).toEqual({ type: "search-start" });
    state = reduceKanban(state, { type: "search-start" }, board);
    expect(state.searching).toBe(true);
    for (const ch of "task") state = reduceKanban(state, { type: "search-input", ch }, board);
    expect(kanbanInputIntent(state, "", { return: true })).toEqual({ type: "search-commit" });
    state = reduceKanban(state, { type: "search-commit" }, board);
    expect(state).toMatchObject({ searching: false, query: "task" });

    const filtered = filterBoard(board, state.query);
    const all = Object.values(filtered).flat();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((t) => `${t.id} ${t.title}`.toLowerCase().includes("task"))).toBe(true);

    // Esc on the board clears an active filter before exiting.
    expect(kanbanInputIntent(state, "", { escape: true })).toEqual({ type: "search-clear" });
    state = reduceKanban(state, { type: "search-clear" }, board);
    expect(state.query).toBe("");
    expect(kanbanInputIntent(state, "", { escape: true })).toBe("exit");
  });

  it("budgets bordered cards by their five rendered rows", () => {
    let state = initialKanbanState(80, 13);
    state = reduceKanban(state, { type: "right" }, board);
    expect(visibleCardWindow(state, 10)).toEqual({ start: 0, end: 1, capacity: 1 });
    state = reduceKanban(state, { type: "resize", width: 80, height: 7 }, board);
    expect(visibleCardWindow(state, 10)).toEqual({ start: 0, end: 0, capacity: 0 });
  });

  it("maps q and board Esc to exit while detail Esc returns and j/k scroll", () => {
    let state = initialKanbanState();
    expect(kanbanInputIntent(state, "q", {})).toBe("exit");
    expect(kanbanInputIntent(state, "", { escape: true })).toBe("exit");

    state = reduceKanban(state, { type: "open" }, board);
    expect(kanbanInputIntent(state, "", { escape: true })).toEqual({ type: "back" });
    expect(kanbanInputIntent(state, "j", {}, { offset: 2, maxOffset: 4 })).toEqual({
      type: "scroll",
      offset: 3,
      maxOffset: 4,
    });
    expect(kanbanInputIntent(state, "", { upArrow: true }, { offset: 2, maxOffset: 4 })).toEqual({
      type: "scroll",
      offset: 1,
      maxOffset: 4,
    });
  });

  it("hides idea by default and opens a task directly from another projection", () => {
    const state = initialKanbanState();
    expect(ACTIVE_STATUSES).toEqual(["todo", "in-progress", "follow-up"]);
    expect(reduceKanban(state, { type: "open-id", id: "doing" }, board).detailId).toBe("doing");
  });
});
