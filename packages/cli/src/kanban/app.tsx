import {
  Box,
  Text,
  render,
  useApp,
  useInput,
  useWindowSize,
  type RenderOptions,
} from "ink";
import React, { useEffect, useMemo, useReducer } from "react";
import {
  TASK_STATUSES,
  type KernelEvent,
  type Snapshot,
  type TaskObject,
  boardView,
  taskDetailView,
} from "@loopany/kernel";
import { handbackTargetFor } from "../prompt.js";
import stringWidth from "string-width";
import type { Backend } from "../backend.js";
import {
  visibleStatuses,
  filterBoard,
  activeStatus,
  initialKanbanState,
  kanbanInputIntent,
  reduceKanban,
  visibleCardWindow,
  visibleColumnIndexes,
  type KanbanBoard,
  type KanbanState,
} from "./reducer.js";

export interface KanbanViewProps {
  board: KanbanBoard;
  state: KanbanState;
  events: Readonly<Record<string, readonly KernelEvent[]>>;
  snapshot?: Snapshot;
}

function priorityColor(priority: string | null): "red" | "yellow" | "cyan" | undefined {
  if (priority === "P0") return "red";
  if (priority === "P1") return "yellow";
  if (priority === "P2") return "cyan";
  return undefined;
}

/** Compact card indicator strip (review round 3): due date, recent-activity
 *  age, and the failure/active/product markers - pure over the snapshot so the
 *  render tests pin it. */
export function cardIndicators(task: TaskObject, snapshot?: Snapshot, nowMs = Date.now()): string {
  const bits: string[] = [];
  if (task.followUpAt) bits.push(`due ${task.followUpAt.slice(0, 10)}`);
  const ageMin = Math.max(0, Math.floor((nowMs - Date.parse(task.updatedAt)) / 60_000));
  bits.push(ageMin < 60 ? `${ageMin}m` : ageMin < 60 * 48 ? `${Math.floor(ageMin / 60)}h` : `${Math.floor(ageMin / 1440)}d`);
  if (snapshot) {
    const runs = snapshot.runs.filter((r) => r.taskId === task.id);
    if (runs.some((r) => r.state === "pending" || r.state === "claimed" || r.state === "running")) bits.push("▶");
    else if (runs.length > 0) {
      const last = runs.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      if (last.state === "failed") bits.push("✖ failed");
    }
  }
  const products = [task.tracks, ...task.refs].filter(Boolean).length;
  if (products > 0) bits.push(`◆${products}`);
  return bits.join("  ");
}

function Card({ task, active, snapshot }: { task: TaskObject; active: boolean; snapshot?: Snapshot }) {
  return (
    <Box flexDirection="column" paddingX={1} borderStyle={active ? "bold" : "single"}>
      <Text bold={active} inverse={active} wrap="truncate-end">
        {active ? "> " : "  "}{task.title}
      </Text>
      <Text dimColor={!active} wrap="truncate-end">
        <Text color={priorityColor(task.priority)}>{task.priority ?? "--"}</Text>
        {`  ${task.id}  @${task.assignee ?? "unassigned"}`}
      </Text>
      <Text dimColor wrap="truncate-end">{cardIndicators(task, snapshot)}</Text>
    </Box>
  );
}

function Board({ board, state, snapshot }: Omit<KanbanViewProps, "events">) {
  const indexes = visibleColumnIndexes(state);
  const statuses = visibleStatuses(state);
  return (
    <Box flexDirection="column">
      <Box height={1} justifyContent="space-between">
        <Text bold color="cyan" wrap="truncate-end">Loopany Kanban</Text>
        <Text dimColor wrap="truncate-end">h/l columns  j/k cards  Enter details  / search  f all-columns  q quit</Text>
      </Box>
      {state.searching || state.query ? (
        <Text wrap="truncate-end">
          {state.searching ? `/${state.query}▏  (Enter apply · Esc cancel)` : `filter: "${state.query}"  (Esc clears)`}
        </Text>
      ) : null}
      <Box>
        {indexes.map((columnIndex) => {
          const status = statuses[columnIndex]!;
          const tasks = board[status];
          const selected = state.selected[status];
          const window = visibleCardWindow(state, tasks.length, selected);
          return (
            <Box
              key={status}
              width={`${100 / indexes.length}%`}
              minWidth={20}
              flexDirection="column"
              paddingRight={columnIndex === indexes.at(-1) ? 0 : 1}
            >
              <Text bold={columnIndex === state.column} color={columnIndex === state.column ? "cyan" : undefined}>
                {status.toUpperCase()} ({tasks.length})
              </Text>
              {tasks.length === 0 ? <Text dimColor>(empty)</Text> : null}
              {tasks.length > 0 && window.capacity === 0 ? <Text dimColor>(grow terminal to show cards)</Text> : null}
              {tasks.slice(window.start, window.end).map((task, localIndex) => (
                <Card
                  key={task.id}
                  task={task}
                  snapshot={snapshot}
                  active={columnIndex === state.column && window.start + localIndex === selected}
                />
              ))}
            </Box>
          );
        })}
      </Box>
      {indexes.length < statuses.length || !state.showAll ? (
        <Text dimColor>
          {`Showing ${indexes[0]! + 1}-${indexes.at(-1)! + 1} of ${statuses.length}${state.showAll ? "" : " active"} columns${state.showAll ? "" : "  ·  f shows done/archived"}`}
        </Text>
      ) : null}
    </Box>
  );
}

function wrapPlainText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return value.split("\n").flatMap((rawLine) => {
    if (rawLine.length === 0) return [""];
    const lines: string[] = [];
    let line = "";
    let used = 0;
    for (const character of rawLine) {
      const characterWidth = stringWidth(character);
      if (line && used + characterWidth > safeWidth) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += character;
      used += characterWidth;
    }
    if (line) lines.push(line);
    return lines;
  });
}

export function detailLines(
  task: TaskObject,
  events: readonly KernelEvent[],
  width: number,
  snapshot?: Snapshot,
): string[] {
  const recent = events.slice(-6).reverse();
  // The Task Detail projection (kernel-product-visibility): products from
  // tracks+refs, children, and the run pair - same taskDetailView every other
  // surface reads, so the TUI cannot drift from show/loops.
  const detail = snapshot ? taskDetailView(snapshot, task.id, events) : null;
  const run = detail?.activeRun ?? detail?.lastRun ?? null;
  // Human-held task: surface the derived default hand-back agent so the human
  // never needs to know a machine/profile address (review round 3).
  const handback =
    snapshot && task.assignee !== null && !task.assignee.includes("/")
      ? handbackTargetFor(events, task, snapshot.runs)
      : undefined;
  const lines = [
    `${task.id}  [${task.status}]  v${task.version}`,
    `assignee: ${task.assignee ?? "unassigned"}  owner: ${task.owner ?? "unowned"}`,
    `priority: ${task.priority ?? "--"}  type: ${task.type ?? "--"}`,
    ...(task.goal != null ? [`goal (finish line): ${task.goal}`] : []),
    ...(task.followUpAt ? [`follow-up: ${task.followUpAt}`] : []),
    ...(run
      ? [`run ${run.id}: ${run.state}${run.note ? ` - ${run.note.slice(0, 80)}` : ""}`]
      : []),
    ...(handback !== undefined
      ? [
          handback !== null
            ? `hand back: update ${task.id} assignee=${handback} status=todo --note "..."`
            : "hand back: pick an agent (no prior agent derivable)",
        ]
      : []),
    ...(detail && detail.products.length > 0
      ? [
          "",
          "Products",
          ...detail.products.map(({ product, producedBy }) => {
            const label =
              product.archetype === "doc"
                ? `doc ${product.id}  ${(product.title ?? product.key).slice(0, 60)}${task.tracks === product.id ? "  (tracked)" : ""}`
                : `mirror ${product.id}  [${product.kind}] ${product.coords}`;
            return producedBy ? `${label}  · by ${producedBy.actor}` : label;
          }),
        ]
      : []),
    ...(detail && detail.children.length > 0
      ? ["", "Children", ...detail.children.map((c) => `${c.id}  [${c.status}]  ${c.title.slice(0, 60)}`)]
      : []),
    "",
    "Spec",
    ...wrapPlainText(task.body.trim() || "(empty)", width),
    "",
    "Recent activity",
    // ONE coherent recent-activity view (taskDetailView.recent = the collapsed
    // task-scoped timeline) - renderers never interpret raw events themselves.
    // Raw-event fallback only when no snapshot/detail was supplied.
    ...(detail && detail.recent.length > 0
      ? detail.recent.flatMap((item) => wrapPlainText(`${item.at}  [${item.kind}]  ${item.summary}`, width))
      : recent.length === 0
        ? ["(none)"]
        : recent.flatMap((event) =>
            wrapPlainText(`${event.at}  ${event.kind}${event.note ? `: ${event.note}` : ""}`, width),
          )),
  ];
  return lines;
}

export interface DetailViewport {
  lines: string[];
  offset: number;
  end: number;
  maxOffset: number;
  total: number;
}

export function detailViewport(
  task: TaskObject,
  events: readonly KernelEvent[],
  state: KanbanState,
  snapshot?: Snapshot,
): DetailViewport {
  const lines = detailLines(task, events, Math.max(10, state.width - 2), snapshot);
  const capacity = Math.max(1, state.height - 2);
  const maxOffset = Math.max(0, lines.length - capacity);
  const offset = Math.min(state.detailOffset, maxOffset);
  return {
    lines: lines.slice(offset, offset + capacity),
    offset,
    end: Math.min(lines.length, offset + capacity),
    maxOffset,
    total: lines.length,
  };
}

function Detail({
  task,
  events,
  state,
  snapshot,
}: {
  task: TaskObject;
  events: readonly KernelEvent[];
  state: KanbanState;
  snapshot?: Snapshot;
}) {
  const viewport = detailViewport(task, events, state, snapshot);
  return (
    <Box flexDirection="column">
      <Box height={1} justifyContent="space-between">
        <Text bold color="cyan" wrap="truncate-end">{task.title}</Text>
        <Text dimColor wrap="truncate-end">j/k scroll  Esc back  q quit</Text>
      </Box>
      {viewport.lines.map((line, index) => (
        <Text
          key={`${viewport.offset + index}:${line}`}
          bold={line === "Spec" || line === "Recent activity" || line === "Products" || line === "Children"}
          wrap="truncate-end"
        >
          {line || " "}
        </Text>
      ))}
      <Text dimColor>
        {viewport.offset + 1}-{viewport.end} of {viewport.total}
      </Text>
    </Box>
  );
}

function taskById(board: KanbanBoard, id: string | null): TaskObject | undefined {
  if (id === null) return undefined;
  return Object.values(board).flat().find((candidate) => candidate.id === id);
}

/** Hook-free render surface used by the terminal app and snapshot render tests. */
export function KanbanView({ board, state, events, snapshot }: KanbanViewProps) {
  if (state.detailId !== null) {
    const task = taskById(board, state.detailId);
    if (task) return <Detail task={task} events={events[task.id] ?? []} state={state} snapshot={snapshot} />;
  }
  return <Board board={board} state={state} snapshot={snapshot} />;
}

function KanbanApp({ snapshot, events }: { snapshot: Snapshot; events: KanbanViewProps["events"] }) {
  const rawBoard = useMemo(() => boardView(snapshot), [snapshot]);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  // The reducer navigates over the FILTERED board, which itself depends on
  // state.query - a ref breaks the circular initializer (assigned each render).
  const boardRef = React.useRef<KanbanBoard>(rawBoard);
  const [state, dispatch] = useReducer(
    (current: KanbanState, action: Parameters<typeof reduceKanban>[1]) => reduceKanban(current, action, boardRef.current),
    initialKanbanState(columns, rows),
  );

  useEffect(() => dispatch({ type: "resize", width: columns, height: rows }), [columns, rows]);
  useInput((input, key) => {
    let detail: { offset: number; maxOffset: number } | undefined;
    if (state.detailId !== null) {
      const task = taskById(board, state.detailId);
      if (!task) return;
      const viewport = detailViewport(task, events[task.id] ?? [], state);
      detail = { offset: viewport.offset, maxOffset: viewport.maxOffset };
    }
    const intent = kanbanInputIntent(state, input, key, detail);
    if (intent === "exit") return exit();
    if (intent) dispatch(intent);
  });

  const board = useMemo(() => filterBoard(rawBoard, state.query), [rawBoard, state.query]);
  boardRef.current = board;
  return <KanbanView board={board} state={state} events={events} snapshot={snapshot} />;
}

export type KanbanRenderer = (
  node: React.ReactElement,
  options: RenderOptions,
) => Pick<ReturnType<typeof render>, "waitUntilExit">;

export async function startKanban(
  backend: Backend,
  renderer: KanbanRenderer = render,
): Promise<void> {
  const snapshot = backend.snapshot();
  const events: Record<string, readonly KernelEvent[]> = {};
  for (const object of Object.values(snapshot.objects)) {
    if (object.archetype === "task") events[object.id] = backend.events(object.id);
  }
  const instance = renderer(<KanbanApp snapshot={snapshot} events={events} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
    interactive: true,
    patchConsole: false,
  });
  await instance.waitUntilExit();
}
