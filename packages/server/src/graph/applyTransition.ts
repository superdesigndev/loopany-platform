/**
 * Graph Engineering v3 - `applyTransition`: the SINGLE server-side seam through
 * which any object status change flows (design §2, §5).
 *
 * THE 5-STEP CONTRACT, all in ONE transaction:
 *   1. VALIDATE the transition against the EFFECTIVE type version (decision 4 -
 *      a proposal is invisible to a guard, so nothing arriving with the payload
 *      under validation can ever be resolved as the contract).
 *   2. APPLY the status (and any fields the transition carries).
 *   3. DERIVE the event, carrying the transition name and a per-field {old, new}
 *      diff (decision 1 - payload sufficiency; it cannot be backfilled, so it is
 *      structural: the `events` CHECK refuses a state change without it).
 *   4. OPEN / CLOSE gate obligations (decision 3 - keyed `(objectId, key)`; the
 *      inbox is computed opened-minus-closed, never from the status column).
 *   5. ENQUEUE outbox actions (design §5 idempotency red line - the transition
 *      and its pending actions land together or not at all; the executor dedups
 *      by action id, so replays are safe).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PENDING CAPTAIN DECISION - the DB-level chokepoint (design §12 item 7)
 *
 * Making a direct `UPDATE objects SET status = …` PHYSICALLY impossible is a
 * separate, pending decision between:
 *   (A) a trigger + session token: a BEFORE UPDATE trigger on `objects` rejects
 *       a status change unless a transaction-local token (e.g. a
 *       `SET LOCAL loopany.transition_token`) is present;
 *   (B) grants: `status` is revoked from the application role and moves only via
 *       a SECURITY DEFINER function / a privileged role.
 *
 * NEITHER is implemented here, deliberately. The seam is `StatusWriteAuthorizer`
 * below: option A implements `begin`/`end` as the SET LOCAL / RESET pair, option
 * B implements them as the role switch, and NOTHING ELSE in this module changes.
 * The three-probe enforcement suite (direct write / patch-around-schema /
 * raw-event smuggle) ships with that branch.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * OPERATIONAL DISCIPLINES honored here (design §12 item 8):
 *  - transitions NEVER read the clock - `now` is a required input;
 *  - outbox rows are written inside the transition's transaction, before any
 *    caller can observe the new status;
 *  - entering a terminal state requires an ATTESTED "no open obligations, no
 *    pending actions", recorded ON the closing event;
 *  - budget-parking is terminal-until-verdict: exceeding the chain budget opens a
 *    human-verdict obligation and refuses the transition. Time never unparks it.
 *
 * PER-OBJECT SERIAL APPLICATION (actor-mailbox semantics). The object is read
 * under `SELECT … FOR UPDATE` as the FIRST statement of the transaction, before
 * any guard runs. Two transitions racing on the same object therefore serialize:
 * the second blocks until the first commits, then re-reads the POST-COMMIT row
 * and re-validates against it. A transition that was legal when it was requested
 * but is not legal against the state that actually exists is REFUSED, never
 * applied over the top. Locks are per object, so unrelated objects never contend.
 *
 * FAILURE POSTURE. Every refusal is a TYPED result (`{ok:false, code}`) and is
 * logged at warn level - loud, attributable, never swallowed. This module
 * contains NO retry: a lost race, a stale guard and a missing approval are all
 * decisions for the caller to make with the typed code in hand. Retrying inside
 * the seam would silently re-run guards against a moved world, which is exactly
 * the class of bug the lock exists to prevent.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { logger } from "../logger.js";
import {
  objects as objectsTable,
  type GateObligation,
  type GraphEvent,
  type GraphObject,
  type OutboxAction,
} from "../db/graph-schema.js";
import * as graph from "../db/graphStore.js";
import type { GraphExec } from "../db/graphStore.js";
import { derivedEventId, organicEventId } from "./ids.js";
import {
  ACTION_CONSEQUENCE,
  CHAIN_PARKED_EVENT,
  CLOSE_REFUSED_EVENT,
  type ActionKind,
  type ConsequenceClass,
  type EntranceClass,
  type EventProvenance,
  type EventDiff,
  type TransitionSpec,
  type TypeSpec,
} from "./types.js";

/**
 * Default transition → action → transition chain budget (design §5). Exceeding it
 * parks the object in a gate for human review - itself a natural HITL moment,
 * which is why the budget is a product mechanic and not just a recursion guard.
 * Smallest reasonable default; a per-type override is a later unit.
 */
export const DEFAULT_CHAIN_BUDGET = 8;

/** The obligation key a budget-park opens. Stable so a re-park is idempotent. */
export const CHAIN_PARK_KEY = "chain-budget-exceeded";

// ---- the pending-decision seam ----

/**
 * SEAM: how a status write authorizes itself against the DB-level chokepoint.
 *
 * `begin` runs inside the transition's transaction immediately BEFORE the status
 * UPDATE; `end` runs immediately after (also on the failure path). The default is
 * a no-op, which is exactly today's posture: the chokepoint is enforced by code
 * discipline (this is the only module that writes `objects.status`) until the
 * captain picks option A or B above.
 *
 * Both options fit without touching any other line of this module:
 *   A) begin → `SET LOCAL loopany.transition_token = '<nonce>'`; end → `RESET`.
 *   B) begin → `SET LOCAL ROLE loopany_transition`; end → `RESET ROLE`.
 */
export interface StatusWriteAuthorizer {
  begin(tx: GraphExec, ctx: { objectId: string; transition: string; eventId: string }): Promise<void>;
  end(tx: GraphExec, ctx: { objectId: string; transition: string; eventId: string }): Promise<void>;
}

const NOOP_AUTHORIZER: StatusWriteAuthorizer = {
  async begin() {
    /* TODO(chokepoint): option A or B lands here - see the module header. */
  },
  async end() {
    /* TODO(chokepoint): option A or B lands here - see the module header. */
  },
};

let authorizer: StatusWriteAuthorizer = NOOP_AUTHORIZER;

/** Install the chokepoint authorizer (boot wires the chosen option; tests may
 *  install a spy to prove every status write went through the seam). */
export function setStatusWriteAuthorizer(next: StatusWriteAuthorizer | null): void {
  authorizer = next ?? NOOP_AUTHORIZER;
}

// ---- inputs / outputs ----

export interface ApplyTransitionInput {
  objectId: string;
  /** Transition NAME as declared by the effective type version's state machine. */
  transition: string;
  /** PROVENANCE - which entrance produced this transition plus the concrete
   *  actor behind it. Required: it is written to the event and cannot be
   *  backfilled, and the gate guard reads `entrance` directly. */
  actor: EventProvenance;
  /** ISO timestamp. REQUIRED: transitions never read the clock (§12 item 8). */
  now: string;
  /** Field values this transition writes into `payload` (diffed into the event). */
  fields?: Record<string, unknown>;
  /** Top-level column updates the transition carries (title/assignee/schedule). */
  columns?: Partial<Pick<GraphObject, "title" | "assigneeUserId" | "cron" | "timezone" | "nextRunAt">>;
  /**
   * IDEMPOTENCY / DEDUP. Supply a seed when this transition is RE-DERIVABLE - an
   * observed external change, a replayed compile, a retried dispatch. The event
   * id becomes a pure function of the seed, so a second derivation collides on
   * the primary key and the whole transition is a no-op replay.
   *
   * Omit it for an ORGANIC occurrence (a human verdict, an agent decision): the
   * event gets a ULID and is never deduplicated. A window is never a dedup key.
   */
  derivedFrom?: unknown;
  /** Approval event ids per action index, for the R3/R4 actions this transition
   *  declares. Missing one is a refusal, never a downgrade. */
  approvals?: Record<number, string>;
  /** Depth of the transition → action → transition chain that led here. */
  chainDepth?: number;
  /** Override the chain budget for this call (tests, per-workflow tuning). */
  chainBudget?: number;
  /** Extra event payload (an observation body, a verdict comment). */
  eventPayload?: Record<string, unknown>;
  /** Reminder stamp applied to `external-wait` obligations this transition opens. */
  nextReminderAt?: string;
}

export type ApplyTransitionError =
  | "UNKNOWN_OBJECT"
  | "NO_EFFECTIVE_TYPE"
  | "ARCHETYPE_HAS_NO_STATE_MACHINE"
  | "UNKNOWN_TRANSITION"
  | "ILLEGAL_FROM_STATE"
  | "GATE_REQUIRES_HUMAN"
  | "WRONG_ENTRANCE"
  | "APPROVAL_REQUIRED"
  | "OPEN_OBLIGATIONS"
  | "PENDING_ACTIONS"
  | "CHAIN_BUDGET_EXCEEDED";

export interface ApplyTransitionOk {
  ok: true;
  object: GraphObject;
  event: GraphEvent;
  /** True when the event id already existed: this call was a REPLAY and applied
   *  nothing. The caller's correct response is to carry on - that is dedup
   *  working, not a failure. */
  replay: boolean;
  opened: GateObligation[];
  closed: GateObligation[];
  actions: OutboxAction[];
}

export interface ApplyTransitionFail {
  ok: false;
  code: ApplyTransitionError;
  message: string;
  /** Set when the failure PARKED the object (chain budget): the obligation a
   *  human must now discharge. */
  parked?: GateObligation;
}

export type ApplyTransitionResult = ApplyTransitionOk | ApplyTransitionFail;

/**
 * Record a refusal LOUDLY and return it typed. Never throws, never retries -
 * the caller decides what a refusal means, with the code in hand.
 */
function fail(
  code: ApplyTransitionError,
  message: string,
  ctx: { objectId: string; transition: string },
  parked?: GateObligation,
): ApplyTransitionFail {
  logger.warn({ code, objectId: ctx.objectId, transition: ctx.transition }, `transition refused: ${message}`);
  return { ok: false, code, message, ...(parked ? { parked } : {}) };
}

// ---- pure helpers (exported for direct unit testing) ----

/** Find a transition by name in a spec. */
export function findTransition(spec: TypeSpec, name: string): TransitionSpec | undefined {
  return spec.transitions.find((t) => t.name === name);
}

/** Is `from` a legal source state for this transition? `"*"` means any state that
 *  is not terminal (a terminal object is done; nothing walks out of it). */
export function allowsFrom(spec: TypeSpec, t: TransitionSpec, from: string): boolean {
  if (t.from.includes(from)) return true;
  if (!t.from.includes("*")) return false;
  return !(spec.terminalStates ?? []).includes(from);
}

/**
 * PAYLOAD SUFFICIENCY (decision 1). Build the per-field `{old, new}` diff for
 * everything this transition changes - `status` plus one `payload.<key>` entry
 * per changed field plus one entry per changed column. Unchanged fields are
 * omitted: the diff answers "what changed", and a field listed with old === new
 * would be noise that erodes exactly the sufficiency this guarantees.
 */
export function buildDiff(
  before: GraphObject,
  toStatus: string,
  fields?: Record<string, unknown>,
  columns?: Record<string, unknown>,
): EventDiff {
  const diff: EventDiff = { status: { old: before.status, new: toStatus } };
  const payload = (before.payload ?? {}) as Record<string, unknown>;
  for (const [k, next] of Object.entries(fields ?? {})) {
    const prev = k in payload ? payload[k] : null;
    if (!sameJson(prev, next)) diff[`payload.${k}`] = { old: prev ?? null, new: next ?? null };
  }
  for (const [k, next] of Object.entries(columns ?? {})) {
    const prev = (before as unknown as Record<string, unknown>)[k] ?? null;
    if (!sameJson(prev, next)) diff[k] = { old: prev ?? null, new: next ?? null };
  }
  return diff;
}

/** Normalize a spec's `entrance` restriction to a list - one class or several. */
export function entranceList(e: EntranceClass | readonly EntranceClass[]): readonly EntranceClass[] {
  return Array.isArray(e) ? e : [e as EntranceClass];
}

/** May this actor's entrance run a transition restricted to `e`? */
export function allowsEntrance(
  e: EntranceClass | readonly EntranceClass[],
  entrance: EntranceClass,
): boolean {
  return entranceList(e).includes(entrance);
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---- the seam ----

/**
 * Run one guarded transition. Every step lands in ONE transaction, so an
 * observer either sees the old status with no event, or the new status with its
 * event, its obligations and its outbox rows - never a partial world.
 */
export async function applyTransition(input: ApplyTransitionInput): Promise<ApplyTransitionResult> {
  return db.transaction(async (tx) => applyTransitionIn(tx as unknown as GraphExec, input));
}

/**
 * The body, against a caller-supplied executor. Exported so a LATER unit can
 * compose a transition into a bigger transaction (the outbox executor drains an
 * object's pending actions and then evaluates the next transition - design §12
 * item 8 - which must be one atomic step). Callers outside a transaction should
 * use `applyTransition`.
 */
export async function applyTransitionIn(
  tx: GraphExec,
  input: ApplyTransitionInput,
): Promise<ApplyTransitionResult> {
  const { objectId, transition: transitionName, actor, now } = input;

  // ---- step 1: validate against the EFFECTIVE type version ----

  // ACTOR MAILBOX: take the object's row lock BEFORE any guard reads state, so a
  // concurrent transition on the same object waits here and then re-validates
  // against the committed result instead of racing it.
  const where = { objectId, transition: transitionName };
  const before = await graph.getObjectForUpdate(tx, objectId);
  if (!before) return fail("UNKNOWN_OBJECT", `no object ${objectId}`, where);

  // REPLAY LATCH, ahead of every guard. A re-derivable transition's event id is a
  // pure function of the fact, so if that event already exists this call is a
  // re-delivery of work that ALREADY landed - an idempotent no-op, not an error.
  // It has to be checked before the from-state guard: the first application moved
  // the status, so the guard would now (correctly, but uselessly) refuse the
  // replay, turning every retried observation into a spurious refusal.
  const eventId =
    input.derivedFrom === undefined
      ? organicEventId(msOf(now))
      : derivedEventId({ objectId, transition: transitionName, seed: input.derivedFrom });
  if (input.derivedFrom !== undefined) {
    const prior = await graph.getEvent(tx, eventId);
    if (prior) {
      return {
        ok: true,
        object: before,
        event: prior,
        replay: true,
        opened: [],
        closed: [],
        actions: await graph.listActionsForEvent(tx, eventId),
      };
    }
  }

  const typeRow = await graph.getEffectiveType(tx, before.teamId, before.type);
  if (!typeRow) {
    return fail(
      "NO_EFFECTIVE_TYPE",
      `type "${before.type}" has no effective registry version for team ${before.teamId} - ` +
        "a proposal must be armed before it can guard anything",
      where,
    );
  }
  const spec = typeRow.spec;

  // A Mirror has no our-side state machine (design §4): its state is the external
  // world's, and we only observe it. Refuse structurally, not by convention.
  if (before.archetype === "mirror" || spec.transitions.length === 0) {
    return fail(
      "ARCHETYPE_HAS_NO_STATE_MACHINE",
      `${before.archetype} "${before.type}" declares no transitions - observed state is not ours to move`,
      where,
    );
  }

  const t = findTransition(spec, transitionName);
  if (!t) {
    return fail(
      "UNKNOWN_TRANSITION",
      `"${transitionName}" is not a transition of ${before.type} v${typeRow.version}`,
      where,
    );
  }
  if (!allowsFrom(spec, t, before.status)) {
    return fail(
      "ILLEGAL_FROM_STATE",
      `${before.type}.${transitionName} cannot run from "${before.status}" (allowed: ${t.from.join(", ")})`,
      where,
    );
  }
  // STRICT GATE SEMANTICS (design §12 item 5): a gate state's outgoing transition
  // is executed by a HUMAN in the product. Waiting for the external world to
  // reflect it is an `external-wait` obligation, not a gate - so nothing but a
  // human actor walks out of a gate state.
  if ((spec.gateStates ?? []).includes(before.status) && actor.entrance !== "human") {
    return fail(
      "GATE_REQUIRES_HUMAN",
      `"${before.status}" is a gate state - its outgoing transition requires a human verdict, ` +
        `entered via ${actor.entrance}`,
      where,
    );
  }
  if (t.entrance && !allowsEntrance(t.entrance, actor.entrance)) {
    return fail(
      "WRONG_ENTRANCE",
      `${before.type}.${transitionName} requires entrance ${entranceList(t.entrance).join(" or ")}, ` +
        `got ${actor.entrance}`,
      where,
    );
  }

  // Actions are validated BEFORE anything is written: an R3/R4 action without an
  // approval event refuses the WHOLE transition rather than landing a state change
  // whose consequences then cannot be enqueued (decision 2).
  const declared = t.actions ?? [];
  for (let i = 0; i < declared.length; i++) {
    const kind = declared[i]!.kind;
    const cls = actionClass(kind);
    if ((cls === "R3" || cls === "R4") && !input.approvals?.[i]) {
      return fail(
        "APPROVAL_REQUIRED",
        `action ${i} ("${kind}") is ${cls} - outward/governance effects cannot be auto-approved; ` +
          "supply approvals[" + i + "] = <approval event id>",
        where,
      );
    }
  }

  // CHAIN BUDGET (design §5 red line). Terminal-until-verdict: parking opens a
  // human-verdict obligation and refuses the transition. Time never unparks it.
  const depth = input.chainDepth ?? 0;
  const budget = input.chainBudget ?? DEFAULT_CHAIN_BUDGET;
  if (depth > budget) {
    const parkEventId = organicEventId(msOf(now));
    await graph.appendEvent(tx, {
      id: parkEventId,
      teamId: before.teamId,
      objectId: before.id,
      kind: CHAIN_PARKED_EVENT,
      origin: "organic",
      payload: {
        transition: transitionName,
        chainDepth: depth,
        chainBudget: budget,
        code: "CHAIN_BUDGET_EXCEEDED",
        // Spelled out on the event so the attention item reads the same whether
        // it is rendered from the row or from a log.
        reason: `chain depth ${depth} exceeds the budget of ${budget} - the object is parked until a person decides`,
      },
      entrance: actor.entrance,
      actorId: actor.actorId,
      ts: now,
    });
    const { obligation } = await graph.openObligation(tx, {
      objectId: before.id,
      key: CHAIN_PARK_KEY,
      teamId: before.teamId,
      class: "human-verdict",
      label: `chain budget ${budget} exceeded at depth ${depth} (${transitionName})`,
      openedByEvent: parkEventId,
      now,
    });
    return fail(
      "CHAIN_BUDGET_EXCEEDED",
      `chain depth ${depth} exceeds budget ${budget} - object parked for human review`,
      where,
      obligation,
    );
  }

  // ATTESTED CLOSE (design §12 item 8): entering a terminal state requires "no
  // open obligations, no pending actions", checked in THIS transaction and
  // recorded on the closing event so the attestation is auditable, not implied.
  //
  // A VIOLATION IS RECORDED, not just returned. Until the executor existed a
  // refused close was a log line, and the design's "violation ⇒ an attention
  // item" had nothing to compute from. So the refusal appends a `close-refused`
  // event (the same posture the chain-budget park already had) and the attention
  // section derives an item from it. This is the only place besides the park where
  // this module writes on a refusal, and the reason is identical: a refusal a
  // person must act on cannot live only in a log.
  const terminal = (spec.terminalStates ?? []).includes(t.to);
  let attestation: { openObligations: number; pendingActions: number } | undefined;
  if (terminal) {
    // Obligations this very transition closes don't block it.
    const closing = new Set(t.closes ?? []);
    const open = (await graph.listObjectObligations(tx, before.id)).filter(
      (o) => o.closedByEvent === null && !closing.has(o.key),
    );
    if (open.length) {
      const reason =
        `cannot enter terminal state "${t.to}" with ${open.length} open obligation(s): ` +
        open.map((o) => o.key).join(", ");
      await recordCloseRefusal(tx, {
        before,
        transition: transitionName,
        actor,
        now,
        code: "OPEN_OBLIGATIONS",
        reason,
        detail: { to: t.to, openObligations: open.map((o) => o.key) },
      });
      return fail("OPEN_OBLIGATIONS", reason, where);
    }
    const pending = await graph.countPendingActions(tx, before.id);
    if (pending) {
      const reason = `cannot enter terminal state "${t.to}" with ${pending} unsettled action(s)`;
      await recordCloseRefusal(tx, {
        before,
        transition: transitionName,
        actor,
        now,
        code: "PENDING_ACTIONS",
        reason,
        detail: { to: t.to, pendingActions: pending },
      });
      return fail("PENDING_ACTIONS", reason, where);
    }
    attestation = { openObligations: 0, pendingActions: 0 };
  }

  // ---- step 3 (before the apply, so a replay applies nothing): the event ----
  //
  // The latch above catches the ordinary replay; this insert is its race-safe
  // backstop. A re-derived transition mints the SAME id, `ON CONFLICT DO NOTHING`
  // swallows the insert, and we return before touching the status - so a replay
  // can never double-apply, double-open an obligation or double-enqueue an action
  // even if two derivations arrive inside the same instant.

  const diff = buildDiff(before, t.to, input.fields, input.columns as Record<string, unknown> | undefined);

  const { event, inserted } = await graph.appendEvent(tx, {
    id: eventId,
    teamId: before.teamId,
    objectId: before.id,
    kind: "status-changed",
    origin: input.derivedFrom === undefined ? "organic" : "derived",
    transition: transitionName,
    diff,
    payload: {
      ...(input.eventPayload ?? {}),
      from: before.status,
      to: t.to,
      typeVersion: typeRow.version,
      ...(attestation ? { attested: attestation } : {}),
    },
    entrance: actor.entrance,
    actorId: actor.actorId,
    ts: now,
  });
  if (!inserted) {
    // REPLAY. The original transition already landed everything.
    return {
      ok: true,
      object: (await graph.getObject(tx, objectId))!,
      event,
      replay: true,
      opened: [],
      closed: [],
      actions: await graph.listActionsForEvent(tx, eventId),
    };
  }

  // ---- step 2: apply ----

  const ctx = { objectId: before.id, transition: transitionName, eventId };
  await authorizer.begin(tx, ctx);
  let after: GraphObject;
  try {
    const payload = { ...((before.payload ?? {}) as Record<string, unknown>), ...(input.fields ?? {}) };
    after = (
      await tx
        .update(objectsTable)
        .set({
          status: t.to,
          statusChangedAt: now,
          updatedAt: now,
          ...(input.fields ? { payload } : {}),
          ...(input.columns ?? {}),
        })
        .where(eqId(before.id))
        .returning()
    )[0]!;
  } finally {
    await authorizer.end(tx, ctx);
  }

  // ---- step 4: open / close gate obligations ----

  const opened: GateObligation[] = [];
  for (const g of t.opens ?? []) {
    const { obligation, opened: didOpen } = await graph.openObligation(tx, {
      objectId: before.id,
      key: g.key,
      teamId: before.teamId,
      class: g.class,
      label: g.label ?? null,
      openedByEvent: eventId,
      // A passive wait re-surfaces on a bounded schedule so it cannot rot
      // invisibly (decision 3); an actively-owed verdict needs no reminder.
      nextReminderAt: g.class === "external-wait" ? (input.nextReminderAt ?? null) : null,
      now,
    });
    if (didOpen) opened.push(obligation);
  }
  const closed: GateObligation[] = [];
  for (const key of t.closes ?? []) {
    const row = await graph.closeObligation(tx, { objectId: before.id, key, closedByEvent: eventId, now });
    if (row) closed.push(row);
  }

  // ---- step 5: enqueue outbox actions ----

  const actions = await graph.enqueueActions(tx, {
    eventId,
    teamId: before.teamId,
    objectId: before.id,
    chainDepth: depth + 1,
    actions: declared.map((a, i) => ({
      kind: a.kind,
      payload: a.payload ?? null,
      approvalEvent: input.approvals?.[i] ?? null,
    })),
    now,
  });

  return { ok: true, object: after, event, replay: false, opened, closed, actions };
}

// ---- small local helpers ----

/**
 * Record an attested-close violation as an event, so the attention section can
 * compute an item from it (design §12 item 8 + §8's "the inbox aggregates …").
 *
 * The id is DERIVED from `(object, transition, code, now)`. Including `now` is
 * deliberate: two attempts to close the same task an hour apart are two real
 * refusals worth seeing, while a retry storm inside the same instant collapses to
 * one row. Excluding `now` would hide the second refusal; using a ULID would
 * flood the list from a caller in a loop.
 */
async function recordCloseRefusal(
  tx: GraphExec,
  input: {
    before: GraphObject;
    transition: string;
    actor: EventProvenance;
    now: string;
    code: "OPEN_OBLIGATIONS" | "PENDING_ACTIONS";
    reason: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await graph.appendEvent(tx, {
    id: derivedEventId({
      closeRefused: input.before.id,
      transition: input.transition,
      code: input.code,
      at: input.now,
    }),
    teamId: input.before.teamId,
    objectId: input.before.id,
    kind: CLOSE_REFUSED_EVENT,
    origin: "derived",
    payload: { transition: input.transition, code: input.code, reason: input.reason, ...input.detail },
    entrance: input.actor.entrance,
    actorId: input.actor.actorId,
    ts: input.now,
  });
}

const eqId = (id: string) => eq(objectsTable.id, id);

function actionClass(kind: ActionKind): ConsequenceClass {
  return ACTION_CONSEQUENCE[kind];
}

function msOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}
