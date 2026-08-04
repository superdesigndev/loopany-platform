/**
 * Rewrite kernel — the minimal data-access layer over `objects` / `events` and
 * the runs queue columns.
 *
 * Same shape as `db/store.ts` (function-style, Drizzle not raw SQL, async
 * everywhere) with ONE addition, harvested from the graph line's `graphStore.ts`:
 * every function takes an optional executor as its first argument, so
 * `kernel/applyTransition.ts` can run a whole mutation — the row write plus its
 * event — inside ONE `db.transaction`.
 *
 * The layer is deliberately thin. It owns exactly the things a caller must not be
 * trusted to get right:
 *   - identity/dedup (deterministic ids + `ON CONFLICT DO NOTHING`),
 *   - the row lock that serializes two writers against one object,
 *   - key idempotency as an UPSERT, never a read-then-write race.
 * Everything policy-shaped (which transitions are legal, what a status change
 * must record, which facets a kind may carry) lives in `kernel/applyTransition.ts`.
 *
 * NOTE ON STATUS: no function here writes `objects.status` except
 * `setObjectStatus`, which exists solely for `applyTransition` to call. A content
 * write cannot smuggle a state change.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "./index.js";
import {
  events,
  objects,
  type KernelEvent,
  type KernelObject,
  type NewKernelEvent,
  type NewKernelObject,
} from "./kernel-schema.js";
import { runLeases, runs, type NewRun, type Run } from "./schema.js";

/**
 * Anything that can run a statement: the root `db` handle or a transaction from
 * `db.transaction(...)`. Structural on purpose — the two share the builder API,
 * which is the whole reason the store is single-sourced across driver tiers.
 */
export type KernelExec = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

const X = (x?: KernelExec): KernelExec => x ?? db;

// ---- objects ----

/**
 * Read an object and take its ROW LOCK, as the first statement of a mutation's
 * transaction. Two writers racing on the same object serialize here: the second
 * blocks until the first commits, then re-reads the POST-COMMIT row and
 * re-validates against it. Without this, two concurrent writers could both
 * compute `old` from the same pre-image and the diff would lie.
 */
export async function getObjectForUpdate(x: KernelExec | undefined, id: string): Promise<KernelObject | undefined> {
  const rows = await X(x).select().from(objects).where(eq(objects.id, id)).for("update");
  return rows[0];
}

export async function getObject(x: KernelExec | undefined, id: string): Promise<KernelObject | undefined> {
  return (await X(x).select().from(objects).where(eq(objects.id, id)))[0];
}

/** Resolve a creation key within a team — the §4.1 idempotency read, taken only
 *  AFTER an insert was swallowed, never as a pre-check. */
export async function getObjectByKey(
  x: KernelExec | undefined,
  teamId: string,
  key: string,
): Promise<KernelObject | undefined> {
  return (await X(x).select().from(objects).where(and(eq(objects.teamId, teamId), eq(objects.key, key))))[0];
}

/**
 * Insert an object, swallowing every conflict. Returns `inserted: false` when the
 * row already existed — either the primary key collided (a derived id replayed)
 * or `(team_id, key)` collided (idempotent re-create). The caller resolves which,
 * because only it knows whether it supplied a key.
 */
export async function insertObject(
  x: KernelExec | undefined,
  row: NewKernelObject,
): Promise<{ object?: KernelObject; inserted: boolean }> {
  const out = await X(x).insert(objects).values(row).onConflictDoNothing().returning();
  if (out[0]) return { object: out[0], inserted: true };
  return { inserted: false };
}

/** Content-field update. REFUSES `status` structurally — that column moves only
 *  through `setObjectStatus`, called only by `applyTransition`. */
export async function updateObjectFields(
  x: KernelExec | undefined,
  id: string,
  patch: Partial<Omit<NewKernelObject, "id" | "kind" | "teamId" | "key" | "status" | "createdAt">>,
): Promise<KernelObject | undefined> {
  return (await X(x).update(objects).set(patch).where(eq(objects.id, id)).returning())[0];
}

/**
 * THE STATUS WRITE. The only function in the codebase that moves
 * `objects.status`; `kernel/applyTransition.ts` is its only caller, and it calls
 * it inside the same transaction as the event that records the change.
 */
export async function setObjectStatus(
  x: KernelExec | undefined,
  id: string,
  patch: { status: string; updatedAt: string; closedAt?: string | null; nextFire?: string | null },
): Promise<KernelObject> {
  return (await X(x).update(objects).set(patch).where(eq(objects.id, id)).returning())[0]!;
}

// ---- events ----

/**
 * Append an event. Returns `inserted: false` when the id already existed — that
 * is the dedup invariant firing, and it is the normal, expected outcome for a
 * re-derived fact, NOT an error.
 *
 * There is no window, no "recent N" scan and no timestamp comparison anywhere in
 * this path: the id IS the dedup key, so a duplicate is caught identically
 * whether the original landed a second or a year ago.
 */
export async function appendEvent(
  x: KernelExec | undefined,
  row: NewKernelEvent,
): Promise<{ event: KernelEvent; inserted: boolean }> {
  const exec = X(x);
  const out = await exec.insert(events).values(row).onConflictDoNothing().returning();
  if (out[0]) return { event: out[0], inserted: true };
  const existing = (await exec.select().from(events).where(eq(events.id, row.id)))[0];
  if (!existing) throw new Error(`event insert was swallowed but no row exists: ${row.id}`);
  return { event: existing, inserted: false };
}

export async function getEvent(x: KernelExec | undefined, id: string): Promise<KernelEvent | undefined> {
  return (await X(x).select().from(events).where(eq(events.id, id)))[0];
}

/** An object's event tail, oldest first (the task/loop page's timeline). */
export async function listObjectEvents(x: KernelExec | undefined, objectId: string): Promise<KernelEvent[]> {
  return X(x).select().from(events).where(eq(events.objectId, objectId)).orderBy(asc(events.seq));
}

/** How many rows carry this exact id (0 or 1 — the dedup probe asserts it). */
export async function countEventsById(x: KernelExec | undefined, id: string): Promise<number> {
  const r = (await X(x).select({ n: sql<number>`count(*)` }).from(events).where(eq(events.id, id)))[0];
  return Number(r?.n ?? 0);
}

// ---- runs queue ----

/** What a queue insert actually did — the three outcomes §6.1 branches on. */
export type QueueRunOutcome =
  /** A fresh queued run landed. */
  | "queued"
  /** This exact run id already existed AND it belongs to this loop: a replayed
   *  fire, an idempotent no-op. */
  | "replay"
  /** The id existed but belongs to ANOTHER LOOP — the number is taken, not the
   *  fire replayed. For an ORGANIC (manual) run that is ordinary and the caller
   *  simply draws again; for a DERIVED one it is a truncation collision, and the
   *  caller must fail loudly rather than report a stranger's run as this loop's
   *  own (`runQueue.ts` `queueKernelRun` branches on exactly that difference). */
  | "id-taken"
  /** The loop already has a not-yet-executing run. Trigger paths join it rather
   *  than stacking another pending row. */
  | "loop-busy";

/**
 * Insert a run, swallowing an id replay and reporting which condition fired.
 *
 * The distinction matters: a primary-key collision is a REPLAY (harmless, the
 * fire already landed), while an existing pending run is the queue-discipline JOIN.
 * `queueKernelRun` locks the owning loop row before calling this function, so
 * the lookup and insert are one serialized transaction without relying on the
 * retired `runs_one_queued_idx`.
 *
 * The legacy NOT NULL columns (`userId`/`machineId`/`phase`/`role`/`ts`) are
 * supplied by the caller: this unit adds the queue columns to the shipping runs
 * table, so a rewrite run still has to fill the old ones. Unit 3 owns the
 * scheduler that calls this.
 */
export async function queueRun(
  x: KernelExec | undefined,
  row: NewRun & { queueState: "queued" | null },
): Promise<{ run?: Run; outcome: QueueRunOutcome }> {
  const exec = X(x);
  // Identity is the idempotency floor while a fire is open and after it
  // COMPLETES. A due fire that terminalized without completing is level-
  // triggered: re-arm this exact frozen id once the loop has no queued sibling.
  // Reusing the row (rather than minting a new id) preserves the derived seed.
  const byId = (await exec.select().from(runs).where(eq(runs.id, row.id!)))[0];
  if (byId) {
    if (byId.loopId !== row.loopId) return { run: byId, outcome: "id-taken" };
    const retryableDue =
      row.reason === "due" &&
      byId.reason === "due" &&
      (byId.phase === "error" || byId.phase === "canceled" || byId.queueState === "failure");
    if (!retryableDue) return { run: byId, outcome: "replay" };

    const open = await openRunForLoop(exec, row.loopId, row.queueState === "queued" ? "kernel" : "prod");
    if (open) return { run: open, outcome: "loop-busy" };
    // A shipping run reclaimed after claim can still have a terminal-grace
    // lease. Once this level trigger re-arms the same run identity, that old
    // authority must die before a new delivery can mint its lease.
    await exec.delete(runLeases).where(eq(runLeases.runId, byId.id));
    const rearmed = (
      await exec
        .update(runs)
        .set({
          ...row,
          outcome: null,
          status: null,
          message: null,
          durationMs: null,
          error: null,
          state: null,
          control: null,
          sessionId: null,
          costUsd: null,
          usage: null,
          artifacts: null,
          transcript: null,
          progress: null,
          claimedBy: null,
          claimedAt: null,
          leaseExpiresAt: null,
          leaseState: null,
          attempts: 0,
          reportDocId: null,
          outcomeSummary: null,
          runCost: null,
          startedAt: null,
          finishedAt: null,
        })
        .where(eq(runs.id, byId.id))
        .returning()
    )[0];
    if (!rearmed) throw new Error(`due run disappeared while re-arming: ${byId.id}`);
    return { run: rearmed, outcome: "queued" };
  }

  const open = await openRunForLoop(exec, row.loopId, row.queueState === "queued" ? "kernel" : "prod");
  if (open) return { run: open, outcome: "loop-busy" };

  const out = await exec.insert(runs).values(row).onConflictDoNothing().returning();
  if (out[0]) return { run: out[0], outcome: "queued" };
  const racedById = (await exec.select().from(runs).where(eq(runs.id, row.id!)))[0];
  // A primary-key hit is a REPLAY only if the existing row is this loop's own
  // run. Run ids are short (derived ones are a truncated hash), so an id hit on
  // a different loop is an identity collision — reporting it as a replay would
  // silently skip this loop's scheduled fire and hand back the other loop's run.
  if (racedById) return { run: racedById, outcome: racedById.loopId === row.loopId ? "replay" : "id-taken" };
  const racedOpen = await openRunForLoop(exec, row.loopId, row.queueState === "queued" ? "kernel" : "prod");
  if (racedOpen) return { run: racedOpen, outcome: "loop-busy" };
  throw new Error(`run insert was swallowed but neither id nor open-run holder exists: ${row.id}`);
}

/** The transactional `alreadyQueued` join rule. Only not-yet-executing rows can
 * absorb a trigger: a claimed/running row already consumed its delivery. */
export async function openRunForLoop(
  x: KernelExec | undefined,
  loopId: string,
  world: "kernel" | "prod",
): Promise<Run | undefined> {
  const condition = world === "kernel"
    ? eq(runs.queueState, "queued")
    : and(isNull(runs.queueState), eq(runs.phase, "pending"));
  return (
    await X(x)
      .select()
      .from(runs)
      .where(and(eq(runs.loopId, loopId), condition))
      .orderBy(asc(runs.ts))
      .limit(1)
  )[0];
}

export async function getRunRow(x: KernelExec | undefined, id: string): Promise<Run | undefined> {
  return (await X(x).select().from(runs).where(eq(runs.id, id)))[0];
}

/** The loop's currently queued run, if any. */
export async function queuedRunForLoop(x: KernelExec | undefined, loopId: string): Promise<Run | undefined> {
  return (
    await X(x)
      .select()
      .from(runs)
      .where(and(eq(runs.loopId, loopId), eq(runs.queueState, "queued")))
  )[0];
}
