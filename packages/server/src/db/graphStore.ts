/**
 * Graph Engineering v3 - the minimal data-access layer over the kernel tables.
 *
 * Same shape as `db/store.ts` (function-style, Drizzle not raw SQL, async
 * everywhere) with ONE addition: every function takes an optional executor as its
 * first argument, so `graph/applyTransition.ts` can run a whole transition -
 * status write, event, obligations, outbox rows - inside ONE `db.transaction`.
 * Called without one, each function runs standalone against `db`.
 *
 * The layer is deliberately thin. It owns exactly the three things a caller must
 * not be trusted to get right:
 *   - identity/dedup (deterministic ids + `ON CONFLICT DO NOTHING`),
 *   - mirror get-or-create as an UPSERT, never read-then-write,
 *   - resolving a type to its EFFECTIVE registry version and nothing else.
 * Everything policy-shaped (which transitions are legal, what a state change
 * must record) lives in `graph/applyTransition.ts`.
 *
 * NOTE ON STATUS: no function here writes `objects.status`. That column moves
 * only through `applyTransition`. `updateObjectFields` explicitly refuses status
 * so a content write can never smuggle a state change - the v2 doc-push-bypass
 * bug class, eliminated structurally (design §2).
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "./index.js";
import {
  edges,
  effectDirectives,
  events,
  gateObligations,
  graphNotifications,
  objects,
  outboxActions,
  typeRegistry,
  type EffectDirective,
  type GateObligation,
  type GraphEdge,
  type GraphEvent,
  type GraphNotification,
  type GraphObject,
  type NewEffectDirective,
  type NewGraphEvent,
  type NewGraphNotification,
  type OutboxAction,
  type TypeRegistryRow,
} from "./graph-schema.js";
import {
  BUILTIN_TYPE_SPECS,
  ARCHETYPES,
  DIRECTIVE_UNSETTLED_STATES,
  OUTBOX_UNSETTLED_STATES,
  consequenceOf,
  isActionKind,
  requiresApproval,
  type ActionKind,
  type Archetype,
  type DirectiveRefusalCode,
  type EventDiff,
  type ObligationClass,
  type OutboxRefusalCode,
  type TypeSpec,
} from "../graph/types.js";
import { edgeId, mirrorObjectId, newObjectId, outboxActionId, typeVersionId } from "../graph/ids.js";

/**
 * Anything that can run a statement: the root `db` handle or a transaction from
 * `db.transaction(...)`. Structural on purpose - the two share the builder API,
 * which is the whole reason the store is single-sourced across driver tiers.
 */
export type GraphExec = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

const X = (x?: GraphExec): GraphExec => x ?? db;

// ---- objects ----

export interface CreateObjectInput {
  teamId: string;
  archetype: Archetype;
  /** Registry type name; defaults to the archetype's own name. */
  type?: string;
  typeVersion?: number;
  /** Initial status. Callers should pass the effective spec's `initialState`;
   *  `createObject` does NOT validate it (creation is not a transition - the
   *  object has no prior state to guard). */
  status: string;
  title?: string | null;
  payload?: Record<string, unknown> | null;
  ownerUserId?: string | null;
  assigneeUserId?: string | null;
  cron?: string | null;
  timezone?: string | null;
  nextRunAt?: string | null;
  /** ISO. Passed in, never read from a clock. */
  now: string;
  /** Explicit id (a mirror's deterministic id, or a test fixture). */
  id?: string;
}

export async function createObject(x: GraphExec | undefined, input: CreateObjectInput): Promise<GraphObject> {
  const nowMs = Date.parse(input.now);
  const row = {
    id: input.id ?? newObjectId(Number.isNaN(nowMs) ? 0 : nowMs),
    teamId: input.teamId,
    archetype: input.archetype,
    type: input.type ?? input.archetype,
    typeVersion: input.typeVersion ?? 1,
    status: input.status,
    statusChangedAt: input.now,
    title: input.title ?? null,
    payload: input.payload ?? null,
    ownerUserId: input.ownerUserId ?? null,
    assigneeUserId: input.assigneeUserId ?? null,
    cron: input.cron ?? null,
    timezone: input.timezone ?? null,
    nextRunAt: input.nextRunAt ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return (await X(x).insert(objects).values(row).returning())[0]!;
}

export async function getObject(x: GraphExec | undefined, id: string): Promise<GraphObject | undefined> {
  return (await X(x).select().from(objects).where(eq(objects.id, id)))[0];
}

/**
 * Read an object under a ROW LOCK (`SELECT … FOR UPDATE`) - the actor-mailbox
 * primitive. Two transitions racing on the SAME object serialize here: the second
 * blocks until the first commits and then reads the POST-COMMIT row, so it
 * re-validates against the state that actually exists rather than overwriting a
 * decision it never saw. Objects are locked independently, so unrelated work is
 * unaffected.
 *
 * MUST be called inside a transaction - outside one the lock is released
 * immediately by the implicit commit and buys nothing. `applyTransition` is the
 * caller that matters, and it always runs in a transaction.
 */
export async function getObjectForUpdate(
  x: GraphExec | undefined,
  id: string,
): Promise<GraphObject | undefined> {
  return (await X(x).select().from(objects).where(eq(objects.id, id)).for("update"))[0];
}

export async function listObjects(
  x: GraphExec | undefined,
  teamId: string,
  filter?: { type?: string; status?: string },
): Promise<GraphObject[]> {
  const where = [eq(objects.teamId, teamId)];
  if (filter?.type) where.push(eq(objects.type, filter.type));
  if (filter?.status) where.push(eq(objects.status, filter.status));
  return X(x).select().from(objects).where(and(...where)).orderBy(asc(objects.createdAt));
}

/**
 * MIRROR GET-OR-CREATE (design §7 day-one invariant, §12 item 6).
 *
 * An UPSERT, never read-then-write: two workflows discovering the same external
 * entity at the same instant both attempt the insert, exactly one wins, and both
 * read back the SAME row. Under real concurrency the guarantee comes from the DB
 * - the deterministic primary key plus the partial `UNIQUE(team, source,
 * external_id) WHERE mirror` index - not from any ordering in this function.
 *
 * Idempotent by construction: calling it a thousand times yields one object.
 */
export async function getOrCreateMirror(
  x: GraphExec | undefined,
  input: {
    teamId: string;
    externalSource: string;
    externalId: string;
    type?: string;
    typeVersion?: number;
    status?: string;
    title?: string | null;
    payload?: Record<string, unknown> | null;
    now: string;
  },
): Promise<{ object: GraphObject; created: boolean }> {
  const exec = X(x);
  const id = mirrorObjectId(input.teamId, input.externalSource, input.externalId);
  const inserted = await exec
    .insert(objects)
    .values({
      id,
      teamId: input.teamId,
      archetype: "mirror",
      type: input.type ?? "mirror",
      typeVersion: input.typeVersion ?? 1,
      status: input.status ?? BUILTIN_TYPE_SPECS.mirror.initialState,
      statusChangedAt: input.now,
      title: input.title ?? null,
      payload: input.payload ?? null,
      externalSource: input.externalSource,
      externalId: input.externalId,
      externalObservedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { object: inserted[0], created: true };
  // Lost the race (or the mirror already existed): read the winner back by
  // IDENTITY, not by id, so a row that predates the deterministic-id scheme
  // still resolves.
  const existing = (
    await exec
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.teamId, input.teamId),
          eq(objects.archetype, "mirror"),
          eq(objects.externalSource, input.externalSource),
          eq(objects.externalId, input.externalId),
        ),
      )
  )[0];
  if (!existing) throw new Error(`mirror upsert lost its row: ${input.externalSource}/${input.externalId}`);
  return { object: existing, created: false };
}

/**
 * Update an object's CONTENT fields. Refuses `status` - a content write must
 * never be able to smuggle a state change (design §2). Status moves only through
 * `applyTransition`, which writes the column directly in its own transaction.
 */
export async function updateObjectFields(
  x: GraphExec | undefined,
  id: string,
  patch: Partial<Omit<GraphObject, "id" | "teamId" | "status" | "statusChangedAt" | "createdAt">>,
  now: string,
): Promise<GraphObject | undefined> {
  if ("status" in patch) throw new Error("updateObjectFields cannot write status - use applyTransition");
  const out = await X(x)
    .update(objects)
    .set({ ...patch, updatedAt: now })
    .where(eq(objects.id, id))
    .returning();
  return out[0];
}

/** Record that a mirror was observed (freshness stamp only - never its status). */
export async function stampMirrorObserved(x: GraphExec | undefined, id: string, now: string): Promise<void> {
  await X(x).update(objects).set({ externalObservedAt: now, updatedAt: now }).where(eq(objects.id, id));
}

/**
 * INGEST AN OBSERVATION onto a mirror - the ONE write path that may move a
 * mirror's `status`, and the counterpart to `applyTransition` for the other side
 * of the world.
 *
 * WHY THIS IS NOT A HOLE IN THE CHOKEPOINT. `objects.status` moves through
 * `applyTransition` for everything we own, and `applyTransition` refuses a mirror
 * STRUCTURALLY (`ARCHETYPE_HAS_NO_STATE_MACHINE`) because a mirror has no
 * our-side state machine - its state is the external world's. That leaves exactly
 * one legitimate way for a mirror's status to change: an observation. This
 * function is that way, and it is narrowed on three axes so it can never become a
 * second, softer transition seam:
 *
 *   - `WHERE archetype = 'mirror'` is in the statement itself, so it physically
 *     cannot touch a task or a doc. A caller that passes a task id writes
 *     nothing and gets `undefined` back - not a silent success;
 *   - it takes no transition name and consults no spec: there is nothing to
 *     guard, because an observation is not a decision;
 *   - it is called only from `graph/sensing/observe.ts`, which writes the derived
 *     `external-changed` event in the SAME transaction. The event is what makes
 *     the change auditable, and pairing them there rather than here keeps this
 *     function a single statement.
 *
 * `status` is optional: a sweep that found nothing changed still stamps freshness
 * (`externalObservedAt`) so "when did we last look?" is answerable separately
 * from "when did it last move?".
 */
export async function recordMirrorObservation(
  x: GraphExec | undefined,
  input: {
    id: string;
    /** The projected observed state. Omitted ⇒ freshness stamp only. */
    status?: string;
    /** Full replacement payload (the caller merges onto the existing one). */
    payload?: Record<string, unknown> | null;
    title?: string | null;
    now: string;
  },
): Promise<GraphObject | undefined> {
  const out = await X(x)
    .update(objects)
    .set({
      ...(input.status !== undefined ? { status: input.status, statusChangedAt: input.now } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      externalObservedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(eq(objects.id, input.id), eq(objects.archetype, "mirror")))
    .returning();
  return out[0];
}

/**
 * Every mirror of one external source, oldest first - the FRESHNESS sweep's scope
 * (design §7: the watch list is "derived mechanically", never an external query).
 *
 * Unbounded by design: the whole point of the dedup invariant is that a re-poll
 * of a known entity is free, so the sweep looks at all of them and the diff
 * decides what is news. `limit` exists for a bounded first pass, not for
 * correctness.
 */
export async function listMirrors(
  x: GraphExec | undefined,
  teamId: string,
  filter: { externalSource: string; type?: string; limit?: number },
): Promise<GraphObject[]> {
  const where = [
    eq(objects.teamId, teamId),
    eq(objects.archetype, "mirror"),
    eq(objects.externalSource, filter.externalSource),
  ];
  if (filter.type) where.push(eq(objects.type, filter.type));
  const q = X(x).select().from(objects).where(and(...where)).orderBy(asc(objects.createdAt), asc(objects.id));
  return filter.limit ? q.limit(filter.limit) : q;
}

// ---- edges ----

/**
 * Idempotent edge insert. The id is derived from `{teamId, kind, srcId, dstId}`,
 * so the same relation asserted twice is one row and the second call is a no-op.
 */
export async function upsertEdge(
  x: GraphExec | undefined,
  input: {
    teamId: string;
    kind: string;
    srcId: string;
    dstId: string;
    meta?: Record<string, unknown> | null;
    createdByEvent?: string | null;
    now: string;
  },
): Promise<{ edge: GraphEdge; created: boolean }> {
  const exec = X(x);
  const id = edgeId(input);
  const inserted = await exec
    .insert(edges)
    .values({
      id,
      teamId: input.teamId,
      kind: input.kind,
      srcId: input.srcId,
      dstId: input.dstId,
      meta: input.meta ?? null,
      createdByEvent: input.createdByEvent ?? null,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { edge: inserted[0], created: true };
  return { edge: (await exec.select().from(edges).where(eq(edges.id, id)))[0]!, created: false };
}

export async function edgesFrom(x: GraphExec | undefined, srcId: string, kind?: string): Promise<GraphEdge[]> {
  const where = kind ? and(eq(edges.srcId, srcId), eq(edges.kind, kind)) : eq(edges.srcId, srcId);
  return X(x).select().from(edges).where(where);
}

export async function edgesTo(x: GraphExec | undefined, dstId: string, kind?: string): Promise<GraphEdge[]> {
  const where = kind ? and(eq(edges.dstId, dstId), eq(edges.kind, kind)) : eq(edges.dstId, dstId);
  return X(x).select().from(edges).where(where);
}

// ---- events ----

/**
 * Append an event. Returns `inserted: false` when the id already existed - that
 * is the dedup invariant firing, and it is the normal, expected outcome for a
 * re-derived fact, NOT an error.
 *
 * There is no window, no "recent N" scan, and no timestamp comparison anywhere in
 * this path: the id IS the dedup key, so a duplicate is caught identically
 * whether the original landed a second or a year ago.
 */
export async function appendEvent(
  x: GraphExec | undefined,
  row: NewGraphEvent,
): Promise<{ event: GraphEvent; inserted: boolean }> {
  const exec = X(x);
  const out = await exec.insert(events).values(row).onConflictDoNothing().returning();
  if (out[0]) return { event: out[0], inserted: true };
  const existing = (await exec.select().from(events).where(eq(events.id, row.id)))[0];
  if (!existing) throw new Error(`event insert was swallowed but no row exists: ${row.id}`);
  return { event: existing, inserted: false };
}

export async function getEvent(x: GraphExec | undefined, id: string): Promise<GraphEvent | undefined> {
  return (await X(x).select().from(events).where(eq(events.id, id)))[0];
}

export async function listObjectEvents(x: GraphExec | undefined, objectId: string): Promise<GraphEvent[]> {
  return X(x).select().from(events).where(eq(events.objectId, objectId)).orderBy(asc(events.ts), asc(events.id));
}

export async function countEvents(x: GraphExec | undefined, teamId: string): Promise<number> {
  const r = (await X(x).select({ n: sql<number>`count(*)` }).from(events).where(eq(events.teamId, teamId)))[0];
  return Number(r?.n ?? 0);
}

/** How many event rows carry this exact id (0 or 1 - the dedup probe asserts it). */
export async function countEventsById(x: GraphExec | undefined, id: string): Promise<number> {
  const r = (await X(x).select({ n: sql<number>`count(*)` }).from(events).where(eq(events.id, id)))[0];
  return Number(r?.n ?? 0);
}

// ---- gate obligations ----

/**
 * Open an obligation, keyed `(objectId, key)`. Re-running the transition that
 * opens it re-opens nothing: the composite primary key makes it idempotent, and
 * the original `openedByEvent` is preserved so the audit trail names the FIRST
 * opener, not the latest replay.
 */
export async function openObligation(
  x: GraphExec | undefined,
  input: {
    objectId: string;
    key: string;
    teamId: string;
    class: ObligationClass;
    label?: string | null;
    openedByEvent: string;
    nextReminderAt?: string | null;
    now: string;
  },
): Promise<{ obligation: GateObligation; opened: boolean }> {
  const exec = X(x);
  const inserted = await exec
    .insert(gateObligations)
    .values({
      objectId: input.objectId,
      key: input.key,
      teamId: input.teamId,
      class: input.class,
      label: input.label ?? null,
      openedByEvent: input.openedByEvent,
      openedAt: input.now,
      nextReminderAt: input.nextReminderAt ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { obligation: inserted[0], opened: true };
  const existing = (
    await exec
      .select()
      .from(gateObligations)
      .where(and(eq(gateObligations.objectId, input.objectId), eq(gateObligations.key, input.key)))
  )[0]!;
  return { obligation: existing, opened: false };
}

/**
 * Close an obligation BY AN EVENT. Only an OPEN obligation is closed (the
 * `closedByEvent IS NULL` predicate), so a replayed closing transition never
 * rewrites which event closed it. Returns undefined when there was nothing open
 * under that key.
 */
export async function closeObligation(
  x: GraphExec | undefined,
  input: { objectId: string; key: string; closedByEvent: string; now: string },
): Promise<GateObligation | undefined> {
  const out = await X(x)
    .update(gateObligations)
    .set({ closedByEvent: input.closedByEvent, closedAt: input.now })
    .where(
      and(
        eq(gateObligations.objectId, input.objectId),
        eq(gateObligations.key, input.key),
        isNull(gateObligations.closedByEvent),
      ),
    )
    .returning();
  return out[0];
}

/**
 * THE INBOX (captain decision 3): computed `opened − closed`, never read off a
 * status column. An object holding three independent waits contributes three
 * rows; closing one leaves the other two, which a single status column could
 * never represent.
 */
export async function listOpenObligations(
  x: GraphExec | undefined,
  teamId: string,
  filter?: { class?: ObligationClass; objectId?: string },
): Promise<GateObligation[]> {
  const where = [eq(gateObligations.teamId, teamId), isNull(gateObligations.closedByEvent)];
  if (filter?.class) where.push(eq(gateObligations.class, filter.class));
  if (filter?.objectId) where.push(eq(gateObligations.objectId, filter.objectId));
  return X(x).select().from(gateObligations).where(and(...where)).orderBy(asc(gateObligations.openedAt));
}

export async function listObjectObligations(x: GraphExec | undefined, objectId: string): Promise<GateObligation[]> {
  return X(x)
    .select()
    .from(gateObligations)
    .where(eq(gateObligations.objectId, objectId))
    .orderBy(asc(gateObligations.openedAt));
}

export async function countOpenObligations(x: GraphExec | undefined, objectId: string): Promise<number> {
  const r = (
    await X(x)
      .select({ n: sql<number>`count(*)` })
      .from(gateObligations)
      .where(and(eq(gateObligations.objectId, objectId), isNull(gateObligations.closedByEvent)))
  )[0];
  return Number(r?.n ?? 0);
}

// ---- outbox actions ----

export interface EnqueueActionInput {
  kind: ActionKind;
  payload?: Record<string, unknown> | null;
  /** REQUIRED for an R3/R4 action. The DB CHECK is the real guard; this call
   *  refuses first so the caller gets a legible error instead of a constraint. */
  approvalEvent?: string | null;
}

/**
 * Enqueue a transition's actions in the SAME transaction that wrote its event -
 * the outbox pattern, and the idempotency red line (design §5). Ids are
 * `<eventId>-<seq>`, so a replayed transition produces the same ids and collides
 * instead of double-effecting.
 *
 * The consequence class is DERIVED from the action kind (`graph/types.ts`), never
 * supplied by the caller: "outward and governance effects are non-auto-approvable"
 * must be a property of the system, not a convention a caller can violate.
 */
export async function enqueueActions(
  x: GraphExec | undefined,
  input: {
    eventId: string;
    teamId: string;
    objectId?: string | null;
    chainDepth?: number;
    actions: EnqueueActionInput[];
    now: string;
  },
): Promise<OutboxAction[]> {
  if (!input.actions.length) return [];
  const rows = input.actions.map((a, seq) => {
    if (!isActionKind(a.kind)) throw new Error(`unknown action kind: ${String(a.kind)}`);
    const consequenceClass = consequenceOf(a.kind);
    if (requiresApproval(consequenceClass) && !a.approvalEvent) {
      throw new Error(
        `action "${a.kind}" is ${consequenceClass} (outward/governance) and requires an approval event - ` +
          "it cannot be auto-approved",
      );
    }
    return {
      id: outboxActionId(input.eventId, seq),
      eventId: input.eventId,
      seq,
      teamId: input.teamId,
      objectId: input.objectId ?? null,
      kind: a.kind as string,
      consequenceClass,
      approvalEvent: a.approvalEvent ?? null,
      chainDepth: input.chainDepth ?? 0,
      payload: a.payload ?? null,
      state: "pending" as const,
      attempts: 0,
      createdAt: input.now,
    };
  });
  const out = await X(x).insert(outboxActions).values(rows).onConflictDoNothing().returning();
  if (out.length) return out;
  // Full replay: every id already existed. Read the originals back.
  const ids = rows.map((r) => r.id);
  return X(x)
    .select()
    .from(outboxActions)
    .where(inArray(outboxActions.id, ids))
    .orderBy(asc(outboxActions.seq));
}

/**
 * Actions that have NOT yet had their effect - `pending`, `executing` or `failed`
 * (awaiting a scheduled retry). The attested-close check reads this, so a row
 * mid-flight or backing off blocks a terminal transition exactly like one that
 * was never attempted (design §12 item 8).
 */
export async function listPendingActions(
  x: GraphExec | undefined,
  filter: { teamId?: string; objectId?: string },
): Promise<OutboxAction[]> {
  const where = [inArray(outboxActions.state, [...OUTBOX_UNSETTLED_STATES])];
  if (filter.teamId) where.push(eq(outboxActions.teamId, filter.teamId));
  if (filter.objectId) where.push(eq(outboxActions.objectId, filter.objectId));
  return X(x).select().from(outboxActions).where(and(...where)).orderBy(asc(outboxActions.createdAt), asc(outboxActions.seq));
}

export async function countPendingActions(x: GraphExec | undefined, objectId: string): Promise<number> {
  const r = (
    await X(x)
      .select({ n: sql<number>`count(*)` })
      .from(outboxActions)
      .where(
        and(
          eq(outboxActions.objectId, objectId),
          inArray(outboxActions.state, [...OUTBOX_UNSETTLED_STATES]),
        ),
      )
  )[0];
  return Number(r?.n ?? 0);
}

/**
 * Stamp an action DONE - its effect landed. Guarded on the row still being
 * unsettled, so a late second stamp (the at-least-once boundary firing) is a
 * no-op rather than a rewrite of when the effect happened.
 */
export async function markActionDone(
  x: GraphExec | undefined,
  id: string,
  now: string,
): Promise<OutboxAction | undefined> {
  const out = await X(x)
    .update(outboxActions)
    .set({ state: "done", deliveredAt: now, lastError: null, claimedAt: null, claimedBy: null, nextAttemptAt: null })
    .where(and(eq(outboxActions.id, id), inArray(outboxActions.state, [...OUTBOX_UNSETTLED_STATES])))
    .returning();
  return out[0];
}

/**
 * CLAIM a batch of due actions for one executor pass.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` inside the same statement that flips the rows
 * to `executing` is what makes the executor safe to run more than once: two
 * passes racing on the same queue take DISJOINT sets, because the loser's rows
 * are skipped rather than blocked on. `attempts` is incremented AT CLAIM TIME, so
 * a claim that then crashes still burns an attempt - otherwise a handler that
 * reliably kills the process would retry forever.
 *
 * Claimable = `pending` or `failed` (a retry whose backoff has elapsed), PLUS
 * `executing` rows whose claim is older than `staleBefore` - a crashed executor's
 * work, recovered. Re-running an effect is safe by the at-least-once contract.
 */
export async function claimActions(
  x: GraphExec | undefined,
  input: { limit: number; now: string; owner: string; staleBefore: string; teamId?: string },
): Promise<OutboxAction[]> {
  const teamFilter = input.teamId ? sql`and team_id = ${input.teamId}` : sql``;
  const rows = await X(x).execute(sql`
    update outbox_actions set
      state = 'executing',
      claimed_at = ${input.now},
      claimed_by = ${input.owner},
      attempts = attempts + 1
    where id in (
      select id from outbox_actions
      where (
              state in ('pending','failed')
              and (next_attempt_at is null or next_attempt_at <= ${input.now})
            )
         or (state = 'executing' and claimed_at is not null and claimed_at < ${input.staleBefore})
        ${teamFilter}
      order by created_at asc, seq asc
      limit ${input.limit}
      for update skip locked
    )
    returning *
  `);
  return normalizeActionRows(rows);
}

/**
 * Record a FAILED attempt and schedule the retry. The row goes back to `failed`
 * (not `pending`): "tried and failed, retrying at T" is a different fact from
 * "never tried", and only one of them is worth a second look.
 */
export async function markActionFailed(
  x: GraphExec | undefined,
  input: { id: string; error: string; nextAttemptAt: string },
): Promise<OutboxAction | undefined> {
  const out = await X(x)
    .update(outboxActions)
    .set({
      state: "failed",
      lastError: input.error,
      nextAttemptAt: input.nextAttemptAt,
      claimedAt: null,
      claimedBy: null,
    })
    .where(eq(outboxActions.id, input.id))
    .returning();
  return out[0];
}

/**
 * DEAD-LETTER an action: terminal, without effect, with a TYPED reason. This is
 * the one thing the executor must never do silently - a dropped consequence that
 * nobody can see is worse than a loud one, so every dead-letter becomes an
 * attention item until a human acknowledges or retries it.
 */
export async function deadLetterAction(
  x: GraphExec | undefined,
  input: { id: string; refusalCode: OutboxRefusalCode; error: string; now: string },
): Promise<OutboxAction | undefined> {
  const out = await X(x)
    .update(outboxActions)
    .set({
      state: "dead-letter",
      refusalCode: input.refusalCode,
      lastError: input.error,
      deadLetteredAt: input.now,
      claimedAt: null,
      claimedBy: null,
      nextAttemptAt: null,
    })
    .where(eq(outboxActions.id, input.id))
    .returning();
  return out[0];
}

/** Put a dead-lettered action back in the queue with a fresh attempt budget -
 *  the human "retry" verdict on an attention item. Only a dead-letter row can be
 *  revived, so this can never disturb work in flight. */
export async function requeueDeadLetter(
  x: GraphExec | undefined,
  id: string,
): Promise<OutboxAction | undefined> {
  const out = await X(x)
    .update(outboxActions)
    .set({
      state: "pending",
      attempts: 0,
      refusalCode: null,
      deadLetteredAt: null,
      nextAttemptAt: null,
      claimedAt: null,
      claimedBy: null,
    })
    .where(and(eq(outboxActions.id, id), eq(outboxActions.state, "dead-letter")))
    .returning();
  return out[0];
}

export async function listDeadLetters(x: GraphExec | undefined, teamId: string): Promise<OutboxAction[]> {
  return X(x)
    .select()
    .from(outboxActions)
    .where(and(eq(outboxActions.teamId, teamId), eq(outboxActions.state, "dead-letter")))
    .orderBy(asc(outboxActions.deadLetteredAt));
}

export async function getAction(x: GraphExec | undefined, id: string): Promise<OutboxAction | undefined> {
  return (await X(x).select().from(outboxActions).where(eq(outboxActions.id, id)))[0];
}

export async function listActionsForEvent(x: GraphExec | undefined, eventId: string): Promise<OutboxAction[]> {
  return X(x).select().from(outboxActions).where(eq(outboxActions.eventId, eventId)).orderBy(asc(outboxActions.seq));
}

/**
 * A raw `execute()` returns driver-shaped output: postgres-js hands back the row
 * array directly, pglite wraps it in `{rows}`. Both tiers are single-sourced
 * everywhere else in this file because they go through the query builder; the
 * claim statement cannot (there is no builder form of `FOR UPDATE SKIP LOCKED`
 * inside an UPDATE … IN subquery), so the shape is normalized here, once.
 *
 * Column names come back snake_case, so they are mapped to the Drizzle row shape
 * rather than cast - a cast would silently hand callers `undefined` for every
 * multi-word column.
 */
function normalizeActionRows(raw: unknown): OutboxAction[] {
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    eventId: String(r.event_id),
    seq: Number(r.seq),
    teamId: String(r.team_id),
    objectId: (r.object_id ?? null) as string | null,
    kind: String(r.kind),
    consequenceClass: r.consequence_class as OutboxAction["consequenceClass"],
    approvalEvent: (r.approval_event ?? null) as string | null,
    chainDepth: Number(r.chain_depth ?? 0),
    payload: (r.payload ?? null) as Record<string, unknown> | null,
    state: r.state as OutboxAction["state"],
    attempts: Number(r.attempts ?? 0),
    lastError: (r.last_error ?? null) as string | null,
    createdAt: String(r.created_at),
    deliveredAt: (r.delivered_at ?? null) as string | null,
    nextAttemptAt: (r.next_attempt_at ?? null) as string | null,
    claimedAt: (r.claimed_at ?? null) as string | null,
    claimedBy: (r.claimed_by ?? null) as string | null,
    deadLetteredAt: (r.dead_lettered_at ?? null) as string | null,
    refusalCode: (r.refusal_code ?? null) as OutboxAction["refusalCode"],
  }));
}

// ---- notifications (the `notify` action's in-graph effect) ----

/**
 * Write a notification. IDEMPOTENT BY IDENTITY: the id is the producing outbox
 * action's id, so the at-least-once boundary costs nothing - a second delivery
 * conflicts on the primary key and the row it would have written already exists.
 * Returns `created: false` in exactly that case, which is the probe's assertion.
 */
export async function insertNotification(
  x: GraphExec | undefined,
  row: NewGraphNotification,
): Promise<{ notification: GraphNotification; created: boolean }> {
  const exec = X(x);
  const out = await exec.insert(graphNotifications).values(row).onConflictDoNothing().returning();
  if (out[0]) return { notification: out[0], created: true };
  const existing = (await exec.select().from(graphNotifications).where(eq(graphNotifications.id, row.id)))[0];
  if (!existing) throw new Error(`notification insert was swallowed but no row exists: ${row.id}`);
  return { notification: existing, created: false };
}

export async function listNotifications(
  x: GraphExec | undefined,
  teamId: string,
  limit = 50,
): Promise<GraphNotification[]> {
  return X(x)
    .select()
    .from(graphNotifications)
    .where(eq(graphNotifications.teamId, teamId))
    .orderBy(desc(graphNotifications.createdAt), desc(graphNotifications.id))
    .limit(limit);
}

export async function countUnreadNotifications(x: GraphExec | undefined, teamId: string): Promise<number> {
  const r = (
    await X(x)
      .select({ n: sql<number>`count(*)` })
      .from(graphNotifications)
      .where(and(eq(graphNotifications.teamId, teamId), isNull(graphNotifications.readAt)))
  )[0];
  return Number(r?.n ?? 0);
}

export async function markNotificationsRead(
  x: GraphExec | undefined,
  teamId: string,
  now: string,
): Promise<number> {
  const out = await X(x)
    .update(graphNotifications)
    .set({ readAt: now })
    .where(and(eq(graphNotifications.teamId, teamId), isNull(graphNotifications.readAt)))
    .returning();
  return out.length;
}

// ---- effect directives (the outward-effect work orders) ----

/**
 * Write a directive. IDEMPOTENT BY IDENTITY, exactly like `insertNotification`:
 * the id IS the producing outbox action's id, so the executor's at-least-once
 * boundary produces ONE work order however many times the handler runs. There is
 * no read-then-write and no "already exists?" branch - the primary key is the
 * check.
 */
export async function insertDirective(
  x: GraphExec | undefined,
  row: NewEffectDirective,
): Promise<{ directive: EffectDirective; created: boolean }> {
  const exec = X(x);
  const out = await exec.insert(effectDirectives).values(row).onConflictDoNothing().returning();
  if (out[0]) return { directive: out[0], created: true };
  const existing = (await exec.select().from(effectDirectives).where(eq(effectDirectives.id, row.id)))[0];
  if (!existing) throw new Error(`directive insert was swallowed but no row exists: ${row.id}`);
  return { directive: existing, created: false };
}

export async function getDirective(x: GraphExec | undefined, id: string): Promise<EffectDirective | undefined> {
  return (await X(x).select().from(effectDirectives).where(eq(effectDirectives.id, id)))[0];
}

export async function listDirectives(
  x: GraphExec | undefined,
  teamId: string,
  limit = 50,
): Promise<EffectDirective[]> {
  return X(x)
    .select()
    .from(effectDirectives)
    .where(eq(effectDirectives.teamId, teamId))
    .orderBy(desc(effectDirectives.createdAt), desc(effectDirectives.id))
    .limit(limit);
}

export async function listFailedDirectives(x: GraphExec | undefined, teamId: string): Promise<EffectDirective[]> {
  return X(x)
    .select()
    .from(effectDirectives)
    .where(and(eq(effectDirectives.teamId, teamId), eq(effectDirectives.state, "failed")))
    .orderBy(asc(effectDirectives.settledAt));
}

export async function countUnsettledDirectives(x: GraphExec | undefined, teamId: string): Promise<number> {
  const r = (
    await X(x)
      .select({ n: sql<number>`count(*)` })
      .from(effectDirectives)
      .where(and(eq(effectDirectives.teamId, teamId), inArray(effectDirectives.state, [...DIRECTIVE_UNSETTLED_STATES])))
  )[0];
  return Number(r?.n ?? 0);
}

/**
 * CLAIM a batch of directives for one agent, with a LEASE.
 *
 * The same `SELECT … FOR UPDATE SKIP LOCKED` shape the outbox claim uses, and for
 * the same reason: two agents polling at once take DISJOINT sets instead of one
 * blocking on the other, so "run a second effect agent" is a capacity decision
 * rather than a correctness risk. `attempts` increments AT CLAIM TIME, so an agent
 * that dies on the same row every time exhausts its budget instead of holding the
 * directive hostage forever.
 *
 * Claimable = `pending`. Rows whose lease has expired are returned to `pending`
 * by `expireDirectiveLeases` FIRST - a separate statement on purpose, because
 * "this claim is dead" is a decision worth being able to observe (and to bound by
 * an attempt budget) rather than a subclause of the claim query.
 */
export async function claimDirectives(
  x: GraphExec | undefined,
  input: { limit: number; now: string; agent: string; leaseUntil: string; teamId?: string; machine?: string },
): Promise<EffectDirective[]> {
  const teamFilter = input.teamId ? sql`and team_id = ${input.teamId}` : sql``;
  // A directive BOUND to a machine is only ever offered to that machine; an
  // unbound one is offered to anybody. Never the other way round - silently
  // handing somebody else's work order to a machine with different credentials is
  // exactly the class of mistake this column exists to prevent.
  const machineFilter = input.machine
    ? sql`and (target_machine is null or target_machine = ${input.machine})`
    : sql`and target_machine is null`;
  const rows = await X(x).execute(sql`
    update effect_directives set
      state = 'claimed',
      claimed_at = ${input.now},
      claimed_by = ${input.agent},
      heartbeat_at = ${input.now},
      lease_expires_at = ${input.leaseUntil},
      attempts = attempts + 1
    where id in (
      select id from effect_directives
      where state = 'pending'
        ${teamFilter}
        ${machineFilter}
      order by created_at asc, id asc
      limit ${input.limit}
      for update skip locked
    )
    returning *
  `);
  return normalizeDirectiveRows(rows);
}

/** Extend the lease on a claim the agent still holds. Guarded on the holder, so a
 *  heartbeat from an agent whose lease was already reclaimed cannot resurrect it
 *  under the new owner - it simply matches nothing, and the agent learns it lost
 *  the row when it tries to report. */
export async function heartbeatDirective(
  x: GraphExec | undefined,
  input: { id: string; agent: string; now: string; leaseUntil: string },
): Promise<EffectDirective | undefined> {
  const out = await X(x)
    .update(effectDirectives)
    .set({ heartbeatAt: input.now, leaseExpiresAt: input.leaseUntil })
    .where(
      and(
        eq(effectDirectives.id, input.id),
        eq(effectDirectives.state, "claimed"),
        eq(effectDirectives.claimedBy, input.agent),
      ),
    )
    .returning();
  return out[0];
}

/**
 * Settle a directive, either way. Guarded on it still being CLAIMED BY THIS AGENT:
 * a report that arrives after the lease was reclaimed changes nothing, so a
 * zombie agent waking up an hour later cannot overwrite the outcome its successor
 * recorded. The caller learns that from the `undefined` return.
 */
export async function settleDirective(
  x: GraphExec | undefined,
  input: {
    id: string;
    agent: string;
    now: string;
    ok: boolean;
    result?: Record<string, unknown> | null;
    refusalCode?: DirectiveRefusalCode | null;
    error?: string | null;
  },
): Promise<EffectDirective | undefined> {
  const out = await X(x)
    .update(effectDirectives)
    .set({
      state: input.ok ? "done" : "failed",
      result: input.result ?? null,
      refusalCode: input.ok ? null : (input.refusalCode ?? "AGENT_ERROR"),
      lastError: input.error ?? null,
      settledAt: input.now,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(effectDirectives.id, input.id),
        eq(effectDirectives.state, "claimed"),
        eq(effectDirectives.claimedBy, input.agent),
      ),
    )
    .returning();
  return out[0];
}

/**
 * Return every EXPIRED claim to `pending` - the dead-agent recovery path.
 *
 * Two outcomes, decided by the attempt budget: under it the row is claimable
 * again (a laptop that slept comes back and somebody re-runs the effect, which is
 * safe because every effect is idempotent at the far end); at or over it the row
 * FAILS with `LEASE_EXPIRED`, because an effect that has eaten N leases without
 * reporting is not going to complete on its own and a person should hear about it.
 */
export async function expireDirectiveLeases(
  x: GraphExec | undefined,
  input: { now: string; maxAttempts: number; teamId?: string },
): Promise<{ requeued: EffectDirective[]; failed: EffectDirective[] }> {
  const exec = X(x);
  const where = [
    eq(effectDirectives.state, "claimed"),
    sql`${effectDirectives.leaseExpiresAt} is not null and ${effectDirectives.leaseExpiresAt} <= ${input.now}`,
  ];
  if (input.teamId) where.push(eq(effectDirectives.teamId, input.teamId));
  const stale = await exec.select().from(effectDirectives).where(and(...where));
  const requeued: EffectDirective[] = [];
  const failed: EffectDirective[] = [];
  for (const row of stale) {
    if (row.attempts >= input.maxAttempts) {
      const out = await exec
        .update(effectDirectives)
        .set({
          state: "failed",
          refusalCode: "LEASE_EXPIRED",
          lastError: `claimed ${row.attempts} time(s) and never reported - the effect agent went away`,
          settledAt: input.now,
          leaseExpiresAt: null,
        })
        .where(and(eq(effectDirectives.id, row.id), eq(effectDirectives.state, "claimed")))
        .returning();
      if (out[0]) failed.push(out[0]);
      continue;
    }
    const out = await exec
      .update(effectDirectives)
      .set({ state: "pending", claimedAt: null, claimedBy: null, leaseExpiresAt: null })
      .where(and(eq(effectDirectives.id, row.id), eq(effectDirectives.state, "claimed")))
      .returning();
    if (out[0]) requeued.push(out[0]);
  }
  return { requeued, failed };
}

/** Put a FAILED directive back in the queue with a fresh attempt budget - the
 *  human "retry" verdict on an attention item. Only a failed row can be revived,
 *  so this can never disturb an effect in flight. Symmetric with
 *  `requeueDeadLetter`, deliberately: the two attention verbs behave the same. */
export async function requeueDirective(
  x: GraphExec | undefined,
  id: string,
): Promise<EffectDirective | undefined> {
  const out = await X(x)
    .update(effectDirectives)
    .set({
      state: "pending",
      attempts: 0,
      refusalCode: null,
      lastError: null,
      settledAt: null,
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(effectDirectives.id, id), eq(effectDirectives.state, "failed")))
    .returning();
  return out[0];
}

/** The claim statement is raw SQL for the same reason `claimActions` is (there is
 *  no builder form of `FOR UPDATE SKIP LOCKED` inside an `UPDATE … IN`), so its
 *  driver-shaped, snake_cased result is mapped here - once. */
function normalizeDirectiveRows(raw: unknown): EffectDirective[] {
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    teamId: String(r.team_id),
    actionId: String(r.action_id),
    eventId: String(r.event_id),
    objectId: (r.object_id ?? null) as string | null,
    kind: r.kind as EffectDirective["kind"],
    targetSource: String(r.target_source),
    targetExternalId: String(r.target_external_id),
    targetMachine: (r.target_machine ?? null) as string | null,
    payload: (r.payload ?? null) as Record<string, unknown> | null,
    approvalEvent: String(r.approval_event),
    state: r.state as EffectDirective["state"],
    attempts: Number(r.attempts ?? 0),
    claimedAt: (r.claimed_at ?? null) as string | null,
    claimedBy: (r.claimed_by ?? null) as string | null,
    leaseExpiresAt: (r.lease_expires_at ?? null) as string | null,
    heartbeatAt: (r.heartbeat_at ?? null) as string | null,
    result: (r.result ?? null) as Record<string, unknown> | null,
    refusalCode: (r.refusal_code ?? null) as EffectDirective["refusalCode"],
    lastError: (r.last_error ?? null) as string | null,
    createdAt: String(r.created_at),
    settledAt: (r.settled_at ?? null) as string | null,
  }));
}

/** Events of one kind for a team, newest first - the attention section's feed
 *  (`chain-parked`, `close-refused`, and the acknowledgements that close them). */
export async function listEventsOfKind(
  x: GraphExec | undefined,
  teamId: string,
  kind: string,
  limit = 200,
): Promise<GraphEvent[]> {
  return X(x)
    .select()
    .from(events)
    .where(and(eq(events.teamId, teamId), eq(events.kind, kind)))
    .orderBy(desc(events.ts), desc(events.id))
    .limit(limit);
}

// ---- type registry ----

/**
 * Land a PROPOSAL (captain decision 4). A proposal is inert: nothing resolves it,
 * no guard can see it. `armTypeVersion` is the only path to `effective`.
 */
export async function proposeTypeVersion(
  x: GraphExec | undefined,
  input: {
    teamId: string;
    name: string;
    archetype: Archetype;
    version: number;
    spec: TypeSpec;
    rationale?: string | null;
    proposedByEvent?: string | null;
    now: string;
  },
): Promise<TypeRegistryRow> {
  const id = typeVersionId(input.teamId, input.name, input.version);
  const out = await X(x)
    .insert(typeRegistry)
    .values({
      id,
      teamId: input.teamId,
      name: input.name,
      archetype: input.archetype,
      version: input.version,
      state: "proposed",
      spec: input.spec,
      rationale: input.rationale ?? null,
      proposedByEvent: input.proposedByEvent ?? null,
      proposedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (out[0]) return out[0];
  return (await X(x).select().from(typeRegistry).where(eq(typeRegistry.id, id)))[0]!;
}

/**
 * ARM a proposal: the ONLY promotion from proposed to effective. Retires whatever
 * was effective for that `(team, name)` in the SAME statement pair, so the
 * partial unique index never sees two effective rows - and a reader mid-arm sees
 * either the old version or the new one, never both and never neither.
 */
export async function armTypeVersion(
  x: GraphExec | undefined,
  input: { teamId: string; name: string; version: number; armedByEvent?: string | null; now: string },
): Promise<TypeRegistryRow | undefined> {
  const exec = X(x);
  await exec
    .update(typeRegistry)
    .set({ state: "retired", retiredAt: input.now })
    .where(
      and(
        eq(typeRegistry.teamId, input.teamId),
        eq(typeRegistry.name, input.name),
        eq(typeRegistry.state, "effective"),
      ),
    );
  const out = await exec
    .update(typeRegistry)
    .set({ state: "effective", armedAt: input.now, armedByEvent: input.armedByEvent ?? null })
    .where(
      and(
        eq(typeRegistry.teamId, input.teamId),
        eq(typeRegistry.name, input.name),
        eq(typeRegistry.version, input.version),
      ),
    )
    .returning();
  return out[0];
}

/**
 * Resolve the EFFECTIVE version of a type, and nothing else (captain decision 4 /
 * the trusted-ref rule). A proposal is invisible here by construction, so a guard
 * physically cannot resolve a version that arrived with the payload it is
 * validating.
 */
export async function getEffectiveType(
  x: GraphExec | undefined,
  teamId: string,
  name: string,
): Promise<TypeRegistryRow | undefined> {
  return (
    await X(x)
      .select()
      .from(typeRegistry)
      .where(and(eq(typeRegistry.teamId, teamId), eq(typeRegistry.name, name), eq(typeRegistry.state, "effective")))
  )[0];
}

export async function listTypeVersions(
  x: GraphExec | undefined,
  teamId: string,
  name: string,
): Promise<TypeRegistryRow[]> {
  return X(x)
    .select()
    .from(typeRegistry)
    .where(and(eq(typeRegistry.teamId, teamId), eq(typeRegistry.name, name)))
    .orderBy(desc(typeRegistry.version));
}

/**
 * Seed the three archetype base types as effective v1 for a team (idempotent).
 *
 * This exists so that decision 4 has NO exception: every status resolution - even
 * a plain task's - goes through `getEffectiveType`. Archetype specs are defined
 * in code (`BUILTIN_TYPE_SPECS`); this only materializes them per team so there
 * is one resolution path rather than a registry path and a hardcoded fallback.
 */
export async function seedBuiltinTypes(x: GraphExec | undefined, teamId: string, now: string): Promise<void> {
  for (const archetype of ARCHETYPES) {
    const existing = await getEffectiveType(x, teamId, archetype);
    if (existing) continue;
    await proposeTypeVersion(x, {
      teamId,
      name: archetype,
      archetype,
      version: 1,
      spec: BUILTIN_TYPE_SPECS[archetype],
      rationale: "built-in archetype base type",
      now,
    });
    await armTypeVersion(x, { teamId, name: archetype, version: 1, now });
  }
}

export type { EventDiff };
