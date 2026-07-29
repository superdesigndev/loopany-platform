/**
 * Graph Engineering v3 - the pure vocabulary of the kernel.
 *
 * This module is the SINGLE SOURCE for every closed set the graph tables and the
 * `applyTransition` seam depend on (archetypes, actor kinds, consequence classes,
 * the declarative action vocabulary, the type-spec shape). It imports nothing at
 * runtime, so `db/graph-schema.ts` can derive its column enums from here the same
 * way `db/schema.ts` derives `loops.agent` from `types.ts` `CODING_AGENTS` - one
 * edit widens a set, with no drift between the DB enum, the validator and the UI.
 *
 * Design references: `design.md` §2 (kernel), §4 (type system), §5 (state machines
 * and actions), §8 (human-in-the-loop), §12 (adopted revisions).
 */

// ---- archetypes (design §4) ----

/**
 * The three core archetypes, defined in code and globally consistent. Custom
 * types declare a parent archetype and cannot escape its engine contract, so the
 * engine's generic paths only ever branch on THIS set.
 *
 *  - `task`   work we own: guarded state machine, assignable, schedulable. A Loop
 *             is just a Task with `cron` set (not a separate archetype).
 *  - `doc`    content we author: a versioned content body.
 *  - `mirror` an external fact we observe: read-only on normal write paths, no
 *             our-side state machine, never assignable/schedulable.
 */
export const ARCHETYPES = ["task", "doc", "mirror"] as const;
export type Archetype = (typeof ARCHETYPES)[number];

// ---- provenance: which transition entrance produced an event ----

/**
 * The ENTRANCE CLASS: which of the four ways into a transition produced this
 * event. Landed in v1 alongside the field diffs and for the same reason - like a
 * diff, provenance cannot be reconstructed after the fact, so an event written
 * without it is permanently unattributable.
 *
 *  - `human`     a person acting IN the product (actor id = user id)
 *  - `agent-run` an agent run on a user's machine (actor id = run id)
 *  - `rule`      a declarative rule / outbox action firing (actor id = rule id)
 *  - `clock`     the scheduler firing a cadence (actor id = schedule id)
 *
 * `human` is load-bearing beyond audit: a gate state's outgoing transition may
 * only be entered this way (design §12 item 5), so the gate guard reads exactly
 * this column.
 *
 * NB: distinct from `events.origin` (`derived` | `organic`), which names how the
 * event's ID was minted and is the dedup invariant's mechanism. `entrance` is
 * WHO/HOW; `origin` is WHETHER IT CAN REPEAT. Both are needed and neither
 * implies the other - a clock-entered transition can be re-derivable, and a
 * human verdict can be organic.
 */
export const ENTRANCE_CLASSES = ["human", "agent-run", "rule", "clock"] as const;
export type EntranceClass = (typeof ENTRANCE_CLASSES)[number];

/** An event's provenance: the entrance class plus the CONCRETE actor behind it. */
export interface EventProvenance {
  entrance: EntranceClass;
  /** The concrete id for the entrance class: user id / run id / rule id /
   *  schedule id. Never a placeholder - an unattributable event is the exact
   *  thing this pair exists to make impossible. */
  actorId: string;
}

// ---- events ----

/**
 * How an event id was minted - the structural half of the dedup invariant
 * (design §12 item 6: "a window is never a dedup key").
 *
 *  - `derived` the id is a sha256 of the event's own identity fields, so the SAME
 *              fact re-derived (a re-poll, a replayed observation, a backfill)
 *              collides on the primary key and `ON CONFLICT DO NOTHING` makes the
 *              second insert a no-op. Identity, never recency, is the key.
 *  - `organic` a genuinely new occurrence with no re-derivable identity (a human
 *              verdict, an agent decision). Gets a fresh ULID: time-ordered, so
 *              the append-only log sorts by id, but never deduplicated.
 */
export const EVENT_ORIGINS = ["derived", "organic"] as const;
export type EventOrigin = (typeof EVENT_ORIGINS)[number];

/**
 * Per-field before/after for a state-change event (design §12 item 1 / captain
 * decision 1: payload sufficiency, decided at schema time because it cannot be
 * backfilled). Keys are `status` and `payload.<field>`; values are JSON scalars
 * or structures, `null` when the field was absent.
 */
export type EventDiff = Record<string, { old: unknown; new: unknown }>;

// ---- gate obligations (design §12 item 3 / captain decision 3) ----

/**
 * The two obligation classes. They carry different alarm cadences: a
 * `human-verdict` is actively owed by a person and belongs at the top of the
 * "waiting on you" inbox; an `external-wait` is passive and re-surfaces on a
 * bounded schedule so a forgotten wait cannot rot invisibly.
 */
export const OBLIGATION_CLASSES = ["human-verdict", "external-wait"] as const;
export type ObligationClass = (typeof OBLIGATION_CLASSES)[number];

// ---- action consequence classes (design §12 item 2 / captain decision 2) ----

/**
 * The closed consequence ladder every action primitive carries. R3 and R4 are
 * structurally non-auto-approvable: the `outbox_actions` table CHECKs that a row
 * in either class carries an `approval_event_id`, so no configuration - and no
 * bug in a guard - can make an outward or a governance effect routine.
 *
 *  - `R0` internal graph write (create object/edge, update fields)
 *  - `R1` engine-local scheduling/attention (follow-up date, watch register)
 *  - `R2` notify / enqueue review - visible to a human, no outward effect
 *  - `R3` OUTWARD effect: writes to the world outside Loopany
 *  - `R4` GOVERNANCE: changes the compiled graph or the type system itself
 *
 * The design (§12 item 2) names four tiers; this unit splits the lowest one into
 * R0/R1 so the ladder has room for engine-local-but-scheduling actions without a
 * later renumber. That split is the smallest reasonable choice and changes
 * nothing about the two top tiers, which are the load-bearing part.
 */
export const CONSEQUENCE_CLASSES = ["R0", "R1", "R2", "R3", "R4"] as const;
export type ConsequenceClass = (typeof CONSEQUENCE_CLASSES)[number];

/** The classes that can never be auto-approved (mirrors the DB CHECK constraint). */
export const APPROVAL_REQUIRED_CLASSES: readonly ConsequenceClass[] = ["R3", "R4"];

export function requiresApproval(c: ConsequenceClass): boolean {
  return APPROVAL_REQUIRED_CLASSES.includes(c);
}

/**
 * The declarative engine primitives (design §5). Anything Turing-complete runs on
 * the user's machine via a dispatched run; this vocabulary is the whole surface.
 *
 * A transition spec declares only the action KIND - the consequence class is
 * derived here, in code, and is NOT settable per spec. That is deliberate: if a
 * spec could name its own class, "outward effects are non-auto-approvable" would
 * be a convention a typo could break rather than a property of the system.
 */
export const ACTION_CONSEQUENCE = {
  // R0 - internal graph writes
  "create-object": "R0",
  "create-edge": "R0",
  "update-fields": "R0",
  // R1 - engine-local scheduling / attention
  "set-follow-up-date": "R1",
  "register-watch": "R1",
  "unregister-watch": "R1",
  // R2 - visible to a human, still inside Loopany
  notify: "R2",
  "enqueue-review": "R2",
  /** A run that does machine-local work only (no declared outward effect). */
  "dispatch-run": "R2",
  // R3 - outward effects
  /** A run whose declared purpose includes writing to the outside world (open a
   *  PR, push a branch). Split from `dispatch-run` precisely so the outward
   *  ceiling cannot be reached by mislabeling a push as ordinary work; which of
   *  the two a concrete M1 action uses is an M1 decision, not a schema one. */
  "dispatch-outward-run": "R3",
  "external-comment": "R3",
  "external-close": "R3",
  // R4 - governance
  "create-type": "R4",
  "version-type": "R4",
  "arm-type": "R4",
  "change-graph": "R4",
} as const satisfies Record<string, ConsequenceClass>;

export type ActionKind = keyof typeof ACTION_CONSEQUENCE;

export const ACTION_KINDS = Object.keys(ACTION_CONSEQUENCE) as ActionKind[];

export function isActionKind(v: unknown): v is ActionKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ACTION_CONSEQUENCE, v);
}

/** The consequence class of an action kind - derived, never spec-declared. */
export function consequenceOf(kind: ActionKind): ConsequenceClass {
  return ACTION_CONSEQUENCE[kind];
}

// ---- outbox delivery state ----

/** At-least-once boundary: the executor may deliver a `pending` row more than
 *  once (crash between effect and stamp), so every executor dedups by action id.
 *  The id is `<eventId>-<seq>`, which is stable across replays by construction. */
export const OUTBOX_STATES = ["pending", "delivered", "failed"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

// ---- type registry (design §4, §12 item 4 / captain decision 4) ----

/**
 * A registry row's lifecycle. `proposed` and `effective` are different STATES of
 * different rows, not two columns on one row: arming is the only promotion, and a
 * partial unique index guarantees at most one `effective` version per type, so a
 * reader resolving "effective" resolves exactly one row or none. Guards therefore
 * can never accidentally resolve a version that arrived with the payload under
 * validation (the trusted-ref rule).
 */
export const TYPE_VERSION_STATES = ["proposed", "effective", "retired"] as const;
export type TypeVersionState = (typeof TYPE_VERSION_STATES)[number];

/** One gate obligation a transition opens. */
export interface GateSpec {
  /** Stable per-object key - `(objectId, key)` is the obligation's identity, so
   *  re-running the same transition re-opens nothing. */
  key: string;
  class: ObligationClass;
  /** Human-readable "what are we waiting on" for the inbox row. */
  label?: string;
}

/** One declarative action a transition enqueues. The class is derived from `kind`. */
export interface ActionSpec {
  kind: ActionKind;
  /** Opaque action payload handed to the (later) executor. */
  payload?: Record<string, unknown>;
}

/** One guarded transition of a type's state machine. */
export interface TransitionSpec {
  name: string;
  /** Legal source states. `"*"` means any non-terminal state. */
  from: string[];
  to: string;
  /** Restrict which entrance may run it. A transition OUT of a gate state is
   *  forced to `human` regardless (design §12 item 5); this is extra narrowing. */
  entrance?: EntranceClass;
  /** Obligations this transition opens (keyed, so it is idempotent per object). */
  opens?: GateSpec[];
  /** Obligation keys this transition closes. */
  closes?: string[];
  /** Declarative actions enqueued into the outbox in the same transaction. */
  actions?: ActionSpec[];
}

/**
 * The versioned contract of one type: its state machine plus (later) its field
 * schema. Stored as the registry row's `spec` JSONB.
 */
export interface TypeSpec {
  states: string[];
  initialState: string;
  /** States whose OUTGOING transition requires a human actor in the product. */
  gateStates?: string[];
  /** States that end the object's lifecycle. Entering one requires an attested
   *  "no open obligations, no pending actions" (design §12 item 8). */
  terminalStates?: string[];
  transitions: TransitionSpec[];
  /** Type-specific field declarations. Carried through unvalidated in this unit;
   *  write-time field validation is a later unit (design §3). */
  fields?: Record<string, unknown>;
}

/**
 * The built-in archetype base types, seeded as effective version 1 per team.
 * They exist so that EVERY status resolution goes through the registry - decision
 * 4's "readers resolve effective only" has no exception for archetypes.
 *
 * `mirror` deliberately declares NO transitions: a mirror has no our-side state
 * machine (design §4), so `applyTransition` on one is refused structurally rather
 * than by convention.
 */
export const BUILTIN_TYPE_SPECS: Record<Archetype, TypeSpec> = {
  task: {
    states: ["open", "in-progress", "blocked", "done", "canceled"],
    initialState: "open",
    terminalStates: ["done", "canceled"],
    transitions: [
      { name: "start", from: ["open", "blocked"], to: "in-progress" },
      { name: "block", from: ["open", "in-progress"], to: "blocked" },
      { name: "complete", from: ["in-progress"], to: "done" },
      { name: "cancel", from: ["open", "in-progress", "blocked"], to: "canceled" },
    ],
  },
  doc: {
    states: ["draft", "published", "archived"],
    initialState: "draft",
    terminalStates: ["archived"],
    transitions: [
      { name: "publish", from: ["draft"], to: "published" },
      { name: "revise", from: ["published"], to: "draft" },
      { name: "archive", from: ["draft", "published"], to: "archived" },
    ],
  },
  mirror: {
    states: ["observed"],
    initialState: "observed",
    transitions: [],
  },
};
