/**
 * Rewrite kernel tables — `objects` + `events` (Drizzle, Postgres `pg-core`).
 *
 * These two tables stand ALONGSIDE the shipping machines/loops/runs schema.
 * After convergence they hold exactly three kinds — task, doc, mirror — and the
 * `loop` kind is GONE: the shipping `loops` row is THE loop, and `watcher` /
 * `created_by_loop` are plain text references to one, deliberately with no
 * foreign key (`kernel/loopRefs.ts` is the one resolver; a dangling reference is
 * a legal tombstone).
 *
 * Conventions match `db/schema.ts` exactly — text ids, ISO-string timestamps as
 * `text` with no db-side defaults, typed `jsonb().$type<>()` — so `store.ts`
 * stays single-sourced across the postgres-js and pglite driver tiers.
 *
 * Three invariants are enforced by the SCHEMA, not by callers:
 *   1. THE KIND FIREWALLS (design §4). A question and a parent are task facets,
 *      `format` is a doc facet, and a mirror is stateless — CHECKs, so a
 *      `needs_human:` on a doc cannot reach the disk even if every verb guard
 *      were removed. The verb guards in `kernel/types.ts` remain the teaching
 *      surface; these are the floor.
 *   2. PER-TEAM KEY UNIQUENESS — a partial UNIQUE index, so creation-time
 *      idempotency is an upsert conflict, never a read-then-write race (§4.1).
 *   3. PAYLOAD SUFFICIENCY (spec §5.2, carried from the graph line's captain
 *      decision 1) — an event carrying a `status` diff cannot exist without its
 *      transition name. It cannot be backfilled, so it is decided at schema time.
 *
 * Every inbox/worklist index is PARTIAL on its state predicate, so its size
 * tracks live work rather than total history — the property that keeps the §6
 * safety floor cheap as the log grows.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, bigint, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";

import { ENTRANCES, EVENT_ORIGINS, OBJECT_KINDS, type EventDiff } from "../kernel/types.js";

// ---- objects: loops, tasks and docs in one table (design §2) ----

export const objects = pgTable(
  "objects",
  {
    /** SHORT and kind-prefixed, server-issued (design §8): `task-7f3a91` /
     *  `doc-…` / `loop-…` — six lowercase hex when organic, twelve of sha256(seed)
     *  when the object is re-derivable (`kernel/ids.ts` owns both widths and the
     *  reasoning). */
    id: text("id").primaryKey(),
    /** Owning team — the scope everything is listed and authorized by. */
    teamId: text("team_id").notNull(),
    kind: text("kind", { enum: OBJECT_KINDS }).notNull(),
    /** task: open|closed · doc: current · mirror: current.
     *  WRITES FLOW THROUGH `kernel/applyTransition.ts` — that module is the only
     *  place in the codebase that moves this column, and it writes the status and
     *  its event in ONE transaction. DB-level enforcement of that chokepoint
     *  (a trigger token or a column grant) stays deprioritized per the standing
     *  decision (design §2 invariant 2: "by convention in v1 — one code exit"). */
    status: text("status").notNull(),
    title: text("title"),

    // ---- task facets (CHECK: null on every other kind) ----
    /** DATA, NOT A TIMER (design §6). "Due" is the query-time predicate
     *  `follow_up_at <= now` — no armed alarms, so there is no edge to miss. */
    followUpAt: text("follow_up_at"),
    /** Non-empty ⇒ a human is owed an answer. This is the attested-close guard
     *  and the inbox's first branch; it is not a status (design §3). */
    pendingQuestion: text("pending_question"),
    /** THE LOOP THAT ACTS NEXT, and never empty (`kernel/types.ts` WATCHER_HINT).
     *  Since convergence stage S1 the id may name a PRODUCTION `loops` row as
     *  well as a kernel loop object — deliberately with NO foreign key, because a
     *  prod loop can be hard-deleted while tasks still name it and the ruling is
     *  warn-never-block-never-cascade. `kernel/loopRefs.ts` is the one resolver;
     *  an id that resolves to neither table renders as a tombstone. */
    watcher: text("watcher"),
    /** THE PARENT TASK, by ID and never by slug (design report §3). Nullable and
     *  TASK-ONLY (`objects_parent_task_only`); no foreign key, because a parent
     *  may be closed and tasks are never hard-deleted, so a dangling value means
     *  bad input and is refused at the write chokepoint instead. The write-time
     *  cycle guard lives in `applyTransition.ts` at the same altitude as the
     *  watcher rule; readers stay tolerant anyway. */
    parentId: text("parent_id"),

    // ---- doc facets (CHECK: null on every other kind) ----
    /** `markdown` | `html`. HTML is a doc-only narrow door, always sandbox
     *  rendered — task and loop bodies stay Markdown (design §7). */
    format: text("format"),

    // ---- mirror facets (CHECK: null on every other kind) ----
    /** WHAT KIND of external thing this points at (`github-pr`, `url`, …).
     *  Free-form, mechanically normalized to kebab-case on write; a KNOWN kind
     *  also gets its coords shape checked (`kernel/mirrors.ts`). */
    mirrorKind: text("mirror_kind"),
    /** THE EXTERNAL THING'S IMMUTABLE IDENTITY (`owner/repo#57`, a URL). Never
     *  updated — a different PR is a different mirror — which is why it is on
     *  `IMMUTABLE_FIELDS` and why the mirror's key and id derive from it. */
    mirrorCoords: text("mirror_coords"),
    /** The object ids that DEPEND on this external thing (task/doc/loop). The
     *  association lives on the MIRROR side, so one PR that two tasks depend on
     *  is one row attached twice rather than two rows to keep in step. */
    attachedTo: jsonb("attached_to").$type<string[]>(),

    /** CREATION-TIME idempotency only (design §8): same key ⇒ the existing object
     *  is returned, never a twin and never a 409. Unique per team, partial. */
    key: text("key"),
    /** The declared free zone — custom data, explicitly namespaced (design §7). */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Markdown (or HTML for a doc). */
    body: text("body"),

    /** Provenance stamps, pinned at creation (design §10 principle 2). */
    createdByRun: text("created_by_run"),
    createdByLoop: text("created_by_loop"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** Set with `status='closed'` and cleared with it — the CHECK pairs them. */
    closedAt: text("closed_at"),
  },
  (t) => [
    // ---- the kind firewalls, welded (design §4 rule 2) ----
    check(
      "objects_task_facets_only",
      sql`${t.kind} = 'task' OR (${t.followUpAt} IS NULL AND ${t.pendingQuestion} IS NULL AND ${t.watcher} IS NULL)`,
    ),
    check("objects_parent_task_only", sql`${t.kind} = 'task' OR ${t.parentId} IS NULL`),
    check("objects_format_doc_only", sql`${t.kind} = 'doc' OR ${t.format} IS NULL`),
    check(
      "objects_mirror_facets_only",
      sql`${t.kind} = 'mirror' OR (${t.mirrorKind} IS NULL AND ${t.mirrorCoords} IS NULL AND ${t.attachedTo} IS NULL)`,
    ),
    /** A mirror without a kind, coords or an attachment set is not a pointer at
     *  all. Non-EMPTY is a kernel rule rather than a CHECK (detaching the last
     *  attachment must stay possible, and the row stays as a readable record). */
    check(
      "objects_mirror_pointer",
      sql`${t.kind} <> 'mirror' OR (${t.mirrorKind} IS NOT NULL AND ${t.mirrorCoords} IS NOT NULL AND ${t.attachedTo} IS NOT NULL)`,
    ),
    /**
     * THE STATELESSNESS WELD (`kernel/mirrors.ts` MIRROR_LAW). A mirror has no
     * `payload` (the declared free zone) and no `body` (free text), so there is
     * physically nowhere for `state: merged` to land — the "cache the status
     * just this once" commit cannot be written, not merely discouraged. Every
     * other column a mirror has is its own name: kind, coords, note, attachments.
     */
    check("objects_mirror_stateless", sql`${t.kind} <> 'mirror' OR (${t.payload} IS NULL AND ${t.body} IS NULL)`),
    // A closed task carries its stamp; an open one does not. Other kinds never close.
    check("objects_closed_pair", sql`${t.kind} <> 'task' OR ((${t.status} = 'closed') = (${t.closedAt} IS NOT NULL))`),

    // ---- indexes, one per named standing query (spec §5.1) ----
    /** Key idempotency, per team. Partial: an object with no key costs nothing. */
    uniqueIndex("objects_key_idx").on(t.teamId, t.key).where(sql`${t.key} IS NOT NULL`),
    /** Inbox branch 1: decisions (open tasks with a question waiting). */
    index("objects_question_idx")
      .on(t.teamId, t.createdAt)
      .where(sql`${t.kind} = 'task' AND ${t.status} = 'open' AND ${t.pendingQuestion} IS NOT NULL`),
    /** Inbox branch 2 + `task list --due`: the `follow_up_at <= now` predicate. */
    index("objects_due_task_idx")
      .on(t.teamId, t.followUpAt)
      .where(sql`${t.kind} = 'task' AND ${t.status} = 'open' AND ${t.followUpAt} IS NOT NULL`),
    /** The unwatched pool. Dead by construction since the watcher rule (a task
     *  always names the loop that acts next), kept because dropping an index is
     *  not this stage's business — see `kernel/types.ts` WATCHER_HINT. */
    index("objects_unwatched_idx")
      .on(t.teamId, t.createdAt)
      .where(sql`${t.kind} = 'task' AND ${t.status} = 'open' AND ${t.watcher} IS NULL`),
    /** THE ORPHAN FLOOR — same story as the pool above. */
    index("objects_orphan_idx")
      .on(t.teamId, t.createdAt)
      .where(sql`${t.kind} = 'task' AND ${t.status} = 'open' AND ${t.watcher} IS NULL AND ${t.followUpAt} IS NULL`),
    /** Watcher worklists (`task list --watcher <loop-id>`). */
    index("objects_watcher_idx").on(t.watcher, t.followUpAt).where(sql`${t.kind} = 'task' AND ${t.status} = 'open'`),
    /** The children of a task — the tree assembly's descent, and the ancestor
     *  walk the write-time cycle guard runs. Partial: only tasks have a parent. */
    index("objects_parent_idx").on(t.parentId).where(sql`${t.kind} = 'task'`),
    /** The `--creator` filter, the loop page's "created" list, graph flow edges. */
    index("objects_creator_idx").on(t.createdByLoop, t.createdAt),
    /** `mirror list --kind <k>` and `mirror kinds` (the kinds-in-use tally). */
    index("objects_mirror_kind_idx").on(t.teamId, t.mirrorKind).where(sql`${t.kind} = 'mirror'`),
    /** `mirror list --coords-like <pattern>` and the attach-time identity read. */
    index("objects_mirror_coords_idx").on(t.teamId, t.mirrorCoords).where(sql`${t.kind} = 'mirror'`),
    /** THE REVERSE LOOKUP — "which external items does this task depend on?" —
     *  which is `attached_to @> '["task-…"]'`, a containment query, so GIN. It is
     *  what `task show` / the task drawer compose `mirrors[]` from. */
    index("objects_mirror_attached_idx").using("gin", t.attachedTo).where(sql`${t.kind} = 'mirror'`),
    /** Generic scoping. */
    index("objects_team_kind_status_idx").on(t.teamId, t.kind, t.status),
  ],
);

// ---- events: the append-only record (design §2, spec §5.2) ----

export const events = pgTable(
  "events",
  {
    /**
     * `ev-<12 hex of sha256(seed)>` when `origin = 'derived'`, `ev-<6 hex random>`
     * when `organic` (`kernel/ids.ts`). The dedup invariant is STRUCTURAL: a
     * re-derivable fact's id is a pure function of the fact, so re-deriving it
     * collides here and `ON CONFLICT DO NOTHING` makes the second insert a no-op.
     */
    id: text("id").primaryKey(),
    /**
     * THE STREAM CURSOR (spec §5.4 "`seq` vs `id`"). No event id — hashed or
     * random — carries monotonicity, so SSE resume gets its own identity column:
     * **the content id dedups, the seq orders**. Nothing anywhere reads an event
     * id as a clock; every tail (`listObjectEvents`, `eventsAfter`, `eventTail`)
     * sorts by this column.
     *
     * CORRECTION TO THE SPEC. §5.4 argues that a dedup collision consumes no seq
     * and therefore leaves no gap. That is not how Postgres identity columns
     * behave: the value is drawn BEFORE the conflict is detected, so a swallowed
     * `ON CONFLICT DO NOTHING` does burn one and the stream is sparse. This costs
     * nothing — the tail is `WHERE seq > :since ORDER BY seq`, which never needs
     * contiguity — but a client must not treat a gap as a dropped event, and no
     * consumer may derive a count from a seq delta. Pinned by
     * `kernel.integration.test.ts` ("seq is strictly increasing, gaps allowed").
     */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id").notNull(),
    /** The object this event is about; NULL for team-level events. */
    objectId: text("object_id"),
    /** `object-created`, `object-updated`, `task-closed`, `question-answered`,
     *  `run-queued`, `run-finished`, … Open vocabulary. */
    kind: text("kind").notNull(),
    /** Which half of the dedup invariant minted the id. */
    origin: text("origin", { enum: EVENT_ORIGINS }).notNull(),
    /**
     * PROVENANCE, half one: how the write was entered (`clock|answer|human|agent`).
     * NOT NULL — it cannot be backfilled, so an event written without it would be
     * permanently unattributable.
     */
    entrance: text("entrance", { enum: ENTRANCES }).notNull(),
    /** PROVENANCE, half two: the concrete actor — a run id or a user id. Never a
     *  placeholder. */
    actorId: text("actor_id").notNull(),
    /** The transition that produced a status change. NOT NULL for any event whose
     *  diff carries `status` (the CHECK below). */
    transition: text("transition"),
    /** Per-field `{old, new}` for everything this event changed. */
    diff: jsonb("diff").$type<EventDiff>(),
    /** The human's answer, the closer's attestation — free text, never parsed. */
    note: text("note"),
    /** Everything else (a resolved approval block, a run's cost, …). */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    ts: text("ts").notNull(),
  },
  (t) => [
    check("events_state_change_sufficient", sql`${t.diff} IS NULL OR ${t.transition} IS NOT NULL OR NOT jsonb_exists(${t.diff}, 'status')`),
    /** The SSE tail (`GET /api/events/stream?since=<seq>`), team-scoped. */
    index("events_team_seq_idx").on(t.teamId, t.seq),
    /** The task/loop page's event tail. */
    index("events_object_ts_idx").on(t.objectId, t.ts),
    /** "Everything this run did" / "everything this person decided". */
    index("events_actor_idx").on(t.entrance, t.actorId),
    index("events_kind_idx").on(t.kind),
  ],
);

export type KernelObject = typeof objects.$inferSelect;
export type NewKernelObject = typeof objects.$inferInsert;
export type KernelEvent = typeof events.$inferSelect;
export type NewKernelEvent = typeof events.$inferInsert;

/** Table bag, merged into the Drizzle handle's schema in `db/index.ts`. */
export const kernelSchema = { objects, events };
