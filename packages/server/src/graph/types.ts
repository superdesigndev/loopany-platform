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
 *  - `doc`    content we author: versioned content plus plain fields, and NO
 *             state machine (captain decision 8).
 *  - `mirror` an external fact we observe: read-only on normal write paths, no
 *             our-side state machine, never assignable/schedulable.
 *
 * LIFECYCLE IS TASK-ONLY (decision 8). Only the `task` archetype has states,
 * transitions and gates. A doc is content: it changes by having its fields and
 * body rewritten, not by walking a state machine, and "published" is a FIELD on
 * it rather than a state. When a piece of content needs a human verdict, the
 * verdict belongs to a small shepherd TASK that tracks the doc - exactly the way
 * a merge review is the task that tracks a pull-request mirror. That keeps one
 * answer to "where does work live?" instead of two competing ones.
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
  /** Land a change in the outside world - merge the pull request under review.
   *  SEPARATE from `external-close` on purpose: a merge and a close-without-merge
   *  are different effects with different guards, and collapsing them would make
   *  "merge it" reachable from a declaration that only ever meant "close it". */
  "external-merge": "R3",
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

/**
 * The outbox row state machine (design §5, §12 item 8).
 *
 *   pending    → claimable. Either never attempted, or a retry whose backoff has
 *                not elapsed (`nextAttemptAt`).
 *   executing  → claimed by ONE executor instance (`SELECT … FOR UPDATE SKIP
 *                LOCKED`). A row left here by a crash is re-claimed after
 *                `EXECUTING_STALE_MS`; the effect is re-run, which is safe
 *                because every handler is idempotent on the action id.
 *   failed     → the last attempt failed and a retry is SCHEDULED. Distinct from
 *                `pending` on purpose: "never tried" and "tried and failed" are
 *                different facts, and the second one is worth seeing.
 *   done       → the effect landed and was stamped.
 *   dead-letter→ TERMINAL without effect: retries exhausted, a safety re-check
 *                refused it, or no handler exists. NEVER a silent drop - a
 *                dead-letter row is an attention item until a human resolves it.
 *
 * AT-LEAST-ONCE BOUNDARY: a crash between the effect and the stamp is
 * indistinguishable from a crash before it, so the executor may run a row's
 * effect more than once. Every handler therefore dedups by action id, which is
 * `<eventId>-<seq>` - stable across replays by construction.
 */
export const OUTBOX_STATES = ["pending", "executing", "done", "failed", "dead-letter"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

/** States in which an action has NOT yet had its effect. The attested-close
 *  check (design §12 item 8) blocks a terminal transition on any of these -
 *  `pending` alone would let a row mid-flight or awaiting retry slip through. */
export const OUTBOX_UNSETTLED_STATES: readonly OutboxState[] = ["pending", "executing", "failed"];

/**
 * Why an action ended in `dead-letter`. A TYPED reason, not a parsed message:
 * the attention section groups on it, and a UI that string-matches an error
 * message is one wording change away from showing nothing.
 *
 *  - `RETRIES_EXHAUSTED`   the handler kept throwing; the bounded retry budget ran out
 *  - `APPROVAL_MISSING`    an R3/R4 row whose `approval_event` names no event row
 *  - `APPROVAL_NOT_HUMAN`  its approval event exists but was not entered by a human
 *  - `CHAIN_BUDGET_EXCEEDED` the transition→action→transition chain ran past budget
 *  - `NO_HANDLER`          no handler is registered for the kind (an unimplemented
 *                          effect is surfaced, never quietly marked done)
 *  - `HANDLER_REFUSED`     the handler itself refused for a reason retrying cannot fix
 */
export const OUTBOX_REFUSAL_CODES = [
  "RETRIES_EXHAUSTED",
  "APPROVAL_MISSING",
  "APPROVAL_NOT_HUMAN",
  "CHAIN_BUDGET_EXCEEDED",
  "NO_HANDLER",
  "HANDLER_REFUSED",
] as const;
export type OutboxRefusalCode = (typeof OUTBOX_REFUSAL_CODES)[number];

// ---- effect directives: how an R3 action reaches the outside world ----

/**
 * THE SERVER NEVER EXECUTES AN OUTWARD EFFECT. That is the zero-exec invariant
 * this whole product is built on, and an R3 action does not get to bend it: the
 * credentials that could act on GitHub live on a user's machine, not in the
 * server process, so the server's job for an R3 action is to write a DIRECTIVE
 * and wait. A machine-side effect agent claims it, executes it with LOCAL
 * credentials, and reports the outcome back.
 *
 * The three kinds this build can deliver. A closed set, because the agent
 * branches on it and an unknown kind must fail LOUDLY at the wire rather than be
 * interpreted generously at the far end:
 *
 *  - `github-comment` post a comment on the pull request under review. The
 *                     low-risk default: it says something, it changes nothing.
 *  - `github-merge`   merge the pull request. Guarded at the agent by an explicit
 *                     repo allowlist and a default-branch refusal, because the
 *                     blast radius of getting this wrong is somebody's `main`.
 *  - `run-task`       RUN A BOUNDED COMMAND on the machine, and report the run's
 *                     lifecycle back. The runs bridge rides this channel rather
 *                     than a second one because a dispatched run has exactly the
 *                     properties a directive exists for: only a credentialed
 *                     machine can perform it, it must be approved, a dead agent
 *                     must not lose it, and a failure must reach a person.
 */
export const EFFECT_KINDS = ["github-comment", "github-merge", "run-task"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export function isEffectKind(v: unknown): v is EffectKind {
  return typeof v === "string" && (EFFECT_KINDS as readonly string[]).includes(v);
}

/**
 * A directive's lifecycle.
 *
 *   pending → nobody holds it. The only state an agent may claim from.
 *   claimed → an agent holds a LEASE on it. The lease is what makes a dead agent
 *             recoverable: it expires, and the row goes back to `pending` for
 *             somebody else. A heartbeat extends it while real work is happening.
 *   done    → the effect landed in the outside world, and the agent said so.
 *   failed  → TERMINAL WITHOUT EFFECT, with a typed reason. Never silent: a
 *             failed directive is an attention item until a person resolves it.
 *
 * Deliberately NOT the outbox's five states. An outbox row's failure ladder is
 * about a handler this process runs; a directive's is about a process on somebody
 * else's laptop that may simply have gone away, which is why the lease - and not
 * a retry backoff - is the load-bearing mechanism here.
 */
export const DIRECTIVE_STATES = ["pending", "claimed", "done", "failed"] as const;
export type DirectiveState = (typeof DIRECTIVE_STATES)[number];

/** States in which a directive's effect has NOT yet landed. */
export const DIRECTIVE_UNSETTLED_STATES: readonly DirectiveState[] = ["pending", "claimed"];

/**
 * Why a directive ended `failed`. TYPED, like `OUTBOX_REFUSAL_CODES` and for the
 * same reason: the attention list groups on it and decides whether to offer a
 * retry, and a UI that string-matches an error message is one wording change away
 * from offering the wrong button.
 *
 *  - `AGENT_ERROR`            the command failed on the machine (network, gh, API)
 *  - `LEASE_EXPIRED`          claimed and then abandoned, past the reclaim budget
 *  - `REPO_NOT_ALLOWED`       the target repo is not on the agent's allowlist
 *  - `DEFAULT_BRANCH_REFUSED` the PR targets the repo's default branch and the
 *                             agent was not explicitly told that is allowed
 *  - `APPROVAL_INVALID`       the agent's own re-check of the R3 approval failed
 *  - `TARGET_UNRESOLVED`      the directive names a PR the agent cannot resolve
 *  - `NOT_MERGEABLE`          GitHub refused the merge (conflicts, blocked checks)
 *  - `UNSUPPORTED_KIND`       the agent does not implement this effect kind
 *  - `RUN_FAILED`             a dispatched run exited non-zero
 *  - `RUN_TIMEOUT`            a dispatched run outlived its declared timeout and
 *                             was killed. Its own code rather than `RUN_FAILED`
 *                             because "it broke" and "it never finished" lead a
 *                             person to look in different places.
 *  - `RUN_NOT_PERMITTED`      the run's command or working directory is outside
 *                             what THIS machine's operator allowed. A guard
 *                             refusal, so retrying cannot fix it - the same
 *                             posture `REPO_NOT_ALLOWED` takes.
 */
export const DIRECTIVE_REFUSAL_CODES = [
  "AGENT_ERROR",
  "LEASE_EXPIRED",
  "REPO_NOT_ALLOWED",
  "DEFAULT_BRANCH_REFUSED",
  "APPROVAL_INVALID",
  "TARGET_UNRESOLVED",
  "NOT_MERGEABLE",
  "UNSUPPORTED_KIND",
  "RUN_FAILED",
  "RUN_TIMEOUT",
  "RUN_NOT_PERMITTED",
] as const;
export type DirectiveRefusalCode = (typeof DIRECTIVE_REFUSAL_CODES)[number];

/**
 * Which failures are worth another go. A GUARD REFUSAL IS NOT: a repo does not
 * join the allowlist by being retried, and a rule does not become a person. The
 * distinction rides here rather than in the UI so both ends agree on it.
 */
export const DIRECTIVE_RETRYABLE_CODES: readonly DirectiveRefusalCode[] = [
  "AGENT_ERROR",
  "LEASE_EXPIRED",
  "NOT_MERGEABLE",
  // A run that broke or ran long may well succeed on a second go (a flaky
  // network, a machine that was busy), so both are offered a retry. What is NOT
  // retryable is `RUN_NOT_PERMITTED`: a command does not join this machine's
  // allowlist by being asked twice, exactly as a repo does not.
  "RUN_FAILED",
  "RUN_TIMEOUT",
];

export function directiveRetryable(code: DirectiveRefusalCode | null | undefined): boolean {
  return code != null && DIRECTIVE_RETRYABLE_CODES.includes(code);
}

// ---- attention items (design §8: the inbox aggregates budget-exceeded parked chains) ----

/**
 * The four ways the engine can end up needing a person's attention for a reason
 * that is NOT an ordinary verdict. Every one is COMPUTED from real rows - a
 * dead-lettered action, a `chain-parked` event, a `close-refused` event, a failed
 * effect directive - and never from a hand-set flag, so an attention item cannot
 * be forgotten into existence or dismissed into silence.
 *
 *  - `dead-letter`      an action that will never take effect on its own
 *  - `chain-parked`     a transition refused because its chain ran past budget
 *  - `close-refused`    an attested close blocked by an open obligation or an
 *                       unsettled action (design §12 item 8)
 *  - `directive-failed` an OUTWARD effect that never reached the world: the agent
 *                       failed, its lease expired, or one of its guards refused.
 *                       Computed from the directive row, not from the action that
 *                       created it - the action DID what it was asked to do (it
 *                       wrote a directive), and blaming it would point a person at
 *                       the wrong row.
 *  - `wait-recurrence`  a verification wait that had been ANSWERED "met" was
 *                       answered again with the thing back (captain decision 14:
 *                       "a recurrence answer raises attention"). The wait reopens
 *                       on its own, which keeps the watcher watching; the item is
 *                       what makes a person aware that a fix stopped holding,
 *                       which no amount of re-watching would tell them.
 */
export const ATTENTION_KINDS = [
  "dead-letter",
  "chain-parked",
  "close-refused",
  "directive-failed",
  "wait-recurrence",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** The event kind that RESOLVES an attention item. Human entrance only, and its
 *  id is derived from `(kind, ref)`, so acknowledging twice is one event row and
 *  the attention list is `raised − acknowledged` - the same opened-minus-closed
 *  shape the verdict inbox already has. */
export const ATTENTION_ACK_EVENT = "attention-acknowledged";

/** The event kind an attested-close refusal records so the refusal is VISIBLE.
 *  Without it the refusal is only a log line, and the design's "violation = an
 *  attention item" would have nothing to compute from. */
export const CLOSE_REFUSED_EVENT = "close-refused";

/** The event kind a budget park records (written by `applyTransition`). */
export const CHAIN_PARKED_EVENT = "chain-parked";

/** The event kinds the agent-answered external-wait path writes (decisions 13 +
 *  14). `wait-recurrence` is what the attention section computes its item from -
 *  the same "an item is derived from a real row, never from a flag" rule every
 *  other attention kind follows. */
export const WAIT_OPENED_EVENT = "wait-opened";
export const WAIT_ANSWERED_EVENT = "wait-answered";
export const WAIT_RECURRENCE_EVENT = "wait-recurrence";

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
  /**
   * Restrict which entrances may run it - one class, or a SET of them. A
   * transition OUT of a gate state is forced to `human` regardless (design §12
   * item 5); this is extra narrowing on top of that.
   *
   * The set form exists because "who may open a review gate" has a genuinely
   * plural answer: the agent run that produced the content, OR the engine rule
   * that noticed content with no reviewer (the `enqueue-review` action). Widening
   * to "unrestricted" would have been the easy fix and the wrong one - it would
   * also admit `human` and `clock`, which have no business entering that state.
   */
  entrance?: EntranceClass | readonly EntranceClass[];
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
  // A doc has NO state machine (decision 8). It carries one nominal state so the
  // `objects.status` column is never null, and declares no transitions - which
  // makes `applyTransition` refuse it STRUCTURALLY, the same way it refuses a
  // mirror, rather than by convention. Content and fields (including
  // `published`) move through `graphStore.updateObjectFields`; a verdict on a
  // doc belongs to a shepherd task that tracks it.
  doc: {
    states: ["current"],
    initialState: "current",
    transitions: [],
    fields: { published: "boolean", version: "number" },
  },
  mirror: {
    states: ["observed"],
    initialState: "observed",
    transitions: [],
  },
};
