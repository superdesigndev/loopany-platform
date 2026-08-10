/**
 * Derived views — inbox, tree, board, loops are QUERIES over the snapshot,
 * never stored. One source for CLI and web, so the two renders cannot drift.
 */
import {
  ACTIVE_RUN_STATES,
  type RunRecord,
  type Snapshot,
  TASK_STATUSES,
  type TaskObject,
  type TaskStatus,
  type Trigger,
  isTerminal,
} from "./types.js";

function tasks(snapshot: Snapshot): TaskObject[] {
  return Object.values(snapshot.objects).filter((o): o is TaskObject => o.archetype === "task");
}

const STATUS_ORDER: Record<TaskStatus, number> = Object.fromEntries(
  TASK_STATUSES.map((s, i) => [s, i]),
) as Record<TaskStatus, number>;

function byPriorityThenAge(a: TaskObject, b: TaskObject): number {
  const pa = a.priority ?? "P9";
  const pb = b.priority ?? "P9";
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
}

// ---- tree ----

export interface TreeNode {
  task: TaskObject;
  children: TreeNode[];
}

/** Roots-first tree. Cycle-guarded at render: a node in a hand-broken parent
 *  cycle surfaces as a root instead of hanging (write-time cycle checks are
 *  the first line of defence; this is the second). */
export function treeView(snapshot: Snapshot): TreeNode[] {
  const all = tasks(snapshot);
  const byId = new Map(all.map((t) => [t.id, t]));
  const isRoot = (t: TaskObject): boolean => {
    const seen = new Set<string>([t.id]);
    let cursor = t.parent;
    while (cursor) {
      if (seen.has(cursor) || !byId.has(cursor)) return true; // cycle or dangling => treat as root
      seen.add(cursor);
      cursor = byId.get(cursor)?.parent ?? null;
    }
    return t.parent === null;
  };
  const build = (t: TaskObject, seen: Set<string>): TreeNode => ({
    task: t,
    children: all
      .filter((c) => c.parent === t.id && !seen.has(c.id))
      .sort(byPriorityThenAge)
      .map((c) => build(c, new Set([...seen, c.id]))),
  });
  return all
    .filter(isRoot)
    .sort(byPriorityThenAge)
    .map((t) => build(t, new Set([t.id])));
}

// ---- inbox ----

export interface InboxItem {
  task: TaskObject;
  reason: "assigned" | "due";
}

/** My pending decisions plus anything whose wait expired but has not been
 *  ticked yet. Nothing waits silently: a wait exists only as inbox exposure
 *  or a trigger resurfacing. */
export function inboxView(snapshot: Snapshot, me: string, now: string): InboxItem[] {
  const items: InboxItem[] = [];
  for (const t of tasks(snapshot)) {
    if (isTerminal(t.status)) continue;
    if (t.assignee === me && t.status !== "follow-up") {
      items.push({ task: t, reason: "assigned" });
    } else if (
      t.status === "follow-up" &&
      t.followUpAt !== null &&
      Date.parse(t.followUpAt) <= Date.parse(now) &&
      (t.assignee === me || t.assignee === null)
    ) {
      items.push({ task: t, reason: "due" });
    }
  }
  return items.sort((a, b) => byPriorityThenAge(a.task, b.task));
}

// ---- board ----

export function boardView(snapshot: Snapshot): Record<TaskStatus, TaskObject[]> {
  const board = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as TaskObject[]])) as Record<
    TaskStatus,
    TaskObject[]
  >;
  for (const t of tasks(snapshot).sort(byPriorityThenAge)) board[t.status].push(t);
  return board;
}

// ---- loops (= tasks with a cron trigger; there is no loop table) ----

export interface LoopRow {
  task: TaskObject;
  trigger: Trigger;
  activeRun: RunRecord | null;
}

export function loopsView(snapshot: Snapshot): LoopRow[] {
  const rows: LoopRow[] = [];
  for (const trigger of snapshot.triggers) {
    if (trigger.kind !== "cron") continue;
    const task = snapshot.objects[trigger.taskId];
    if (!task || task.archetype !== "task") continue;
    rows.push({
      task,
      trigger,
      activeRun:
        snapshot.runs.find(
          (r) => r.taskId === task.id && ACTIVE_RUN_STATES.includes(r.state),
        ) ?? null,
    });
  }
  return rows.sort((a, b) => byPriorityThenAge(a.task, b.task));
}

export function sortTasksForList(list: TaskObject[]): TaskObject[] {
  return [...list].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byPriorityThenAge(a, b),
  );
}
