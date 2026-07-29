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
  events,
  gateObligations,
  objects,
  outboxActions,
  typeRegistry,
  type GateObligation,
  type GraphEdge,
  type GraphEvent,
  type GraphObject,
  type NewGraphEvent,
  type OutboxAction,
  type TypeRegistryRow,
} from "./graph-schema.js";
import {
  BUILTIN_TYPE_SPECS,
  ARCHETYPES,
  consequenceOf,
  isActionKind,
  requiresApproval,
  type ActionKind,
  type Archetype,
  type EventDiff,
  type ObligationClass,
  type TypeSpec,
} from "../graph/types.js";
import { edgeId, mirrorObjectId, newObjectId, outboxActionId, typeVersionId } from "../graph/ids.js";

/**
 * Anything that can run a statement: the root `db` handle or a transaction from
 * `db.transaction(...)`. Structural on purpose - the two share the builder API,
 * which is the whole reason the store is single-sourced across driver tiers.
 */
export type GraphExec = Pick<typeof db, "select" | "insert" | "update" | "delete">;

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

export async function listPendingActions(
  x: GraphExec | undefined,
  filter: { teamId?: string; objectId?: string },
): Promise<OutboxAction[]> {
  const where = [eq(outboxActions.state, "pending")];
  if (filter.teamId) where.push(eq(outboxActions.teamId, filter.teamId));
  if (filter.objectId) where.push(eq(outboxActions.objectId, filter.objectId));
  return X(x).select().from(outboxActions).where(and(...where)).orderBy(asc(outboxActions.createdAt), asc(outboxActions.seq));
}

export async function countPendingActions(x: GraphExec | undefined, objectId: string): Promise<number> {
  const r = (
    await X(x)
      .select({ n: sql<number>`count(*)` })
      .from(outboxActions)
      .where(and(eq(outboxActions.objectId, objectId), eq(outboxActions.state, "pending")))
  )[0];
  return Number(r?.n ?? 0);
}

/**
 * Stamp an action delivered. The executor calls this AFTER the effect; a crash in
 * between leaves the row `pending` and the effect happens twice - the at-least-once
 * boundary, which is why every executor must be idempotent on the action id.
 */
export async function markActionDelivered(
  x: GraphExec | undefined,
  id: string,
  now: string,
): Promise<OutboxAction | undefined> {
  const out = await X(x)
    .update(outboxActions)
    .set({ state: "delivered", deliveredAt: now })
    .where(and(eq(outboxActions.id, id), eq(outboxActions.state, "pending")))
    .returning();
  return out[0];
}

export async function listActionsForEvent(x: GraphExec | undefined, eventId: string): Promise<OutboxAction[]> {
  return X(x).select().from(outboxActions).where(eq(outboxActions.eventId, eventId)).orderBy(asc(outboxActions.seq));
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
