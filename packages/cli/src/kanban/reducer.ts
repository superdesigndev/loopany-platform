import { TASK_STATUSES, type TaskObject, type TaskStatus } from "@loopany/kernel";

export type KanbanBoard = Readonly<Record<TaskStatus, readonly TaskObject[]>>;

export interface KanbanState {
  column: number;
  selected: Record<TaskStatus, number>;
  detailId: string | null;
  detailOffset: number;
  width: number;
  height: number;
  /** `/` search: the committed filter (id/title substring, case-insensitive). */
  query: string;
  /** True while the `/` input line is capturing keystrokes. */
  searching: boolean;
  /** `f` filter toggle: false (default) = actionable columns; true = all six. */
  showAll: boolean;
}

/** The default board is actionable work. Ideas are a backlog, not an execution
 *  lane, so idea/done/archived stay behind `f`. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ["todo", "in-progress", "follow-up"];

export function visibleStatuses(state: KanbanState): readonly TaskStatus[] {
  return state.showAll ? TASK_STATUSES : ACTIVE_STATUSES;
}

/** Filter a board by the committed query (id/title substring, case-insensitive).
 *  Pure - the underlying board projection is never mutated. */
export function filterBoard(board: KanbanBoard, query: string): KanbanBoard {
  const q = query.trim().toLowerCase();
  if (!q) return board;
  return Object.fromEntries(
    Object.entries(board).map(([status, tasks]) => [
      status,
      tasks.filter((t) => t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)),
    ]),
  ) as unknown as KanbanBoard;
}

export type KanbanAction =
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "open" }
  | { type: "open-id"; id: string }
  | { type: "select-id"; id: string | null; board: KanbanBoard }
  | { type: "back" }
  | { type: "scroll"; offset: number; maxOffset: number }
  | { type: "resize"; width: number; height: number }
  | { type: "search-start" }
  | { type: "search-input"; ch: string }
  | { type: "search-backspace" }
  | { type: "search-commit" }
  | { type: "search-clear" }
  | { type: "toggle-all" };

export interface KanbanKey {
  escape?: boolean;
  return?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export type KanbanInputIntent = KanbanAction | "exit" | null;

/** Pure input mapping keeps board exit and detail back/scroll semantics testable. */
export function kanbanInputIntent(
  state: KanbanState,
  input: string,
  key: KanbanKey,
  detail?: { offset: number; maxOffset: number },
): KanbanInputIntent {
  // `/` search input mode captures every keystroke until commit/cancel.
  if (state.searching) {
    if (key.escape) return { type: "search-clear" };
    if (key.return) return { type: "search-commit" };
    if (key.backspace || key.delete) return { type: "search-backspace" };
    if (input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      return { type: "search-input", ch: input };
    }
    return null;
  }
  if (input === "q") return "exit";
  if (key.escape) {
    if (state.detailId !== null) return { type: "back" };
    if (state.query) return { type: "search-clear" }; // Esc clears an active filter first
    return "exit";
  }
  if (state.detailId === null && input === "/") return { type: "search-start" };
  if (state.detailId === null && input === "f") return { type: "toggle-all" };
  if (state.detailId !== null) {
    if (!detail) return null;
    if (input === "k" || key.upArrow) {
      return { type: "scroll", offset: detail.offset - 1, maxOffset: detail.maxOffset };
    }
    if (input === "j" || key.downArrow) {
      return { type: "scroll", offset: detail.offset + 1, maxOffset: detail.maxOffset };
    }
    return null;
  }
  if (key.return) return { type: "open" };
  if (input === "h" || key.leftArrow) return { type: "left" };
  if (input === "l" || key.rightArrow) return { type: "right" };
  if (input === "k" || key.upArrow) return { type: "up" };
  if (input === "j" || key.downArrow) return { type: "down" };
  return null;
}

function emptySelection(): Record<TaskStatus, number> {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >;
}

export function initialKanbanState(width = 80, height = 24): KanbanState {
  return {
    column: 0,
    selected: emptySelection(),
    detailId: null,
    detailOffset: 0,
    width: Math.max(1, width),
    height: Math.max(1, height),
    query: "",
    searching: false,
    showAll: false,
  };
}

export function activeStatus(state: KanbanState): TaskStatus {
  const statuses = visibleStatuses(state);
  return statuses[state.column] ?? statuses[0]!;
}

export function activeTask(state: KanbanState, board: KanbanBoard): TaskObject | undefined {
  const status = activeStatus(state);
  return board[status][state.selected[status]];
}

/** Pure keyboard/resize transition. The board is a projection, never mutated. */
export function reduceKanban(
  state: KanbanState,
  action: KanbanAction,
  board: KanbanBoard,
): KanbanState {
  if (action.type === "resize") {
    return {
      ...state,
      width: Math.max(1, action.width),
      height: Math.max(1, action.height),
    };
  }
  if (action.type === "back") {
    return state.detailId === null ? state : { ...state, detailId: null, detailOffset: 0 };
  }
  if (action.type === "scroll") {
    if (state.detailId === null) return state;
    return {
      ...state,
      detailOffset: Math.max(0, Math.min(action.maxOffset, action.offset)),
    };
  }
  if (action.type === "search-start") return { ...state, searching: true };
  if (action.type === "search-input") return { ...state, query: state.query + action.ch };
  if (action.type === "search-backspace") return { ...state, query: state.query.slice(0, -1) };
  if (action.type === "search-commit") return { ...state, searching: false };
  if (action.type === "search-clear") return { ...state, searching: false, query: "" };
  if (action.type === "toggle-all") {
    // Clamp the column into the new strip so f never strands the cursor.
    const next = { ...state, showAll: !state.showAll };
    return { ...next, column: Math.min(next.column, visibleStatuses(next).length - 1) };
  }
  if (action.type === "open-id") return { ...state, detailId: action.id, detailOffset: 0 };
  if (action.type === "select-id") {
    if (state.detailId !== null && !Object.values(action.board).flat().some((task) => task.id === state.detailId)) {
      return { ...state, detailId: null, detailOffset: 0 };
    }
    if (!action.id) return state;
    for (const [column, status] of visibleStatuses(state).entries()) {
      const selected = action.board[status].findIndex((task) => task.id === action.id);
      if (selected >= 0) return { ...state, column, selected: { ...state.selected, [status]: selected } };
    }
    return state;
  }
  if (state.detailId !== null) return state;

  if (action.type === "left" || action.type === "right") {
    const delta = action.type === "left" ? -1 : 1;
    return {
      ...state,
      column: Math.max(0, Math.min(visibleStatuses(state).length - 1, state.column + delta)),
    };
  }

  const status = activeStatus(state);
  const cards = board[status];
  if (action.type === "up" || action.type === "down") {
    const delta = action.type === "up" ? -1 : 1;
    const next = Math.max(0, Math.min(Math.max(0, cards.length - 1), state.selected[status] + delta));
    return { ...state, selected: { ...state.selected, [status]: next } };
  }
  if (action.type === "open") {
    const task = activeTask(state, board);
    return task ? { ...state, detailId: task.id, detailOffset: 0 } : state;
  }
  return state;
}

export const MIN_COLUMN_WIDTH = 22;
export const CARD_HEIGHT = 5;
export const BOARD_CHROME_ROWS = 5;

/** Status columns that fit in the current terminal, centered around selection. */
export function visibleColumnIndexes(state: KanbanState): number[] {
  const total = visibleStatuses(state).length;
  const count = Math.max(1, Math.min(total, Math.floor(state.width / MIN_COLUMN_WIDTH)));
  const maxStart = total - count;
  const start = Math.max(0, Math.min(maxStart, state.column - Math.floor(count / 2)));
  return Array.from({ length: count }, (_, index) => start + index);
}

export interface CardWindow {
  start: number;
  end: number;
  capacity: number;
}

/** Each bordered card occupies five terminal rows: two borders + three text rows. */
export function visibleCardWindow(
  state: KanbanState,
  taskCount: number,
  selected = state.selected[activeStatus(state)],
): CardWindow {
  const capacity = Math.max(0, Math.floor((state.height - BOARD_CHROME_ROWS) / CARD_HEIGHT));
  if (capacity === 0 || taskCount === 0) return { start: 0, end: 0, capacity };
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(capacity / 2), Math.max(0, taskCount - capacity)),
  );
  return { start, end: Math.min(taskCount, start + capacity), capacity };
}
