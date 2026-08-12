import {
  Box,
  Text,
  render,
  useApp,
  useInput,
  useWindowSize,
  type RenderOptions,
} from "ink";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  type KernelEvent,
  type InboxItem,
  type Provenance,
  type Snapshot,
  type TaskObject,
  boardView,
  inboxView,
  isPersonAssignee,
  taskDetailView,
} from "@loopany/kernel";
import { handbackTargetFor } from "../prompt.js";
import stringWidth from "string-width";
import type { Backend } from "../backend.js";
import { formatLocalTime } from "../time.js";
import {
  visibleStatuses,
  activeTask,
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

const REFRESH_INTERVAL_MS = 5_000;

interface KanbanData {
  snapshot: Snapshot;
  events: Readonly<Record<string, readonly KernelEvent[]>>;
}

function readKanbanData(backend: Backend): KanbanData {
  const snapshot = backend.snapshot();
  const events: Record<string, readonly KernelEvent[]> = {};
  for (const object of Object.values(snapshot.objects)) {
    if (object.archetype === "task") events[object.id] = backend.events(object.id);
  }
  return { snapshot, events };
}

function priorityColor(priority: string | null): "red" | "yellow" | "cyan" | undefined {
  if (priority === "P0") return "red";
  if (priority === "P1") return "yellow";
  if (priority === "P2") return "cyan";
  return undefined;
}

/** Compact card indicator strip (review round 3): due date, recent-activity
 *  age, and the failure/active/artifact markers - pure over the snapshot so the
 *  render tests pin it. */
export function cardIndicators(task: TaskObject, snapshot?: Snapshot, nowMs = Date.now()): string {
  const bits: string[] = [];
  if (task.followUpAt) bits.push(`due ${formatLocalTime(task.followUpAt)}`);
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
  const artifacts = [task.tracks, ...task.refs].filter(Boolean).length;
  if (artifacts > 0) bits.push(`◆${artifacts}`);
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

function Board({
  board,
  state,
  snapshot,
  refreshLabel,
  message,
}: Omit<KanbanViewProps, "events"> & { refreshLabel?: string; message?: string | null }) {
  const indexes = visibleColumnIndexes(state);
  const statuses = visibleStatuses(state);
  return (
    <Box flexDirection="column">
      <Box height={1} justifyContent="space-between">
        <Text bold color="cyan" wrap="truncate-end">Loopany  BOARD</Text>
        {refreshLabel ? <Text dimColor wrap="truncate-end">{refreshLabel}</Text> : null}
      </Box>
      <Text dimColor wrap="truncate-end">Tab inbox  h/l columns  j/k cards  Enter details  s status  R refresh  / search  f all  q quit</Text>
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
          {`Showing ${indexes[0]! + 1}-${indexes.at(-1)! + 1} of ${statuses.length}${state.showAll ? "" : " actionable"} columns${state.showAll ? "" : "  ·  f shows idea/done/archived"}`}
        </Text>
      ) : null}
      {message ? <Text color="yellow" wrap="truncate-end">{message}</Text> : null}
    </Box>
  );
}

function Inbox({
  me,
  items,
  selected,
  height,
  refreshLabel,
  message,
}: {
  me: string | null;
  items: readonly InboxItem[];
  selected: number;
  height: number;
  refreshLabel: string;
  message: string | null;
}) {
  const capacity = Math.max(1, height - 5);
  const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), Math.max(0, items.length - capacity)));
  const visible = items.slice(start, start + capacity);
  return (
    <Box flexDirection="column">
      <Box height={1} justifyContent="space-between">
        <Text bold color="cyan" wrap="truncate-end">Loopany  INBOX{me ? `  ${me}` : ""}</Text>
        <Text dimColor wrap="truncate-end">{refreshLabel}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">Tab board  j/k move  Enter details  a answer  s status  R refresh  q quit</Text>
      {!me ? (
        <Text color="yellow">No inbox identity. Set it with `lk connect ... --me &lt;email&gt;`.</Text>
      ) : items.length === 0 ? (
        <Text dimColor>(inbox empty)</Text>
      ) : (
        visible.map((item, index) => {
          const absolute = start + index;
          const active = absolute === selected;
          return (
            <Box key={item.task.id} flexDirection="column" borderStyle={active ? "bold" : "single"} paddingX={1}>
              <Text inverse={active} bold={active} wrap="truncate-end">
                {active ? "> " : "  "}{item.task.title}
              </Text>
              <Text dimColor={!active} wrap="truncate-end">
                {item.task.id}  [{item.reason}]{item.task.parent ? `  from ${item.task.parent}` : ""}
              </Text>
              <Text dimColor wrap="truncate-end">
                {item.task.tracks ? `inspect ${item.task.tracks}` : "no tracked artifact"}
              </Text>
            </Box>
          );
        })
      )}
      {message ? <Text color="yellow" wrap="truncate-end">{message}</Text> : null}
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
  // The Task Detail projection: artifacts from
  // tracks+refs, children, and the run pair - same taskDetailView every other
  // surface reads, so the TUI cannot drift from show/loops.
  const detail = snapshot ? taskDetailView(snapshot, task.id, events) : null;
  const run = detail?.activeRun ?? detail?.lastRun ?? null;
  // Human-held task: surface the derived default hand-back agent so the human
  // never needs to know a machine/profile address (review round 3). Human-ness
  // is the kernel's ONE heuristic (isPersonAssignee), never a bare "/" probe.
  const handback =
    snapshot && task.assignee !== null && isPersonAssignee(task.assignee)
      ? handbackTargetFor(events, task, snapshot.runs)
      : undefined;
  const lines = [
    `${task.id}  [${task.status}]  v${task.version}`,
    `assignee: ${task.assignee ?? "unassigned"}  owner: ${task.owner ?? "unowned"}`,
    `priority: ${task.priority ?? "--"}  type: ${task.type ?? "--"}`,
    ...(task.goal != null ? [`goal (finish line): ${task.goal}`] : []),
    ...(task.followUpAt ? [`follow-up: ${formatLocalTime(task.followUpAt)}`] : []),
    ...(run
      ? [`run ${run.id}: ${run.state}${run.note ? ` - ${run.note.slice(0, 80)}` : ""}`]
      : []),
    ...(handback !== undefined
      ? [
          handback !== null
            ? `hand back: loopany-kernel update ${task.id} assignee=${handback} status=todo --note "..."`
            : "hand back: pick an agent (no prior agent derivable)",
        ]
      : []),
    ...(detail && detail.artifacts.length > 0
      ? [
          "",
          "Artifacts",
          ...detail.artifacts.map(({ artifact, producedBy }) => {
            const label =
              artifact.archetype === "doc"
                ? `doc ${artifact.id}  ${(artifact.title ?? artifact.key).slice(0, 60)}${task.tracks === artifact.id ? "  (tracked)" : ""}`
                : `mirror ${artifact.id}  [${artifact.kind}] ${artifact.coords}`;
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
      ? detail.recent.flatMap((item) => wrapPlainText(`${formatLocalTime(item.at)}  [${item.kind}]  ${item.summary}`, width))
      : recent.length === 0
        ? ["(none)"]
        : recent.flatMap((event) =>
            wrapPlainText(`${formatLocalTime(event.at)}  ${event.kind}${event.note ? `: ${event.note}` : ""}`, width),
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
        <Text dimColor wrap="truncate-end">j/k scroll  s status  R refresh  Esc back  q quit</Text>
      </Box>
      {viewport.lines.map((line, index) => (
        <Text
          key={`${viewport.offset + index}:${line}`}
          bold={line === "Spec" || line === "Recent activity" || line === "Artifacts" || line === "Children"}
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

type ActionMode =
  | { kind: "status"; task: TaskObject }
  | { kind: "answer"; task: TaskObject; target: string; note: string }
  | null;

function ActionPrompt({ mode }: { mode: Exclude<ActionMode, null> }) {
  return (
    <Box borderStyle="double" borderColor="cyan" paddingX={1} flexDirection="column">
      {mode.kind === "status" ? (
        <>
          <Text bold>Change status - {mode.task.title}</Text>
          <Text>t todo   p in-progress   d done   x archived   Esc cancel</Text>
        </>
      ) : (
        <>
          <Text bold>Answer and hand back to {mode.target}</Text>
          <Text wrap="truncate-end">note: {mode.note}▏</Text>
          <Text dimColor>Enter send   Esc cancel</Text>
        </>
      )}
    </Box>
  );
}

function KanbanApp({
  backend,
  initial,
  me,
}: {
  backend: Backend;
  initial: KanbanData;
  me: string | null;
}) {
  const [data, setData] = useState(initial);
  const { snapshot, events } = data;
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
  const [view, setView] = useState<"board" | "inbox">("board");
  const [inboxSelected, setInboxSelected] = useState(0);
  const [action, setAction] = useState<ActionMode>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const refreshingRef = useRef(false);

  const board = useMemo(() => filterBoard(rawBoard, state.query), [rawBoard, state.query]);
  boardRef.current = board;
  const inboxItems = useMemo(
    () => (me ? inboxView(snapshot, me, new Date().toISOString()) : []),
    [snapshot, me],
  );
  const selectedInboxItem = inboxItems[Math.min(inboxSelected, Math.max(0, inboxItems.length - 1))];
  const selectedInboxId = selectedInboxItem?.task.id ?? null;
  const selectedBoardTask = state.detailId ? taskById(board, state.detailId) : activeTask(state, board);
  const selectedActionTask = state.detailId !== null
    ? selectedBoardTask
    : view === "inbox" ? selectedInboxItem?.task : selectedBoardTask;

  const refresh = useCallback((manual = false) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const selectedId = state.detailId ?? activeTask(state, boardRef.current)?.id ?? null;
    try {
      const next = readKanbanData(backend);
      const nextBoard = filterBoard(boardView(next.snapshot), state.query);
      setData(next);
      dispatch({ type: "select-id", id: selectedId, board: nextBoard });
      const nextInbox = me ? inboxView(next.snapshot, me, new Date().toISOString()) : [];
      const retainedInboxIndex = selectedInboxId ? nextInbox.findIndex((item) => item.task.id === selectedInboxId) : -1;
      setInboxSelected((current) => retainedInboxIndex >= 0
        ? retainedInboxIndex
        : Math.min(current, Math.max(0, nextInbox.length - 1)));
      setLastUpdated(Date.now());
      if (manual) setMessage("refreshed");
    } catch (error) {
      setMessage(`refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [backend, me, selectedInboxId, state.detailId, state.query]);

  useEffect(() => {
    if (action !== null || state.searching) return;
    const timer = setInterval(() => refresh(false), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [action, state.searching, refresh]);

  useEffect(() => dispatch({ type: "resize", width: columns, height: rows }), [columns, rows]);

  const mutate = useCallback((task: TaskObject, patch: Record<string, unknown>, note?: string) => {
    const actor: Provenance = { entrance: "human", actorId: me ?? "shared" };
    try {
      backend.command(
        { op: "update", id: task.id, patch, ...(note ? { note } : {}), ifVersion: task.version },
        actor,
        new Date().toISOString(),
      );
      setMessage(`updated ${task.id}`);
      setAction(null);
      refresh(false);
    } catch (error) {
      setMessage(`update failed: ${error instanceof Error ? error.message : String(error)}`);
      setAction(null);
    }
  }, [backend, me, refresh]);

  useInput((input, key) => {
    if (action?.kind === "status") {
      if (key.escape) return setAction(null);
      const status = input === "t" ? "todo" : input === "p" ? "in-progress" : input === "d" ? "done" : input === "x" ? "archived" : null;
      if (status) mutate(action.task, { status });
      return;
    }
    if (action?.kind === "answer") {
      if (key.escape) return setAction(null);
      if (key.return) {
        if (!action.note.trim()) return setMessage("answer needs a note");
        return mutate(action.task, { assignee: action.target, status: "todo" }, action.note.trim());
      }
      if (key.backspace || key.delete) return setAction({ ...action, note: action.note.slice(0, -1) });
      if (input && !key.tab) setAction({ ...action, note: action.note + input });
      return;
    }
    if (input === "R" || input === "r") return refresh(true);
    if (key.tab && state.detailId === null && !state.searching) {
      setView((current) => current === "board" ? "inbox" : "board");
      setMessage(null);
      return;
    }
    if (input === "s" && selectedActionTask) return setAction({ kind: "status", task: selectedActionTask });
    if (view === "inbox" && state.detailId === null && !state.searching) {
      if (input === "q" || key.escape) return exit();
      if (input === "j" || key.downArrow) return setInboxSelected((current) => Math.min(Math.max(0, inboxItems.length - 1), current + 1));
      if (input === "k" || key.upArrow) return setInboxSelected((current) => Math.max(0, current - 1));
      if (key.return && selectedInboxItem) return dispatch({ type: "open-id", id: selectedInboxItem.task.id });
      if (input === "a" && selectedInboxItem) {
        const target = handbackTargetFor(events[selectedInboxItem.task.id] ?? [], selectedInboxItem.task, snapshot.runs);
        if (!target) return setMessage("cannot derive a prior agent; assign it with lk update");
        return setAction({ kind: "answer", task: selectedInboxItem.task, target, note: "" });
      }
      return;
    }
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

  const refreshLabel = refreshing
    ? "refreshing..."
    : `updated ${formatLocalTime(new Date(lastUpdated).toISOString())}  ·  auto 5s`;
  let content: React.ReactElement;
  if (state.detailId !== null) {
    content = <KanbanView board={board} state={state} events={events} snapshot={snapshot} />;
  } else if (view === "inbox") {
    content = <Inbox me={me} items={inboxItems} selected={inboxSelected} height={state.height} refreshLabel={refreshLabel} message={message} />;
  } else {
    content = <Board board={board} state={state} snapshot={snapshot} refreshLabel={refreshLabel} message={message} />;
  }
  return <Box flexDirection="column">{content}{action ? <ActionPrompt mode={action} /> : null}</Box>;
}

export type KanbanRenderer = (
  node: React.ReactElement,
  options: RenderOptions,
) => Pick<ReturnType<typeof render>, "waitUntilExit">;

export async function startKanban(
  backend: Backend,
  me: string | null = null,
  renderer: KanbanRenderer = render,
): Promise<void> {
  const initial = readKanbanData(backend);
  const instance = renderer(<KanbanApp backend={backend} initial={initial} me={me} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
    interactive: true,
    patchConsole: false,
  });
  await instance.waitUntilExit();
}
