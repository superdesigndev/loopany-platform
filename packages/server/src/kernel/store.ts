/**
 * Kernel store — the SERVER host for `@loopany/kernel` (design §9, milestone M5).
 *
 * The kernel is a PURE rulebook: `decide(command) -> Changeset | Refusal`, and a
 * driver's whole job is to persist that Changeset ATOMICALLY under CAS (§9: "all
 * or nothing"). The local driver folds it in-process; here the server folds it in
 * ONE Postgres transaction, over the same `applyChangeset` the kernel exports —
 * so the two backends cannot drift (the M6 conformance double-run is the proof).
 *
 * Team scope lives at THIS seam, not in the kernel model: a kernel workspace is
 * single-authority (no team column of its own), so we snapshot ONE team's rows,
 * decide against them, and stamp every written row with that team. A command can
 * never reach across teams because it only ever sees one team's snapshot.
 *
 * How the transaction maps to `applyChangeset`'s semantics: we re-read the team's
 * snapshot INSIDE the transaction, run `applyChangeset` to VALIDATE every
 * precondition (CAS on object version, whole-record CAS on triggers, state
 * precondition on runs, the one-active-run-per-task invariant), and on a conflict
 * we abort the transaction and surface the typed `ApplyConflict` — never a silent
 * fold. On success we write exactly the changeset's mutations (object upserts,
 * trigger put/delete, run insert/put, event appends).
 *
 * ATOMIC CAS requires a serialization point. On the hosted postgres-js pool
 * (db/index.ts) transactions run at READ COMMITTED, so a bare read-validate-write
 * is NOT enough: two concurrent applies against the same team can both read
 * version N, both pass `applyChangeset`, and both write N+1 with the
 * unconditional upserts below — a lost update that silently bypasses object CAS,
 * trigger/run preconditions AND the §5.1 one-active-run-per-task invariant. We
 * close that window by taking a per-team `pg_advisory_xact_lock` as the FIRST
 * statement of the transaction: it serializes every kernel apply for a given team
 * behind one exclusive lock (auto-released at commit/rollback), so the
 * read-validate-write is genuinely atomic regardless of isolation level. The lock
 * matches the one-write-authority model — a kernel workspace is single-authority,
 * so serializing its applies per team is the intended contention, not a hot path.
 * (pglite is single-connection so tests can't exercise a true two-connection race;
 * a real-postgres race test is recorded debt — see kernelStore.serialize.test.ts.)
 */
import { and, asc, eq, sql } from "drizzle-orm";

import {
  type ApplyConflict,
  type Changeset,
  type KernelEvent,
  type KernelObject,
  type RunRecord,
  type Snapshot,
  type Trigger,
  applyChangeset,
  emptySnapshot,
} from "@loopany/kernel";

import { db } from "../db/index.js";
import {
  kernelEvents,
  kernelObjects,
  kernelRuns,
  kernelTriggers,
} from "../db/schema.js";

// The kernel record kind for the `archetype` column — a KernelObject is a
// discriminated union, so its `archetype` is the discriminant we index on.
type Archetype = KernelObject["archetype"];

/** Read a team's full kernel snapshot (objects + triggers + runs). Events are the
 *  append-only audit and are NOT part of the decision Snapshot (kernel §3), so
 *  they are read separately by `readEvents`. */
export async function readSnapshot(teamId: string): Promise<Snapshot> {
  const [objRows, trgRows, runRows] = await Promise.all([
    db.select().from(kernelObjects).where(eq(kernelObjects.teamId, teamId)),
    db.select().from(kernelTriggers).where(eq(kernelTriggers.teamId, teamId)),
    db.select().from(kernelRuns).where(eq(kernelRuns.teamId, teamId)),
  ]);
  const objects: Record<string, KernelObject> = {};
  for (const r of objRows) objects[r.id] = r.data as KernelObject;
  return {
    objects,
    triggers: trgRows.map((r) => r.data as Trigger),
    runs: runRows.map((r) => r.data as RunRecord),
  };
}

/** A task/object's event stream (append-only, oldest-first) — the context ladder's
 *  `--log` rung. Scoped to the team; a cross-team objectId simply returns []. */
export async function readEvents(
  teamId: string,
  objectId?: string,
): Promise<KernelEvent[]> {
  const where = objectId
    ? and(eq(kernelEvents.teamId, teamId), eq(kernelEvents.objectId, objectId))
    : eq(kernelEvents.teamId, teamId);
  const rows = await db
    .select()
    .from(kernelEvents)
    .where(where)
    .orderBy(asc(kernelEvents.at));
  return rows.map((r) => r.data as KernelEvent);
}

export type ApplyOutcome =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; conflict: ApplyConflict };

/**
 * Apply a decided Changeset for one team, transactionally and CAS-checked.
 *
 * The whole read → validate → write happens in ONE transaction, serialized per
 * team by a `pg_advisory_xact_lock` taken as the FIRST statement, so the fold is
 * genuinely atomic under READ COMMITTED (see the module header) and the CAS check
 * reads committed state. On a precondition mismatch we throw a sentinel to roll
 * the transaction back (Drizzle only rolls back on a thrown error), then translate
 * it to a typed `ApplyConflict` — never a partial write.
 */
export async function applyChangesetForTeam(
  teamId: string,
  cs: Changeset,
): Promise<ApplyOutcome> {
  try {
    const snapshot = await db.transaction(async (tx) => {
      // SERIALIZE every kernel apply for this team behind one exclusive
      // transaction-scoped advisory lock, BEFORE the read. `hashtextextended`
      // maps the arbitrary team id to a stable bigint key (available on both
      // postgres and pglite); a fixed classifier seed namespaces kernel-apply
      // locks away from any other advisory-lock user. Auto-released at
      // commit/rollback, so a conflict rollback frees it immediately.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`kernel:apply:${teamId}`}, 0))`,
      );

      // Re-read the snapshot INSIDE the transaction (now under the lock) so the
      // CAS validation runs against committed state, not a stale pre-lock read.
      const [objRows, trgRows, runRows] = await Promise.all([
        tx.select().from(kernelObjects).where(eq(kernelObjects.teamId, teamId)),
        tx.select().from(kernelTriggers).where(eq(kernelTriggers.teamId, teamId)),
        tx.select().from(kernelRuns).where(eq(kernelRuns.teamId, teamId)),
      ]);
      const objects: Record<string, KernelObject> = {};
      for (const r of objRows) objects[r.id] = r.data as KernelObject;
      const current: Snapshot = {
        objects,
        triggers: trgRows.map((r) => r.data as Trigger),
        runs: runRows.map((r) => r.data as RunRecord),
      };

      // Validate every precondition against the just-read snapshot. A conflict
      // aborts (thrown sentinel → rollback), so nothing is written.
      const res = applyChangeset(current, cs);
      if (!res.ok) throw new ConflictSentinel(res.conflict);

      // Write exactly the changeset's mutations, stamped with the team.
      const now = nowIso();
      for (const m of cs.objects) {
        const obj = m.object;
        // Upsert on (teamId, id): an insert (expectedVersion null) or a version
        // bump. `createdAt` is preserved on update via onConflict's excluded-less
        // set; we take the object's own timestamps when present.
        const createdAt = objTimestamp(obj, "createdAt", now);
        const updatedAt = objTimestamp(obj, "updatedAt", now);
        await tx
          .insert(kernelObjects)
          .values({
            id: obj.id,
            teamId,
            archetype: obj.archetype as Archetype,
            version: obj.version,
            data: obj,
            createdAt,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: [kernelObjects.teamId, kernelObjects.id],
            set: { archetype: obj.archetype as Archetype, version: obj.version, data: obj, updatedAt },
          });
      }

      for (const m of cs.triggers) {
        if (m.op === "delete") {
          await tx
            .delete(kernelTriggers)
            .where(and(eq(kernelTriggers.teamId, teamId), eq(kernelTriggers.id, m.id)));
        } else {
          const t = m.trigger;
          await tx
            .insert(kernelTriggers)
            .values({
              id: t.id,
              teamId,
              taskId: t.taskId,
              kind: t.kind,
              enabled: t.enabled,
              nextFireAt: t.nextFireAt,
              data: t,
            })
            .onConflictDoUpdate({
              target: [kernelTriggers.teamId, kernelTriggers.id],
              set: {
                taskId: t.taskId,
                kind: t.kind,
                enabled: t.enabled,
                nextFireAt: t.nextFireAt,
                data: t,
              },
            });
        }
      }

      for (const m of cs.runs) {
        const run = m.run;
        await tx
          .insert(kernelRuns)
          .values({
            id: run.id,
            teamId,
            taskId: run.taskId,
            cause: run.cause,
            state: run.state,
            scheduledAt: run.scheduledAt,
            data: run,
          })
          .onConflictDoUpdate({
            target: [kernelRuns.teamId, kernelRuns.id],
            set: { taskId: run.taskId, cause: run.cause, state: run.state, scheduledAt: run.scheduledAt, data: run },
          });
      }

      // Events are append-only; the changeset already carries derived/organic ids
      // so a replay of the SAME changeset would collide on the (teamId,id) unique
      // index — do-nothing keeps append idempotent under an at-least-once caller.
      for (const ev of cs.events) {
        await tx
          .insert(kernelEvents)
          .values({ id: ev.id, teamId, objectId: ev.objectId, kind: ev.kind, at: ev.at, data: ev })
          .onConflictDoNothing({ target: [kernelEvents.teamId, kernelEvents.id] });
      }

      return res.snapshot;
    });
    return { ok: true, snapshot };
  } catch (e) {
    if (e instanceof ConflictSentinel) return { ok: false, conflict: e.conflict };
    throw e;
  }
}

/** Empty-snapshot helper re-export so callers/tests can build a base without
 *  importing the kernel package directly for this one shape. */
export { emptySnapshot };

class ConflictSentinel extends Error {
  constructor(readonly conflict: ApplyConflict) {
    super(conflict.message);
    this.name = "ConflictSentinel";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Pull a timestamp off a KernelObject (all three archetypes carry created/updated
 *  ISO strings); fall back to `fallback` if absent (defensive — kernel always sets them). */
function objTimestamp(obj: KernelObject, key: "createdAt" | "updatedAt", fallback: string): string {
  const v = (obj as unknown as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : fallback;
}
