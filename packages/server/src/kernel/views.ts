/**
 * VIEW ENDPOINTS — the workspace UI's BFF layer (design §9, API spec §8).
 *
 * One composed endpoint per screen: the server assembles everything the screen
 * needs and the client does zero stitching. Three properties are load-bearing
 * and every function here honors them:
 *
 *  1. **Read-only.** Nothing in this module writes. A view is a screen's
 *     contract, not the kernel's, so reshaping one is a UI change — which is
 *     exactly what makes GraphQL a deferred upgrade rather than the default.
 *  2. **`cursorSeq` on every payload.** It is the `events.seq` the payload was
 *     assembled at. A client holding a stream message with a LOWER seq knows the
 *     message is already reflected and skips the refetch; without it every view
 *     refetch races the stream (spec §8.1).
 *  3. **Self-sufficient.** No view may depend on the SSE stream having been
 *     seen. That is what makes 30 s polling a real degraded mode rather than a
 *     broken one (spec §7.1).
 *
 * The system graph is a PROJECTION, never configuration: every node, edge and
 * badge is computed live from `objects` (`created_by_loop`, `watcher`) + `runs`
 * aggregates. There is no topology table and no way to wire two loops, because
 * loops never wire to loops — they meet at the instance layer (design §10.6).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { events, objects, type KernelEvent, type KernelObject } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import { runs, type Run } from "../db/schema.js";
import { cronText } from "../lib/format.js";
import { eventShape, eventTail, inboxCounts, inboxUnion, objectShape, type ApiResult } from "./objectApi.js";
import { refusal } from "./refusals.js";
import { BOARD_COLUMNS, columnFor } from "./taskBoard.js";
import type { ApiContext } from "./apiAuth.js";

/** Per-item event tail on the inbox screen (spec §8.1: "capped at 5 per item"). */
const INBOX_EVENT_CAP = 5;
/** The loop page's run strip and the task page's timeline are both bounded — a
 *  screen payload is never allowed to grow with history. */
const RECENT_RUNS_CAP = 12;
const TIMELINE_CAP = 200;
const LIST_CAP = 200;
/** The system graph's display window on edge counts. A DISPLAY window, not a
 *  dedup key: nothing about correctness depends on it, which is why it is
 *  allowed here and forbidden as a work-list basis (design §6). */
const GRAPH_WINDOW_DEFAULT_DAYS = 14;

// ---------------------------------------------------------------- primitives

type LoopRef = { id: string; title: string | null } | null;

const loopRef = (row: KernelObject | undefined): LoopRef => (row ? { id: row.id, title: row.title } : null);

/** A run's lifecycle state for display. The rewrite's `queue_state` wins; a
 *  legacy row (queue_state NULL, migrated loops share their id with real run
 *  history) is mapped from the shipping `phase` so a migrated loop's page is not
 *  mysteriously blank. */
export function runDisplayState(run: Pick<Run, "queueState" | "phase">): string {
  if (run.queueState) return run.queueState === "claimed" ? "running" : run.queueState;
  return { done: "success", error: "failure", running: "running", pending: "queued", canceled: "skipped" }[run.phase] ?? run.phase;
}

/** A run's USD cost: the real column first, then the rewrite's open cost object. */
function runCostUsd(run: Run): number {
  if (typeof run.costUsd === "number") return run.costUsd;
  const usd = (run.runCost as { usd?: unknown } | null)?.usd;
  return typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
}

function runShape(run: Run) {
  return {
    id: run.id, state: runDisplayState(run), scope: run.scope ?? "routine", reason: run.reason ?? null,
    startedAt: run.startedAt ?? run.ts, finishedAt: run.finishedAt ?? null,
    reportDoc: run.reportDocId ?? null, summary: run.outcomeSummary ?? run.message ?? null,
    costUsd: runCostUsd(run) || null, attempts: run.attempts,
  };
}

async function teamLoops(teamId: string): Promise<KernelObject[]> {
  return db.select().from(objects).where(and(eq(objects.teamId, teamId), eq(objects.kind, "loop"))).orderBy(asc(objects.title));
}

/** Every run row for a set of loops, newest first. One query, so a list screen
 *  costs a constant number of round trips regardless of loop count. */
async function runsForLoops(loopIds: string[], limit = 500): Promise<Run[]> {
  if (!loopIds.length) return [];
  return db.select().from(runs).where(inArray(runs.loopId, loopIds)).orderBy(desc(runs.ts)).limit(limit);
}

export interface LoopHealth {
  lastOutcome: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  runs7d: { success: number; failure: number };
  costs7d: { usd: number };
}

/**
 * Health from runs (design §9). PURE over the run rows so it is testable
 * without a database and so the loop page and the loop list cannot compute
 * "healthy" two different ways.
 *
 * `consecutiveFailures` walks newest→oldest and counts failures until the first
 * success; a still-queued or running run is TRANSPARENT to the streak (it has
 * no outcome yet, and treating it as a reset would hide a real failure run).
 */
export function loopHealth(rows: Run[], now: Date): LoopHealth {
  const ordered = [...rows].sort((a, b) => (b.startedAt ?? b.ts).localeCompare(a.startedAt ?? a.ts));
  const terminal = ordered.filter((r) => ["success", "failure"].includes(runDisplayState(r)));
  let consecutiveFailures = 0;
  for (const run of terminal) { if (runDisplayState(run) === "failure") consecutiveFailures += 1; else break; }
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const window = ordered.filter((r) => (r.finishedAt ?? r.startedAt ?? r.ts) >= since);
  const newest = ordered[0];
  return {
    lastOutcome: newest ? runDisplayState(newest) : null,
    lastRunAt: newest ? newest.finishedAt ?? newest.startedAt ?? newest.ts : null,
    consecutiveFailures,
    runs7d: {
      success: window.filter((r) => runDisplayState(r) === "success").length,
      failure: window.filter((r) => runDisplayState(r) === "failure").length,
    },
    costs7d: { usd: Number(window.reduce((sum, r) => sum + runCostUsd(r), 0).toFixed(4)) },
  };
}

const notFound = (id: string) => refusal("NOT_FOUND", `${id} was not found`);

/** Every view is a human surface: the screens read production content and the
 *  run's own read surface is `task list`, which teaches better hints. */
function humanOnly(context: ApiContext) {
  if (context.mode === "human") return undefined;
  return { ok: false as const, error: refusal("NOT_HUMAN", "view endpoints compose a human screen", [], "a run reads `task list` / `task show`, which carry the next-step hints an agent needs") };
}

// ------------------------------------------------------------------- inbox

/**
 * `GET /api/views/inbox` — THE PRODUCT'S FRONT DOOR.
 *
 * A superset of `GET /api/inbox`: the raw endpoint serves the human CLI, this
 * one serves the screen, and keeping them apart lets the screen payload grow
 * without changing what `loopany inbox` prints.
 *
 * `execution` is the task's `payload`, echoed under a name the UI is CONTRACTED
 * to render verbatim in an execution block. That is the execution-integrity
 * invariant: machine-executed content lives in structured payload fields, the
 * verdict UI renders those fields verbatim, the body is human narrative, and
 * presentation may decorate but can never substitute what is actually approved
 * and executed (design §7). It is a separate key rather than "just read
 * `payload`" so the contract is visible at the wire and testable.
 */
export async function inboxView(context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const guard = humanOnly(context); if (guard) return guard;
  const { rows, stamp } = await inboxUnion(context.teamId, now);
  const loops = new Map((await teamLoops(context.teamId)).map((loop) => [loop.id, loop]));
  const items = await Promise.all(rows.map(async ({ task, reasons, askedAt, askedByRun }) => {
    const tail = await store.listObjectEvents(undefined, task.id);
    return {
      task: {
        id: task.id, title: task.title, pendingQuestion: task.pendingQuestion, body: task.body ?? "",
        payload: task.payload ?? {}, followUpAt: task.followUpAt, watcher: task.watcher,
        createdByLoop: task.createdByLoop, createdByRun: task.createdByRun,
        createdAt: task.createdAt, updatedAt: task.updatedAt,
      },
      reasons, askedAt, askedByRun,
      creator: loopRef(task.createdByLoop ? loops.get(task.createdByLoop) : undefined),
      watcherLoop: loopRef(task.watcher ? loops.get(task.watcher) : undefined),
      // Verbatim, by contract. Never re-keyed, never summarized.
      execution: task.payload ?? {},
      recentEvents: tail.slice(-INBOX_EVENT_CAP).reverse().map(eventShape),
    };
  }));
  return { ok: true, value: { items, counts: inboxCounts(rows), now: stamp, cursorSeq: await eventTail(context.teamId) } };
}

// -------------------------------------------------------------------- loops

/** `GET /api/views/loops` — the loop list: identity, cadence, health, load. */
export async function loopsView(context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const guard = humanOnly(context); if (guard) return guard;
  const loops = await teamLoops(context.teamId);
  const runRows = await runsForLoops(loops.map((l) => l.id));
  const counts = await taskCountsByWatcher(context.teamId);
  return { ok: true, value: {
    loops: loops.map((loop) => ({
      id: loop.id, title: loop.title, status: loop.status, cron: loop.cron, timezone: loop.timezone,
      cronText: loop.cron ? cronText(loop.cron) : null, nextFire: loop.nextFire,
      createdAt: loop.createdAt, updatedAt: loop.updatedAt,
      health: loopHealth(runRows.filter((r) => r.loopId === loop.id), now),
      openTasks: counts.open.get(loop.id) ?? 0,
      questionsWaiting: counts.questions.get(loop.id) ?? 0,
    })),
    cursorSeq: await eventTail(context.teamId),
  } };
}

/**
 * `GET /api/views/loop/:id` — charter, evolve diffs, its open tasks, health.
 *
 * `openTasks` splits three ways because the page answers three different
 * questions: what this loop is on the hook for (`watching`), what it has put
 * into the world (`created`), and what it is blocked on (`questions`). A task
 * can appear in more than one list — the client renders sections, not a
 * partition (spec §8.2).
 */
export async function loopView(id: string, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const guard = humanOnly(context); if (guard) return guard;
  const loop = await store.getObject(undefined, id);
  if (!loop || loop.teamId !== context.teamId) return { ok: false, error: notFound(id) };
  if (loop.kind !== "loop") return { ok: false, error: refusal("WRONG_KIND", `${id} is a ${loop.kind}, not a loop`) };

  const [tail, runRows, watching, created] = await Promise.all([
    store.listObjectEvents(undefined, id),
    db.select().from(runs).where(eq(runs.loopId, id)).orderBy(desc(runs.ts)).limit(RECENT_RUNS_CAP * 4),
    db.select().from(objects).where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "task"), eq(objects.status, "open"), eq(objects.watcher, id))).orderBy(asc(objects.followUpAt)),
    db.select().from(objects).where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "task"), eq(objects.status, "open"), eq(objects.createdByLoop, id))).orderBy(desc(objects.createdAt)),
  ]);
  const stamp = now.toISOString();
  const questions = [...new Map([...watching, ...created].filter((t) => t.pendingQuestion?.trim()).map((t) => [t.id, t])).values()];

  return { ok: true, value: {
    loop: {
      id: loop.id, title: loop.title, status: loop.status, cron: loop.cron, timezone: loop.timezone,
      cronText: loop.cron ? cronText(loop.cron) : null, nextFire: loop.nextFire, body: loop.body ?? "",
      payload: loop.payload ?? {}, createdAt: loop.createdAt, updatedAt: loop.updatedAt,
    },
    health: loopHealth(runRows, now),
    // The audit window design §4 names: charter diffs land in events and render
    // on the loop page. `loop-updated` is included only when it actually touched
    // the body — a cadence-only governance write is not a charter change.
    charterHistory: tail
      .filter((e) => e.kind === "charter-evolved" || (e.kind === "loop-updated" && e.diff?.body))
      .slice(-RECENT_RUNS_CAP).reverse()
      .map((e) => ({ event: e.id, seq: e.seq, ts: e.ts, actor: e.actorId, entrance: e.entrance, diff: e.diff ?? {} })),
    openTasks: {
      watching: watching.map((t) => taskRow(t, stamp)),
      created: created.map((t) => taskRow(t, stamp)),
      questions: questions.map((t) => taskRow(t, stamp)),
    },
    recentRuns: runRows.slice(0, RECENT_RUNS_CAP).map(runShape),
    events: tail.slice(-TIMELINE_CAP).reverse().map(eventShape),
    cursorSeq: await eventTail(context.teamId),
  } };
}

// -------------------------------------------------------------------- tasks

function taskRow(task: KernelObject, stamp: string) {
  return {
    id: task.id, title: task.title, status: task.status, followUpAt: task.followUpAt,
    pendingQuestion: task.pendingQuestion, watcher: task.watcher, createdByLoop: task.createdByLoop,
    createdAt: task.createdAt, updatedAt: task.updatedAt, closedAt: task.closedAt,
    due: Boolean(task.followUpAt && task.followUpAt <= stamp),
  };
}

/** The closed column is a RECORD, not a worklist: it is bounded far tighter than
 *  the open ones so a year of history cannot dominate the board payload. */
const CLOSED_COLUMN_CAP = 25;

/**
 * `GET /api/views/tasks` — THE TASK BOARD.
 *
 * The screen is a kanban board, so the view composes COLUMNS rather than a
 * filtered page: the same five state predicates the list screen used to offer as
 * a chooser (Open / Due / Questions / Unclaimed / Closed), all visible at once.
 *
 * The mapping itself lives in the pure `taskBoard.ts` (`columnFor`) and each
 * column's one-sentence `rule` ships in the payload, so the board never has to
 * restate the kernel's lifecycle in the client — and cannot restate it wrongly.
 * Every column is still a STATE predicate; there is no time-window column,
 * because a window leaks work (design §6).
 *
 * `counts` is the §6 safety floor, single-sourced from `inboxCounts` — the same
 * numbers the inbox badge shows. It rides the board so the floor stays visible
 * at a glance from the screen where work is actually moved.
 */
export async function tasksView(context: ApiContext, query: URLSearchParams, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const guard = humanOnly(context); if (guard) return guard;
  const allowed = new Set(["watcher", "creator", "limit"]);
  const unknown = [...query.keys()].find((key) => !allowed.has(key));
  if (unknown) return { ok: false, error: refusal("UNKNOWN_FILTER", `unknown task filter "${unknown}"`, [{ path: unknown, message: "unknown filter", got: unknown }], `the board owns status, question and due as COLUMNS; accepted narrowing filters: ${[...allowed].join(", ")}`) };
  const limit = Math.min(LIST_CAP, Math.max(1, Number(query.get("limit") ?? 100) || 100));
  const stamp = now.toISOString();

  const conds = [eq(objects.teamId, context.teamId), eq(objects.kind, "task")];
  const watcher = query.get("watcher");
  if (watcher === "none") conds.push(isNull(objects.watcher));
  else if (watcher) conds.push(eq(objects.watcher, watcher));
  const creator = query.get("creator"); if (creator) conds.push(eq(objects.createdByLoop, creator));

  // Two queries, not one: the open columns are the worklist and take the page
  // budget; the closed column is a record and takes a much smaller, separate
  // one. A single ORDER BY could otherwise fill the whole page with history.
  const [openRows, closedRows, loopRows] = await Promise.all([
    db.select().from(objects).where(and(...conds, eq(objects.status, "open"))).orderBy(desc(objects.createdAt)).limit(limit + 1),
    db.select().from(objects).where(and(...conds, eq(objects.status, "closed"))).orderBy(desc(objects.closedAt)).limit(CLOSED_COLUMN_CAP + 1),
    teamLoops(context.teamId),
  ]);
  const loops = new Map(loopRows.map((loop) => [loop.id, loop]));
  const truncated = openRows.length > limit || closedRows.length > CLOSED_COLUMN_CAP;
  const cards = [...openRows.slice(0, limit), ...closedRows.slice(0, CLOSED_COLUMN_CAP)].map((t) => ({
    ...taskRow(t, stamp),
    creator: loopRef(t.createdByLoop ? loops.get(t.createdByLoop) : undefined),
    watcherLoop: loopRef(t.watcher ? loops.get(t.watcher) : undefined),
    column: columnFor(t, stamp),
  }));

  const { rows: inboxRows } = await inboxUnion(context.teamId, now);
  return { ok: true, value: {
    columns: BOARD_COLUMNS.map((spec) => ({ ...spec, tasks: cards.filter((card) => card.column === spec.key) })),
    // The loops a card can be handed to. The board's claim control is a
    // `watcher` PATCH like any other, so it must name a real loop id — a picker,
    // never a free-text field.
    loops: loopRows.filter((loop) => loop.status !== "retired").map((loop) => ({ id: loop.id, title: loop.title })),
    counts: inboxCounts(inboxRows),
    truncated, now: stamp, cursorSeq: await eventTail(context.teamId),
  } };
}

/** `GET /api/views/task/:id` — the task page: the artifact, its execution
 *  payload, the event timeline ordered by seq, and the runs that touched it. */
export async function taskView(id: string, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const guard = humanOnly(context); if (guard) return guard;
  const task = await store.getObject(undefined, id);
  if (!task || task.teamId !== context.teamId) return { ok: false, error: notFound(id) };
  if (task.kind !== "task") return { ok: false, error: refusal("WRONG_KIND", `${id} is a ${task.kind}, not a task`) };
  // Runs belong to LOOPS, never to tasks (design §5), so "runs that touched
  // this task" is a union of two facts: the express runs scoped to it, and the
  // run that created it. The creating-run clause is omitted ENTIRELY when there
  // is none — a placeholder id would be a query for a row that cannot exist.
  const touchedBy = task.createdByRun ? or(eq(runs.scope, `task:${id}`), eq(runs.id, task.createdByRun))! : eq(runs.scope, `task:${id}`);
  const [tail, touching] = await Promise.all([
    store.listObjectEvents(undefined, id),
    db.select().from(runs).where(touchedBy).orderBy(desc(runs.ts)).limit(RECENT_RUNS_CAP),
  ]);
  const loops = new Map((await teamLoops(context.teamId)).map((loop) => [loop.id, loop]));
  return { ok: true, value: {
    task: objectShape(task),
    execution: task.payload ?? {},
    due: Boolean(task.followUpAt && task.followUpAt <= now.toISOString()),
    creator: loopRef(task.createdByLoop ? loops.get(task.createdByLoop) : undefined),
    watcherLoop: loopRef(task.watcher ? loops.get(task.watcher) : undefined),
    // Oldest first: a timeline is read forwards, and `seq` is the order (the
    // content id dedups, the seq orders).
    timeline: tail.slice(-TIMELINE_CAP).map(eventShape),
    runs: touching.map(runShape),
    cursorSeq: await eventTail(context.teamId),
  } };
}

// --------------------------------------------------------------------- docs

/** `GET /api/views/docs` — the doc library. Bodies are NOT inlined here: a
 *  library is a list, and one 4 MB report would dominate the payload. */
export async function docsView(context: ApiContext): Promise<ApiResult<Record<string, unknown>>> {
  const guard = humanOnly(context); if (guard) return guard;
  const rows = await db.select().from(objects).where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "doc"))).orderBy(desc(objects.createdAt)).limit(LIST_CAP);
  const loops = new Map((await teamLoops(context.teamId)).map((loop) => [loop.id, loop]));
  return { ok: true, value: {
    docs: rows.map((doc) => ({
      id: doc.id, title: doc.title, format: doc.format ?? "markdown", key: doc.key,
      createdByLoop: doc.createdByLoop, createdByRun: doc.createdByRun,
      creator: loopRef(doc.createdByLoop ? loops.get(doc.createdByLoop) : undefined),
      createdAt: doc.createdAt, updatedAt: doc.updatedAt, bytes: Buffer.byteLength(doc.body ?? "", "utf8"),
    })),
    cursorSeq: await eventTail(context.teamId),
  } };
}

/**
 * `GET /api/views/doc/:id` — one doc, body included.
 *
 * `format` rides the payload because it decides the RENDER PATH on the client:
 * `markdown` goes through client-side component rendering with raw inline HTML
 * NOT rendered (the XSS answer), and `html` goes into a sandboxed iframe with
 * `allow-scripts` and deliberately NO `allow-same-origin` — an opaque origin, so
 * a doc's script can never read the app's session (design §7).
 */
export async function docView(id: string, context: ApiContext): Promise<ApiResult<Record<string, unknown>>> {
  const guard = humanOnly(context); if (guard) return guard;
  const doc = await store.getObject(undefined, id);
  if (!doc || doc.teamId !== context.teamId) return { ok: false, error: notFound(id) };
  if (doc.kind !== "doc") return { ok: false, error: refusal("WRONG_KIND", `${id} is a ${doc.kind}, not a doc`) };
  const loops = new Map((await teamLoops(context.teamId)).map((loop) => [loop.id, loop]));
  return { ok: true, value: {
    doc: { ...objectShape(doc), format: doc.format ?? "markdown" },
    creator: loopRef(doc.createdByLoop ? loops.get(doc.createdByLoop) : undefined),
    timeline: (await store.listObjectEvents(undefined, id)).slice(-TIMELINE_CAP).map(eventShape),
    cursorSeq: await eventTail(context.teamId),
  } };
}

// ------------------------------------------------------------- system graph

async function taskCountsByWatcher(teamId: string): Promise<{ open: Map<string, number>; questions: Map<string, number> }> {
  const rows = await db
    .select({
      watcher: objects.watcher,
      open: sql<number>`count(*)`,
      questions: sql<number>`count(*) filter (where ${objects.pendingQuestion} is not null and ${objects.pendingQuestion} <> '')`,
    })
    .from(objects)
    .where(and(eq(objects.teamId, teamId), eq(objects.kind, "task"), eq(objects.status, "open"), isNotNull(objects.watcher)))
    .groupBy(objects.watcher);
  return {
    open: new Map(rows.map((r) => [r.watcher!, Number(r.open)])),
    questions: new Map(rows.map((r) => [r.watcher!, Number(r.questions)])),
  };
}

export type GraphEdgeKind = "produces" | "adopts" | "hands-off" | "asks" | "answers";
export interface GraphTask {
  id: string; createdByLoop: string | null; watcher: string | null; pendingQuestion: string | null; adopted: boolean;
}

/**
 * The edge derivation, PURE — one row of spec §8.3's table per branch, so the
 * rules are unit-testable against fixtures without a database.
 *
 * DELIBERATE DEVIATION, spec §8.3 "adoption detection". The spec says to detect
 * adoption from the earliest `object-created` event's diff showing `watcher`
 * absent or null. That is not implementable as written: `createObjectIn` writes
 * a creation diff carrying only `pendingQuestion`, so `watcher` is ALWAYS absent
 * from it and every watched task would read as adopted. The honest equivalent —
 * and what the caller passes in — is the positive fact: an `object-updated`
 * event whose diff moves `watcher` from null to a loop id. That IS "created
 * unwatched, watcher set later".
 */
export function deriveGraphEdges(tasks: GraphTask[]): { from: string; to: string; kind: GraphEdgeKind; count: number }[] {
  const tally = new Map<string, { from: string; to: string; kind: GraphEdgeKind; count: number }>();
  const add = (from: string, to: string, kind: GraphEdgeKind) => {
    const key = `${from}|${to}|${kind}`;
    const existing = tally.get(key);
    if (existing) existing.count += 1; else tally.set(key, { from, to, kind, count: 1 });
  };
  for (const task of tasks) {
    // A human-created task has no creating loop; "you" is its source.
    const creator = task.createdByLoop ?? "you";
    if (task.pendingQuestion?.trim()) {
      add(creator, "you", "asks");
      if (task.watcher) add("you", task.watcher, "answers");
      continue;
    }
    if (task.adopted && task.watcher) { add(creator, "pool", "produces"); add("pool", task.watcher, "adopts"); continue; }
    if (!task.watcher) { add(creator, "pool", "produces"); continue; }
    // A task a loop watches for ITSELF is not a flow between nodes.
    if (task.watcher !== creator) add(creator, task.watcher, "hands-off");
  }
  return [...tally.values()];
}

/** `GET /api/views/system-graph` — the System tab's projection (spec §8.3). */
export async function systemGraphView(context: ApiContext, query: URLSearchParams, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const guard = humanOnly(context); if (guard) return guard;
  const raw = query.get("days");
  const days = raw === null ? GRAPH_WINDOW_DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 90) return { ok: false, error: refusal("UNKNOWN_FILTER", "days must be a whole number from 1 to 90", [{ path: "days", message: "out of range", got: raw ?? "", expected: "1–90" }]) };
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const stamp = now.toISOString();

  const loops = (await teamLoops(context.teamId)).filter((loop) => loop.status !== "retired");
  const [runRows, counts, windowTasks, poolRows, questionCount] = await Promise.all([
    runsForLoops(loops.map((l) => l.id)),
    taskCountsByWatcher(context.teamId),
    db.select().from(objects).where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "task"), gte(objects.createdAt, since))),
    db.select().from(objects).where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "task"), eq(objects.status, "open"), isNull(objects.watcher))).orderBy(asc(objects.createdAt)),
    db.select({ n: sql<number>`count(*)` }).from(objects).where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "task"), eq(objects.status, "open"), isNotNull(objects.pendingQuestion), ne(objects.pendingQuestion, ""))),
  ]);

  // Adoption is a positive fact in the log: watcher moved null → a loop id.
  const watched = windowTasks.filter((t) => t.watcher);
  const adoptions = watched.length
    ? await db.select({ objectId: events.objectId, diff: events.diff }).from(events)
        .where(and(eq(events.teamId, context.teamId), inArray(events.objectId, watched.map((t) => t.id))))
    : [];
  const adopted = new Set(adoptions.filter((e) => e.diff?.watcher && (e.diff.watcher.old ?? null) === null && e.diff.watcher.new).map((e) => e.objectId!));

  const nodeIds = new Set<string>([...loops.map((l) => l.id), "pool", "you"]);
  const edges = deriveGraphEdges(windowTasks.map((t) => ({
    id: t.id, createdByLoop: t.createdByLoop, watcher: t.watcher, pendingQuestion: t.pendingQuestion, adopted: adopted.has(t.id),
  }))).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));

  const oldest = poolRows[0];
  const nodes = [
    ...loops.map((loop) => ({
      id: loop.id, type: "loop" as const, label: loop.title, status: loop.status,
      badges: {
        cadence: loop.cron ? cronText(loop.cron) : null,
        ...loopOutcomeBadge(runRows.filter((r) => r.loopId === loop.id)),
        openTasks: counts.open.get(loop.id) ?? 0,
        questionsWaiting: counts.questions.get(loop.id) ?? 0,
      },
    })),
    // The synthetic pair ALWAYS exists, even at count zero, so the graph's shape
    // does not change as work moves through it (spec §8.3).
    { id: "pool", type: "pool" as const, label: "Unclaimed", status: "active", badges: { openTasks: poolRows.length, oldestAgeHours: oldest ? Math.floor((now.getTime() - Date.parse(oldest.createdAt)) / 3_600_000) : 0 } },
    { id: "you", type: "you" as const, label: "You", status: "active", badges: { questionsWaiting: Number(questionCount[0]?.n ?? 0) } },
  ];

  return { ok: true, value: { nodes, edges, window: { days, since }, now: stamp, cursorSeq: await eventTail(context.teamId) } };
}

function loopOutcomeBadge(rows: Run[]) {
  const newest = [...rows].sort((a, b) => (b.startedAt ?? b.ts).localeCompare(a.startedAt ?? a.ts))[0];
  return { lastOutcome: newest ? runDisplayState(newest) : null, lastRunAt: newest ? newest.finishedAt ?? newest.startedAt ?? newest.ts : null };
}
