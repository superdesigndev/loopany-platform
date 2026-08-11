import { TASK_STATUSES, type TaskObject, type TaskStatus } from "@loopany/kernel";

export type KanbanBoard = Readonly<Record<TaskStatus, readonly TaskObject[]>>;

export interface KanbanState {
  column: number;
  selected: Record<TaskStatus, number>;
  detailId: string | null;
  detailOffset: number;
  width: number;
  height: number;
}

export type KanbanAction =
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "open" }
  | { type: "back" }
  | { type: "scroll"; offset: number; maxOffset: number }
  | { type: "resize"; width: number; height: number };

export interface KanbanKey {
  escape?: boolean;
  return?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export type KanbanInputIntent = KanbanAction | "exit" | null;

/** Pure input mapping keeps board exit and detail back/scroll semantics testable. */
export function kanbanInputIntent(
  state: KanbanState,
  input: string,
  key: KanbanKey,
  detail?: { offset: number; maxOffset: number },
): KanbanInputIntent {
  if (input === "q") return "exit";
  if (key.escape) return state.detailId === null ? "exit" : { type: "back" };
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
  };
}

export function activeStatus(state: KanbanState): TaskStatus {
  return TASK_STATUSES[state.column] ?? TASK_STATUSES[0];
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
  if (state.detailId !== null) return state;

  if (action.type === "left" || action.type === "right") {
    const delta = action.type === "left" ? -1 : 1;
    return {
      ...state,
      column: Math.max(0, Math.min(TASK_STATUSES.length - 1, state.column + delta)),
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
export const BOARD_CHROME_ROWS = 3;

/** Status columns that fit in the current terminal, centered around selection. */
export function visibleColumnIndexes(state: KanbanState): number[] {
  const count = Math.max(1, Math.min(TASK_STATUSES.length, Math.floor(state.width / MIN_COLUMN_WIDTH)));
  const maxStart = TASK_STATUSES.length - count;
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
