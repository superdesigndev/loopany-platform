/**
 * The team-global To-Do list ingestion (see the `todo_items` table + the board
 * view in `components/TeamTodoView`). Every finalized run that produces a
 * MEANINGFUL result becomes one actionable item; the server creates items where
 * it already records run outcomes (`gateway/index.ts` report/finish/reclaim
 * finalize points) — ZERO daemon/protocol change.
 *
 * The ingestion rule + title derivation are PURE (`todoDecision`/`todoTitle`), so
 * they're unit-tested without a DB. The store-touching orchestration
 * (`ingestRunTodo`, `backfillTodos`) is idempotent by the `run_id` unique index:
 * a re-report, a backfill re-run, or a reclaim→wake-report reconcile upserts the
 * SAME row, refreshing the run-derived fields while PRESERVING the user's
 * status/priority/assignee/archived.
 */
import * as store from "../db/store.js";
import type { Loop, Run, TodoItem } from "../db/schema.js";

/** The run fields the ingestion rule + title look at (a slice of `Run`), so the
 *  pure helpers are callable from a test without a full row. */
export interface RunLike {
  role: "exec" | "evolve" | "edit";
  phase: "pending" | "running" | "done" | "error" | "canceled";
  outcome: Run["outcome"];
  status: Run["status"];
  message: string | null;
  error: string | null;
}

const TITLE_CAP = 140;

/**
 * The ingestion rule: does this finalized run produce a to-do item?
 *
 * Faithful to the brief ("runs with outcome ok/new, evolve, or a failure create
 * items; ok/nothing-new runs do not"), mapped onto the data model:
 *  - `edit` runs are internal owner config changes → never an item;
 *  - a canceled run (user stopped it) or a `skipped` deferral → never an item;
 *  - a FAILURE (phase `error`) → an item (even without a message);
 *  - a successful run (phase `done`) → an item UNLESS its content status is
 *    `nothing-new` (the explicit skip) or it was a `silent` workflow pass (ran,
 *    produced nothing to say). So ok/new, ok/resolved, evolve, and a plain `ok`
 *    (null status) all create items.
 */
export function todoDecision(r: RunLike): boolean {
  if (r.role === "edit") return false;
  if (r.phase === "canceled") return false;
  if (r.outcome === "skipped") return false;
  if (r.phase === "error") return true;
  if (r.phase === "done") {
    if (r.status === "nothing-new") return false;
    if (r.outcome === "silent") return false;
    return true;
  }
  return false; // still pending/running — not finalized, no item yet
}

/** Clip to a bound, appending an ellipsis when it actually truncated. */
function clip(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap - 1).trimEnd()}…` : s;
}

/** The first non-empty line, stripped of a leading markdown heading/bullet marker
 *  so a report opening with `# Title` reads as `Title` in the row. */
function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").trim();
}

/**
 * The item's title/summary, derived from the run's final report. A failure uses
 * its error; a success uses its message. When neither carries text, fall back to
 * a calm label from the loop name + the run's shape (so an item is never blank).
 */
export function todoTitle(r: RunLike, loopName: string | null): string {
  const name = (loopName || "Loop").trim();
  if (r.phase === "error") {
    const e = r.error ? firstLine(r.error) : "";
    return clip(e || `${name} — run failed`, TITLE_CAP);
  }
  const m = r.message ? firstLine(r.message) : "";
  if (m) return clip(m, TITLE_CAP);
  const label =
    r.role === "evolve"
      ? "self-improvement pass"
      : r.status === "resolved"
        ? "resolved"
        : "new result";
  return clip(`${name} — ${label}`, TITLE_CAP);
}

/** Project a finalized `Run` onto the pure-rule slice. */
function toRunLike(run: Run): RunLike {
  return {
    role: run.role,
    phase: run.phase,
    outcome: run.outcome,
    status: run.status,
    message: run.message ?? null,
    error: run.error ?? null,
  };
}

/**
 * Idempotently ingest a finalized run into the To-Do list. No-op (returns null)
 * when the run doesn't meet the ingestion rule. Called at each finalize point in
 * `gateway/index.ts`; safe to call more than once per run (upsert by `run_id`).
 * The `teamId` is denormalized from the source loop so the board is one query.
 */
export async function ingestRunTodo(run: Run, loop: Loop | undefined): Promise<TodoItem | null> {
  const rl = toRunLike(run);
  if (!todoDecision(rl)) return null;
  return store.upsertTodoFromRun({
    runId: run.id,
    loopId: run.loopId,
    teamId: loop?.teamId ?? null,
    machineId: run.machineId,
    role: run.role,
    outcome: run.outcome,
    runStatus: run.status,
    failed: run.phase === "error",
    title: todoTitle(rl, loop?.name ?? null),
    producedAt: run.ts,
  });
}

/** How far back the first-rollout backfill reaches. */
const BACKFILL_DAYS = 14;

/**
 * Seed the To-Do list from recent existing runs so the view isn't empty for
 * teams that predate the feature. Idempotent by construction (the `run_id` unique
 * index) — a re-run refreshes run-derived fields but never duplicates and never
 * clobbers a user's edits. Best-effort; returns how many runs it processed.
 */
export async function backfillTodos(sinceDays = BACKFILL_DAYS): Promise<number> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const finalized = await store.listFinalizedRunsSince(since);
  const loopCache = new Map<string, Loop | undefined>();
  let ingested = 0;
  for (const run of finalized) {
    if (!loopCache.has(run.loopId)) loopCache.set(run.loopId, await store.getLoop(run.loopId));
    if (await ingestRunTodo(run, loopCache.get(run.loopId))) ingested++;
  }
  return ingested;
}

/**
 * The first-rollout seed: backfill ONLY when the list is still empty (the gate is
 * the idempotency — a re-boot never re-processes history, going-forward items ride
 * the live ingestion). Best-effort; never throws into boot.
 */
export async function seedTodosIfEmpty(): Promise<number> {
  try {
    if ((await store.countTodos()) > 0) return 0;
    return await backfillTodos();
  } catch {
    return 0;
  }
}
