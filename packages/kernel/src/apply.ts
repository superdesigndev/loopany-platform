/**
 * applyChangeset — the pure state-fold every driver shares. A driver's whole
 * job is to persist exactly this fold atomically; tests and the local driver
 * use it directly, the server driver mirrors it in SQL.
 *
 * §9 promises CAS: every mutation carries a precondition, and this fold
 * VALIDATES each one against the target snapshot before touching it. A stale
 * changeset (computed against an older snapshot) yields a typed `ApplyConflict`
 * instead of silently resurrecting an old version — the same guarantee whether
 * the fold happens here or in SQL on the server.
 *
 * `World` adds the append-only event log (events are the audit, not part of
 * the decision Snapshot) so hosts and golden tests can carry both together.
 */
import {
  ACTIVE_RUN_STATES,
  type Changeset,
  type KernelEvent,
  type KernelObject,
  type RunRecord,
  type Snapshot,
  type Trigger,
} from "./types.js";

export interface ApplyConflict {
  kind: "object" | "trigger" | "run";
  id: string;
  message: string;
}

export type ApplyResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; conflict: ApplyConflict };

/** Validate every precondition, then fold. Returns a typed conflict rather
 *  than throwing (drivers translate it to their transport). */
export function applyChangeset(snapshot: Snapshot, cs: Changeset): ApplyResult {
  // ---- objects (CAS on version; null = must-not-exist) ----
  const objects: Record<string, KernelObject> = { ...snapshot.objects };
  for (const m of cs.objects) {
    const current = objects[m.object.id];
    if (m.expectedVersion === null) {
      if (current) {
        return conflict("object", m.object.id, `"${m.object.id}" already exists`);
      }
    } else {
      if (!current) {
        return conflict("object", m.object.id, `"${m.object.id}" does not exist (expected version ${m.expectedVersion})`);
      }
      if (current.version !== m.expectedVersion) {
        return conflict(
          "object",
          m.object.id,
          `"${m.object.id}" is version ${current.version}, expected ${m.expectedVersion}`,
        );
      }
    }
    // The written version MUST advance the CAS token to (expected ?? 0) + 1, or
    // the token never moves and a second stale changeset expecting the same
    // version applies again (§9 CAS defeated). decide always satisfies this
    // (creates emit 1/null, updates emit N+1/N); a hand-built changeset that
    // does not is a conflict.
    const requiredVersion = (m.expectedVersion ?? 0) + 1;
    if (m.object.version !== requiredVersion) {
      return conflict(
        "object",
        m.object.id,
        `"${m.object.id}" writes version ${m.object.version}, must be ${requiredVersion} (expected + 1)`,
      );
    }
    objects[m.object.id] = m.object;
  }

  // ---- triggers (per-id put|delete, CAS on the read trigger) ----
  const triggers = new Map<string, Trigger>(snapshot.triggers.map((t) => [t.id, t]));
  const seenTriggerIds = new Set<string>();
  for (const m of cs.triggers) {
    const id = m.op === "delete" ? m.id : m.trigger.id;
    // A changeset must never carry two ops for one trigger id — the fold order
    // would silently pick a winner. Reject it as a conflict instead.
    if (seenTriggerIds.has(id)) {
      return conflict("trigger", id, `trigger "${id}" mutated twice in one changeset`);
    }
    seenTriggerIds.add(id);
    const current = triggers.get(id);
    if (m.op === "delete") {
      if (!triggersEqual(current, m.expected)) {
        return conflict("trigger", id, `trigger "${id}" changed under a stale delete`);
      }
      triggers.delete(id);
    } else if (m.expected === null) {
      if (current) {
        return conflict("trigger", id, `trigger "${id}" already exists (expected must-not-exist)`);
      }
      triggers.set(id, m.trigger);
    } else {
      if (!triggersEqual(current, m.expected)) {
        return conflict("trigger", id, `trigger "${id}" changed under a stale put`);
      }
      triggers.set(id, m.trigger);
    }
  }

  // ---- runs (insert = must-not-exist; put = state precondition) ----
  const runs = new Map<string, RunRecord>(snapshot.runs.map((r) => [r.id, r]));
  for (const m of cs.runs) {
    if (m.op === "insert") {
      if (runs.has(m.run.id)) {
        return conflict("run", m.run.id, `run "${m.run.id}" already exists`);
      }
      // The one-active-run-per-task invariant (spec line 108) is enforced at the
      // FOLD too, not just at decision time — two decisions from the same snapshot
      // at different nows derive different run ids and both pass the id check, so
      // the id guard alone is not enough. Inserting a run in an ACTIVE state
      // conflicts if the task already has an active run in the working map. This
      // is order-safe: within a changeset a supersede `put` (fireCron) precedes
      // its insert, so it clears the prior active run before we look.
      if (ACTIVE_RUN_STATES.includes(m.run.state) && activeRunFor(runs, m.run.taskId)) {
        return conflict("run", m.run.id, `task "${m.run.taskId}" already has an active run`);
      }
    } else {
      const current = runs.get(m.run.id);
      if (!current) {
        return conflict("run", m.run.id, `run "${m.run.id}" does not exist`);
      }
      if (!m.expectedState.includes(current.state)) {
        return conflict(
          "run",
          m.run.id,
          `run "${m.run.id}" is ${current.state}, expected one of ${m.expectedState.join("|")}`,
        );
      }
    }
    runs.set(m.run.id, m.run);
  }

  return {
    ok: true,
    snapshot: {
      objects,
      triggers: [...triggers.values()],
      runs: [...runs.values()],
    },
  };
}

/** The unconditional fold — skips precondition checks. Internal + test use
 *  only, for changesets known to be consistent with the snapshot they were
 *  decided against (the spec's "split unsafe fold for tests"). */
export function foldChangeset(snapshot: Snapshot, cs: Changeset): Snapshot {
  const objects: Record<string, KernelObject> = { ...snapshot.objects };
  for (const m of cs.objects) objects[m.object.id] = m.object;

  const triggers = new Map<string, Trigger>(snapshot.triggers.map((t) => [t.id, t]));
  for (const m of cs.triggers) {
    if (m.op === "delete") triggers.delete(m.id);
    else triggers.set(m.trigger.id, m.trigger);
  }

  const runs = new Map<string, RunRecord>(snapshot.runs.map((r) => [r.id, r]));
  for (const m of cs.runs) runs.set(m.run.id, m.run);

  return { objects, triggers: [...triggers.values()], runs: [...runs.values()] };
}

function conflict(kind: ApplyConflict["kind"], id: string, message: string): ApplyResult {
  return { ok: false, conflict: { kind, id, message } };
}

/** Is there an active run for `taskId` in the working run map? (The fold-time
 *  twin of decide's `activeRun`, over the mutated map so within-changeset
 *  supersedes are already reflected.) */
function activeRunFor(runs: Map<string, RunRecord>, taskId: string): boolean {
  for (const r of runs.values()) {
    if (r.taskId === taskId && ACTIVE_RUN_STATES.includes(r.state)) return true;
  }
  return false;
}

/** Structural trigger equality — the CAS precondition compares the whole read
 *  trigger, so any divergence (a spec/tz/enabled/cursor edit under the base)
 *  conflicts. `undefined` (absent) equals only an `null` expectation. */
function triggersEqual(a: Trigger | undefined, b: Trigger | null): boolean {
  if (!a) return b === null;
  if (b === null) return false;
  return (
    a.id === b.id &&
    a.taskId === b.taskId &&
    a.kind === b.kind &&
    a.spec === b.spec &&
    a.timezone === b.timezone &&
    a.enabled === b.enabled &&
    a.disabledBy === b.disabledBy &&
    a.nextFireAt === b.nextFireAt
  );
}

export interface World {
  snapshot: Snapshot;
  events: KernelEvent[];
}

export function emptyWorld(): World {
  return { snapshot: { objects: {}, triggers: [], runs: [] }, events: [] };
}

export type WorldResult =
  | { ok: true; world: World }
  | { ok: false; conflict: ApplyConflict };

/** Validate + fold into a World (snapshot + audit log). Conflicts surface
 *  typed; events only append on success. */
export function applyToWorld(world: World, cs: Changeset): WorldResult {
  const res = applyChangeset(world.snapshot, cs);
  if (!res.ok) return res;
  return { ok: true, world: { snapshot: res.snapshot, events: [...world.events, ...cs.events] } };
}

/** Unconditional World fold (test/internal companion to `foldChangeset`). */
export function foldToWorld(world: World, cs: Changeset): World {
  return {
    snapshot: foldChangeset(world.snapshot, cs),
    events: [...world.events, ...cs.events],
  };
}
