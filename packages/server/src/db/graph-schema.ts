/**
 * Graph Engineering v3 - the kernel tables (Drizzle, Postgres `pg-core`).
 *
 * ADDITIVE UNIT: these five tables plus the type registry stand alongside the
 * existing machines/loops/runs schema and rewire nothing. The loops → objects
 * migration is a later unit (design §13); until then no existing runtime path
 * reads or writes anything here.
 *
 * Conventions match `db/schema.ts` exactly - text ids, ISO-string timestamps
 * (`text`, no db-side defaults), typed `jsonb().$type<>()` - so the store stays
 * single-sourced across the postgres-js and pglite driver tiers.
 *
 * The kernel is HARD and the type layer is SOFT (design §2): the columns here are
 * what the engine itself depends on; everything type-specific rides in `payload`.
 *
 * Three invariants are enforced by the SCHEMA, not by callers:
 *   1. Mirror identity is globally unique per team - a partial UNIQUE index on
 *      `(team_id, external_source, external_id) WHERE archetype = 'mirror'`
 *      (design §7, §12 item 6). Get-or-create is an upsert, never read-then-write.
 *   2. A state-change event cannot exist without its transition name and its
 *      per-field diff - a CHECK constraint (captain decision 1; it cannot be
 *      backfilled, so it is decided at schema time).
 *   3. An outward (R3) or governance (R4) action cannot exist without an approval
 *      event reference - a CHECK constraint (captain decision 2). No configuration
 *      can make those effects auto-approved.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, integer, jsonb, index, uniqueIndex, primaryKey, check } from "drizzle-orm/pg-core";

import {
  ACTION_KINDS,
  ARCHETYPES,
  ENTRANCE_CLASSES,
  CONSEQUENCE_CLASSES,
  EVENT_ORIGINS,
  OBLIGATION_CLASSES,
  OUTBOX_REFUSAL_CODES,
  OUTBOX_STATES,
  TYPE_VERSION_STATES,
  type EventDiff,
  type TypeSpec,
} from "../graph/types.js";

// ---- objects: every node of the graph (task / doc / mirror) ----

export const objects = pgTable(
  "objects",
  {
    /** `obj-<ulid>`, or `obj-mir-<sha256>` for a mirror (deterministic identity). */
    id: text("id").primaryKey(),
    /** Owning team - the scope everything in the graph is listed/authorized by. */
    teamId: text("team_id").notNull(),
    /** The engine contract this object obeys. Generic engine paths branch ONLY here. */
    archetype: text("archetype", { enum: ARCHETYPES }).notNull(),
    /** Registry type name. A base object carries its archetype name verbatim; a
     *  custom type carries its own name and declares this archetype as its parent. */
    type: text("type").notNull(),
    /** The EFFECTIVE registry version in force when this object was created.
     *  Instances record their creation-time version so a later breaking version
     *  is a migration decision, not a silent reinterpretation (design §4). */
    typeVersion: integer("type_version").notNull().default(1),
    /**
     * The guarded state. WRITES MUST FLOW THROUGH `graph/applyTransition.ts` -
     * that module is the only place in the codebase that updates this column, and
     * it writes the status, its event, its obligations and its outbox rows in ONE
     * transaction.
     *
     * The DB-LEVEL enforcement that makes a direct `UPDATE objects SET status`
     * physically impossible (a trigger token vs a column grant) is a PENDING
     * CAPTAIN DECISION and is deliberately NOT implemented in this unit; see the
     * `StatusWriteAuthorizer` seam in `graph/applyTransition.ts`, which either
     * option drops into without touching this schema.
     */
    status: text("status").notNull(),
    /** When `status` last changed (ISO) - stuck-time aggregates read this. */
    statusChangedAt: text("status_changed_at").notNull(),
    title: text("title"),
    /** Type-specific fields. Within a type version, readers trust the shape
     *  (design §3): defensive reads belong at type-version boundaries only. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Creator attribution (a user id, or null for engine-created objects). */
    ownerUserId: text("owner_user_id"),
    /** Who owes the work. Meaningful for the `task` archetype only. */
    assigneeUserId: text("assignee_user_id"),
    /** Scheduling - a Task with `cron` set IS a Loop (design §4). Null otherwise. */
    cron: text("cron"),
    /** IANA tz the cron is interpreted in. Null ⇒ server local. */
    timezone: text("timezone"),
    /** One-shot next fire (ISO), mirroring `loops.nextRunAt`. */
    nextRunAt: text("next_run_at"),
    /** Mirror identity: the external system (`github`, `linear`, …). Null for
     *  task/doc. Together with `externalId` this is the global uniqueness key. */
    externalSource: text("external_source"),
    /** Mirror identity within the source (`org/repo/issues/1291`). */
    externalId: text("external_id"),
    /** Last time an observation was ingested for this mirror (ISO). */
    externalObservedAt: text("external_observed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("objects_team_idx").on(t.teamId),
    index("objects_team_type_idx").on(t.teamId, t.type),
    index("objects_team_status_idx").on(t.teamId, t.status),
    // Mirror global uniqueness (design §7 day-one invariant): two workflows that
    // discover the same external entity CONVERGE on one mirror. Partial so that
    // task/doc rows - which all have NULL external identity - are unaffected.
    uniqueIndex("objects_mirror_identity_idx")
      .on(t.teamId, t.externalSource, t.externalId)
      .where(sql`${t.archetype} = 'mirror'`),
    // A mirror without a full external identity is not addressable and would slip
    // past the partial unique index; refuse it at the schema.
    check(
      "objects_mirror_identity_complete",
      sql`${t.archetype} <> 'mirror' OR (${t.externalSource} IS NOT NULL AND ${t.externalId} IS NOT NULL)`,
    ),
    // A mirror is never assignable or schedulable (design §4 contract).
    check(
      "objects_mirror_not_schedulable",
      sql`${t.archetype} <> 'mirror' OR (${t.cron} IS NULL AND ${t.assigneeUserId} IS NULL)`,
    ),
  ],
);

// ---- edges: first-class typed relations (hierarchy lives here, not in a parent pointer) ----

export const edges = pgTable(
  "edges",
  {
    /** `edge-<sha256(canonical fields)>` - deterministic, so the same relation
     *  re-derived by two workflows is ONE row and insert is idempotent. The
     *  canonical fields are exactly `{teamId, kind, srcId, dstId}`; `meta` is
     *  excluded on purpose so an edge's identity is stable as its metadata grows. */
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    /** Relation type: `blocks`, `tracks`, `produces`, `reviews`, `informs`, …
     *  Deliberately an open vocabulary (text, not an enum): edge kinds grow with
     *  compiled workflows, and an unknown kind must degrade to "an edge", never
     *  fail a migration. */
    kind: text("kind").notNull(),
    srcId: text("src_id").notNull(),
    dstId: text("dst_id").notNull(),
    /** Non-identifying annotation (weights, provenance labels). */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    /** The event that brought this edge into being (audit; null for seeds). */
    createdByEvent: text("created_by_event"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    // Graph traversal (recursive CTEs for aggregation, design §2) walks both ways.
    index("edges_src_idx").on(t.srcId, t.kind),
    index("edges_dst_idx").on(t.dstId, t.kind),
    index("edges_team_idx").on(t.teamId),
  ],
);

// ---- events: the append-only record ----

export const events = pgTable(
  "events",
  {
    /**
     * `ev-<sha256(identity)>` when `origin = 'derived'`, `ev-<ulid>` when
     * `origin = 'organic'`. The DEDUP INVARIANT is structural: a re-derivable
     * fact's id is a pure function of the fact, so re-deriving it collides on
     * this primary key and `ON CONFLICT DO NOTHING` makes the second insert a
     * no-op. A window is NEVER a dedup key (design §12 item 6) - nothing here
     * consults recency, and correctness does not degrade with history length.
     */
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    /** The object this event is about. Null for graph-level events (a type was
     *  armed, a compile landed) that belong to no single object. */
    objectId: text("object_id"),
    /** `status-changed`, `object-created`, `external-changed`, `gate-opened`,
     *  `gate-closed`, `chain-parked`, … Open vocabulary for the same reason
     *  `edges.kind` is. */
    kind: text("kind").notNull(),
    /** How the id was minted - names which half of the dedup invariant applies. */
    origin: text("origin", { enum: EVENT_ORIGINS }).notNull(),
    /**
     * The transition that produced a state change. NOT NULL for every
     * `status-changed` event (CHECK below) - captain decision 1: an event must be
     * sufficient ON ITS OWN to say what happened, because this cannot be
     * backfilled later.
     */
    transition: text("transition"),
    /** Per-field `{old, new}` for every field this event changed (`status` plus
     *  `payload.<key>` entries). NOT NULL for every `status-changed` event. */
    diff: jsonb("diff").$type<EventDiff>(),
    /** Everything else the event carries (attestations, observation bodies, …). */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /**
     * PROVENANCE, half one: which transition entrance produced this event -
     * `human` | `agent-run` | `rule` | `clock`. NOT NULL, which is a stronger
     * guarantee than the payload-sufficiency CHECK below: no event of any kind
     * can exist without its provenance. Landed in v1 for the same reason the
     * diff is: it cannot be backfilled, so an event written without it is
     * permanently unattributable.
     *
     * Distinct from `origin` above: `entrance` is HOW the transition was entered,
     * `origin` is whether the event's id is re-derivable. Neither implies the other.
     */
    entrance: text("entrance", { enum: ENTRANCE_CLASSES }).notNull(),
    /** PROVENANCE, half two: the CONCRETE actor for that entrance class - user id
     *  / run id / rule id / schedule id. NOT NULL, never a placeholder. */
    actorId: text("actor_id").notNull(),
    ts: text("ts").notNull(),
  },
  (t) => [
    index("events_object_ts_idx").on(t.objectId, t.ts),
    index("events_team_ts_idx").on(t.teamId, t.ts),
    index("events_kind_idx").on(t.kind),
    // Provenance queries ("everything this run did", "everything this user decided").
    index("events_actor_idx").on(t.entrance, t.actorId),
    // PAYLOAD SUFFICIENCY (captain decision 1), enforced structurally so no write
    // path - present or future - can land a state change that cannot be read back.
    // Provenance needs no CHECK: `entrance`/`actor_id` are NOT NULL on every row.
    check(
      "events_state_change_payload_sufficient",
      sql`${t.kind} <> 'status-changed' OR (${t.transition} IS NOT NULL AND ${t.diff} IS NOT NULL)`,
    ),
  ],
);

// ---- gate_obligations: the "waiting on you" inbox, computed opened-minus-closed ----

/**
 * Keyed obligations (captain decision 3). An object can hold SEVERAL independent
 * waits at once, which is why the inbox is computed as `opened − closed` over
 * this table and never derived from the single `objects.status` column.
 *
 * `(object_id, key)` is the composite primary key, so re-running the transition
 * that opens an obligation re-opens nothing - idempotency by identity, again.
 */
export const gateObligations = pgTable(
  "gate_obligations",
  {
    objectId: text("object_id").notNull(),
    /** Stable per-object obligation key (`awaiting-merge`, `needs-review`, …). */
    key: text("key").notNull(),
    teamId: text("team_id").notNull(),
    /** `human-verdict` (actively owed by a person - top of the inbox) vs
     *  `external-wait` (passive; re-surfaced on a bounded schedule so a forgotten
     *  wait cannot rot invisibly). The two carry different alarm cadences. */
    class: text("class", { enum: OBLIGATION_CLASSES }).notNull(),
    /** Human-readable "what are we waiting on", rendered as the inbox row. */
    label: text("label"),
    /** The event that opened it - every obligation is opened BY an event. */
    openedByEvent: text("opened_by_event").notNull(),
    openedAt: text("opened_at").notNull(),
    /** The event that closed it. NULL ⇒ still open; this is the inbox predicate. */
    closedByEvent: text("closed_by_event"),
    closedAt: text("closed_at"),
    /** Next time a passive (`external-wait`) obligation should re-surface (ISO). */
    nextReminderAt: text("next_reminder_at"),
  },
  (t) => [
    primaryKey({ columns: [t.objectId, t.key] }),
    // THE INBOX QUERY. Partial so its size tracks open work, not total history.
    index("gate_obligations_open_idx").on(t.teamId, t.class).where(sql`${t.closedByEvent} IS NULL`),
    index("gate_obligations_object_idx").on(t.objectId),
    // Closed is closed: both stamps land together or neither does.
    check(
      "gate_obligations_closed_pair",
      sql`(${t.closedByEvent} IS NULL) = (${t.closedAt} IS NULL)`,
    ),
  ],
);

// ---- outbox_actions: the transactional outbox (design §5 idempotency red line) ----

/**
 * A transition and its pending actions are written in ONE transaction; the
 * executor dedups by action id, so replays are safe. The id is `<event_id>-<seq>`
 * - a pure function of the producing event and the action's position in the
 * transition spec, so a replayed transition produces the SAME action ids and
 * collides instead of double-effecting.
 *
 * AT-LEAST-ONCE BOUNDARY (design §12 item 8): a `pending` row may be delivered
 * more than once (a crash between the effect and the stamp is indistinguishable
 * from a crash before it). Every executor MUST be idempotent on `id`.
 */
export const outboxActions = pgTable(
  "outbox_actions",
  {
    /** `<event_id>-<seq>`. */
    id: text("id").primaryKey(),
    /** The event whose transaction enqueued this action. */
    eventId: text("event_id").notNull(),
    /** Position within the transition's action list (0-based). */
    seq: integer("seq").notNull(),
    teamId: text("team_id").notNull(),
    /** The object the transition ran on (null for graph-level actions). */
    objectId: text("object_id"),
    /** One of the declarative engine primitives (`graph/types.ts` ACTION_KINDS). */
    kind: text("kind", { enum: ACTION_KINDS as [string, ...string[]] }).notNull(),
    /** DERIVED from `kind` in code, never declared by a type spec. */
    consequenceClass: text("consequence_class", { enum: CONSEQUENCE_CLASSES }).notNull(),
    /**
     * The event carrying the human approval that authorizes an outward (R3) or
     * governance (R4) effect. The CHECK below makes it structurally impossible to
     * enqueue one of those without it (captain decision 2) - outward and
     * governance effects are non-representable as auto-approved, at the schema.
     */
    approvalEvent: text("approval_event"),
    /** Transition → action → transition chain depth (design §5 chain budget).
     *  Exceeding the budget parks the object in a gate for human review. */
    chainDepth: integer("chain_depth").notNull().default(0),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    state: text("state", { enum: OUTBOX_STATES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
    /** Earliest instant a `failed` row may be claimed again (backoff gate). NULL
     *  ⇒ claimable now. Bounded retries mean this always eventually stops. */
    nextAttemptAt: text("next_attempt_at"),
    /** When the current `executing` claim was taken. A claim older than
     *  `EXECUTING_STALE_MS` is treated as a crashed executor and re-claimed -
     *  which is safe precisely because handlers dedup on the action id. */
    claimedAt: text("claimed_at"),
    /** Which executor instance holds the claim (observability + crash forensics;
     *  the LOCK is what actually makes the claim exclusive, not this column). */
    claimedBy: text("claimed_by"),
    /** Stamped when the row went TERMINAL WITHOUT EFFECT. Paired with
     *  `refusalCode`; `lastError` carries the human-readable detail. */
    deadLetteredAt: text("dead_lettered_at"),
    /** TYPED reason for a dead-letter (`graph/types.ts` OUTBOX_REFUSAL_CODES).
     *  The attention section groups on this rather than on message text. */
    refusalCode: text("refusal_code", { enum: OUTBOX_REFUSAL_CODES }),
  },
  (t) => [
    // The executor's claim query: claimable rows, oldest first. Covers both
    // `pending` (never attempted) and `failed` (retry scheduled) - one index,
    // because they are drained by the same scan.
    index("outbox_actions_claim_idx")
      .on(t.nextAttemptAt, t.createdAt, t.seq)
      .where(sql`${t.state} in ('pending','failed')`),
    // Stuck-claim recovery + the dead-letter feed for the attention section. Both
    // are small partial indexes, so their size tracks trouble, not history.
    index("outbox_actions_executing_idx").on(t.claimedAt).where(sql`${t.state} = 'executing'`),
    index("outbox_actions_dead_idx").on(t.teamId, t.deadLetteredAt).where(sql`${t.state} = 'dead-letter'`),
    index("outbox_actions_event_idx").on(t.eventId),
    index("outbox_actions_object_idx").on(t.objectId),
    check(
      "outbox_actions_approval_required",
      sql`${t.consequenceClass} NOT IN ('R3','R4') OR ${t.approvalEvent} IS NOT NULL`,
    ),
    // A dead-letter is never reasonless, and a reason never rides a live row:
    // the pair lands together or not at all, so "why did this stop?" is always
    // answerable from the row itself.
    check(
      "outbox_actions_dead_letter_reason",
      sql`(${t.state} = 'dead-letter') = (${t.refusalCode} IS NOT NULL)`,
    ),
  ],
);

// ---- graph_notifications: what the `notify` action actually produces ----

/**
 * The R2 `notify` action's EFFECT, in-graph: one row a human can read in the
 * workspace. This is the whole point of the executor - a verdict must CAUSE
 * something - and it is the smallest surface that proves it without any outward
 * effect (no push, no webhook, no daemon delivery).
 *
 * IDEMPOTENCY IS THE PRIMARY KEY. The id IS the outbox action id, so running the
 * same action twice inserts the same row twice → `ON CONFLICT DO NOTHING` → one
 * notification. The at-least-once boundary needs no dedup logic in the handler
 * because identity does the work (the same trick `events` and `edges` use).
 */
export const graphNotifications = pgTable(
  "graph_notifications",
  {
    /** The outbox action id that produced it - the idempotency key. */
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    /** The object the notification is about (null for workspace-level notices). */
    objectId: text("object_id"),
    /** The event whose transition enqueued the producing action (audit trail). */
    eventId: text("event_id").notNull(),
    /** Where it was addressed - `inbox` today; a real channel later. */
    channel: text("channel").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    createdAt: text("created_at").notNull(),
    /** NULL ⇒ unread. Read state is a plain stamp: a notification is a message,
     *  not an obligation, so it needs no opened-minus-closed machinery. */
    readAt: text("read_at"),
  },
  (t) => [
    index("graph_notifications_team_idx").on(t.teamId, t.createdAt),
    index("graph_notifications_unread_idx").on(t.teamId).where(sql`${t.readAt} is null`),
    index("graph_notifications_object_idx").on(t.objectId),
  ],
);

// ---- type_registry: proposed vs effective, split at schema level ----

/**
 * Captain decision 4. A landed type PROPOSAL and an EFFECTIVE registry version
 * are different rows in different states, not two columns on one row. Arming is
 * the only promotion, and the partial unique index below guarantees AT MOST ONE
 * effective version per `(team, name)` - so "resolve the effective version" is a
 * single-row lookup that can never accidentally resolve something arriving with
 * the payload under validation (the trusted-ref rule).
 */
export const typeRegistry = pgTable(
  "type_registry",
  {
    /** `type-<team>-<name>-v<version>` (deterministic; re-proposing collides). */
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    /** Type name (`task`, `doc`, `mirror`, or a custom type like `tweet`). */
    name: text("name").notNull(),
    /** The parent archetype whose engine contract this type cannot escape. */
    archetype: text("archetype", { enum: ARCHETYPES }).notNull(),
    version: integer("version").notNull(),
    state: text("state", { enum: TYPE_VERSION_STATES }).notNull().default("proposed"),
    /** Field schema + state machine (`graph/types.ts` `TypeSpec`). */
    spec: jsonb("spec").$type<TypeSpec>().notNull(),
    /** Why reuse/extension of an existing type was insufficient (design §4 -
     *  agents may only propose, and a proposal must justify itself). */
    rationale: text("rationale"),
    proposedByEvent: text("proposed_by_event"),
    proposedAt: text("proposed_at").notNull(),
    /** Stamped by the arm transition - the only path from proposed to effective. */
    armedByEvent: text("armed_by_event"),
    armedAt: text("armed_at"),
    /** Stamped when a newer version was armed over this one. */
    retiredAt: text("retired_at"),
  },
  (t) => [
    uniqueIndex("type_registry_version_idx").on(t.teamId, t.name, t.version),
    // AT MOST ONE effective version per type - the structural half of decision 4.
    uniqueIndex("type_registry_effective_idx")
      .on(t.teamId, t.name)
      .where(sql`${t.state} = 'effective'`),
    index("type_registry_team_idx").on(t.teamId),
    // An effective row was armed by something; a proposal was not.
    check(
      "type_registry_effective_armed",
      sql`${t.state} <> 'effective' OR ${t.armedAt} IS NOT NULL`,
    ),
  ],
);

export type GraphObject = typeof objects.$inferSelect;
export type NewGraphObject = typeof objects.$inferInsert;
export type GraphEdge = typeof edges.$inferSelect;
export type NewGraphEdge = typeof edges.$inferInsert;
export type GraphEvent = typeof events.$inferSelect;
export type NewGraphEvent = typeof events.$inferInsert;
export type GateObligation = typeof gateObligations.$inferSelect;
export type NewGateObligation = typeof gateObligations.$inferInsert;
export type OutboxAction = typeof outboxActions.$inferSelect;
export type NewOutboxAction = typeof outboxActions.$inferInsert;
export type GraphNotification = typeof graphNotifications.$inferSelect;
export type NewGraphNotification = typeof graphNotifications.$inferInsert;
export type TypeRegistryRow = typeof typeRegistry.$inferSelect;
export type NewTypeRegistryRow = typeof typeRegistry.$inferInsert;

/** Drizzle table bag for the graph kernel (merged into the one Drizzle instance). */
export const graphSchema = {
  objects,
  edges,
  events,
  gateObligations,
  outboxActions,
  graphNotifications,
  typeRegistry,
};
