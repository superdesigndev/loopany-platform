/**
 * Graph Engineering v1 - SENSING, pipe 1: INGEST one observation.
 *
 * This is to a mirror what `applyTransition` is to a task: the single seam an
 * external fact enters the graph through, with the whole effect in ONE
 * transaction. It is deliberately shaped like its sibling so the two read the
 * same way, and deliberately much smaller, because an observation is not a
 * decision - there is no state machine to guard, no entrance to restrict and no
 * approval to check.
 *
 * THE CONTRACT, all in one transaction:
 *   1. LOCK the mirror row (`SELECT … FOR UPDATE`) as the first statement, so two
 *      sweeps observing the same PR serialize instead of racing. The second one
 *      re-reads the post-commit row and therefore diffs against what actually
 *      exists - the same actor-mailbox discipline `applyTransition` uses.
 *   2. DIFF the observation against the stored facts. NO CHANGE ⇒ stamp freshness
 *      and stop: zero events, zero field churn, so re-polling forever is free.
 *      This is the property the whole pipe rests on.
 *   3. APPEND one DERIVED `external-changed` event per changed field, id derived
 *      from the change's own identity, `ON CONFLICT DO NOTHING`. A replayed
 *      observation collides and inserts nothing.
 *   4. WRITE the changed facts onto the mirror (payload + the projected `status`
 *      + the display title) through `graphStore.recordMirrorObservation`.
 *   5. CLOSE any open `external-wait` obligation on this mirror whose condition
 *      the observed facts now satisfy, with `closed_by_event` = the observation
 *      that satisfied it (design §12 item 5).
 *
 * ── the clock ────────────────────────────────────────────────────────────────
 *
 * `now` is passed in, exactly as transitions require (design §12 item 8). Nothing
 * in this module reads a clock, which is what lets a probe replay an observation
 * at an arbitrary instant and assert the second one changed nothing.
 */
import { logger } from "../../logger.js";
import { db } from "../../db/index.js";
import type { GateObligation, GraphEvent, GraphObject } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import type { GraphExec } from "../../db/graphStore.js";
import {
  OBSERVATION_EVENT,
  PR_POLLER_ACTOR,
  PR_SOURCE,
  conditionOf,
  diffObservation,
  mirrorStatusFor,
  mirrorTitle,
  observationEventId,
  observedPayload,
  parsePrExternalId,
  waitSatisfied,
  type FieldChange,
  type ObservedPr,
} from "./pr.js";

export interface ObserveInput {
  /** The mirror object id. Must be a mirror; anything else is refused. */
  objectId: string;
  observed: ObservedPr;
  /** ISO instant. REQUIRED - this module never reads a clock. */
  now: string;
  /** Provenance actor. Defaults to the poller rule; a probe may name itself. */
  actorId?: string;
}

export type ObserveError = "UNKNOWN_OBJECT" | "NOT_A_MIRROR" | "IDENTITY_MISMATCH" | "UNKNOWN_STATUS";

export interface ObserveOk {
  ok: true;
  mirror: GraphObject;
  /** The fields that actually moved. EMPTY on a re-poll of unchanged facts, which
   *  is the normal steady-state outcome and not a failure. */
  changed: FieldChange[];
  /** One event per changed field. Empty when `changed` is empty; shorter than
   *  `changed` when a concurrent sweep had already written some of them. */
  events: GraphEvent[];
  /** External-wait obligations this observation discharged. */
  closed: GateObligation[];
  /** True when every derived event already existed - a pure replay. */
  replay: boolean;
}

export interface ObserveFail {
  ok: false;
  code: ObserveError;
  message: string;
}

export type ObserveResult = ObserveOk | ObserveFail;

/** Ingest one observation in its own transaction. */
export async function recordObservation(input: ObserveInput): Promise<ObserveResult> {
  return db.transaction(async (tx) => recordObservationIn(tx as unknown as GraphExec, input));
}

/**
 * The body, against a caller-supplied executor - so a sweep can compose several
 * observations into one transaction if it ever needs to, the same way
 * `applyTransitionIn` exists next to `applyTransition`.
 */
export async function recordObservationIn(tx: GraphExec, input: ObserveInput): Promise<ObserveResult> {
  const { objectId, observed, now } = input;
  const actorId = input.actorId ?? PR_POLLER_ACTOR;

  // ACTOR MAILBOX: the lock is the first statement, before anything is read for a
  // decision. Two sweeps on the same mirror serialize here.
  const mirror = await graph.getObjectForUpdate(tx, objectId);
  if (!mirror) return refuse("UNKNOWN_OBJECT", `no object ${objectId}`, objectId);
  if (mirror.archetype !== "mirror") {
    return refuse(
      "NOT_A_MIRROR",
      `${objectId} is a ${mirror.archetype}, not a mirror - an observation is not a state change we own`,
      objectId,
    );
  }

  // The observation must be ABOUT this mirror. Without this check a fetcher bug
  // that mismatched a batch response to its request would quietly write one PR's
  // facts onto another PR's mirror - a wrong observation, which is worse than a
  // missing one.
  const identity = parsePrExternalId(mirror.externalId);
  if (!identity || identity.repo !== observed.repo || identity.number !== observed.number) {
    return refuse(
      "IDENTITY_MISMATCH",
      `mirror ${objectId} is ${mirror.externalSource}/${mirror.externalId}, ` +
        `but the observation is for ${observed.repo}/pull/${observed.number}`,
      objectId,
    );
  }

  // The projected status must be one the mirror type's EFFECTIVE version declares
  // (decision 4: readers resolve effective, never a proposal). An observation
  // cannot invent a state any more than a transition can.
  const status = mirrorStatusFor(observed);
  const typeRow = await graph.getEffectiveType(tx, mirror.teamId, mirror.type);
  const states = typeRow?.spec.states ?? [];
  if (states.length && !states.includes(status)) {
    return refuse(
      "UNKNOWN_STATUS",
      `observed status "${status}" is not declared by ${mirror.type} v${typeRow?.version} (${states.join(", ")})`,
      objectId,
    );
  }

  const changed = diffObservation(mirror.payload, mirror.status, observed);

  // ── nothing moved ──────────────────────────────────────────────────────────
  //
  // The steady state, and the reason the poller may run forever: no event, no
  // field write, only the freshness stamp that answers "when did we last look?".
  if (!changed.length) {
    await graph.stampMirrorObserved(tx, mirror.id, now);
    // A wait can still be discharged here: it may have been opened AFTER the
    // observation that satisfied it landed. Closing it needs an event, and the
    // event we point at is the one that established the fact - so this only ever
    // closes a wait whose satisfying observation is already in the log.
    const closed = await closeSatisfiedWaits(tx, mirror, observed, now, undefined);
    return { ok: true, mirror, changed: [], events: [], closed, replay: false };
  }

  // ── step 3: one derived event per changed fact ─────────────────────────────
  const events: GraphEvent[] = [];
  let inserted = 0;
  /** The event a discharged wait points at: the STATUS observation, because that
   *  is the projection every wait condition is about. Undefined when this
   *  observation moved facts but not the status (a title edit). */
  let statusEvent: string | undefined;
  for (const change of changed) {
    const id = observationEventId(identity, change);
    if (change.field === "status") statusEvent = id;
    const { event, inserted: isNew } = await graph.appendEvent(tx, {
      id,
      teamId: mirror.teamId,
      objectId: mirror.id,
      kind: OBSERVATION_EVENT,
      origin: "derived",
      // `diff` is not required for a non-`status-changed` event, but the whole
      // point of decision 1 is that an event says what happened on its own.
      diff: { [change.field]: { old: change.from, new: change.to } },
      payload: {
        source: PR_SOURCE,
        repo: identity.repo,
        number: identity.number,
        field: change.field,
        from: change.from,
        to: change.to,
        // The Timeline renders `payload.note` when present, so an observation
        // reads as prose there like every other row.
        note: observationNote(identity.number, change),
      },
      entrance: "rule",
      actorId,
      ts: now,
    });
    events.push(event);
    if (isNew) inserted++;
  }

  // A full replay: every event already existed, so the field write already
  // happened too. Stamp freshness and stop, rather than re-writing values that
  // are by definition already there.
  if (inserted === 0) {
    await graph.stampMirrorObserved(tx, mirror.id, now);
    const closed = await closeSatisfiedWaits(tx, mirror, observed, now, statusEvent);
    return { ok: true, mirror, changed, events, closed, replay: true };
  }

  // ── step 4: the facts land on the mirror ──────────────────────────────────
  const after =
    (await graph.recordMirrorObservation(tx, {
      id: mirror.id,
      status,
      payload: { ...((mirror.payload ?? {}) as Record<string, unknown>), ...observedPayload(observed) },
      title: mirrorTitle(observed),
      now,
    })) ?? mirror;

  // ── step 5: the world caught up with a decision we were waiting on ─────────
  const closed = await closeSatisfiedWaits(tx, after, observed, now, statusEvent);

  logger.info(
    { mirror: mirror.id, pr: `${identity.repo}#${identity.number}`, changed: changed.map((c) => c.field), closed: closed.length },
    "sensing: observation ingested",
  );
  return { ok: true, mirror: after, changed, events, closed, replay: false };
}

/**
 * Close every open `external-wait` on this mirror whose condition the observed
 * facts now satisfy.
 *
 * The condition is read from the obligation's own row - `label` is prose, so the
 * machine-readable condition rides the KEY: an obligation key is `<name>` for the
 * default `merged` condition, or `<name>:<condition>` to name one explicitly.
 * That keeps the binding on the row itself (design's "keyed obligations"), so a
 * sweep needs no side table to know what discharges what.
 *
 * `closedByEvent` is the OBSERVATION - not a synthetic close event. The obligation
 * therefore points at the exact fact that discharged it, which is the audit trail
 * the design asks for ("opened-by / closed-by event pointers"). When this
 * observation changed nothing, `satisfyingEvent` is undefined and we look up the
 * event that established the fact instead of inventing one; with no such event in
 * the log the wait STAYS OPEN, because an obligation with no closing event would
 * violate the schema's closed-pair CHECK.
 */
async function closeSatisfiedWaits(
  tx: GraphExec,
  mirror: GraphObject,
  observed: ObservedPr,
  now: string,
  satisfyingEvent: string | undefined,
): Promise<GateObligation[]> {
  const open = (await graph.listObjectObligations(tx, mirror.id)).filter(
    (o) => o.closedByEvent === null && o.class === "external-wait",
  );
  if (!open.length) return [];

  const identity = parsePrExternalId(mirror.externalId);
  if (!identity) return [];

  const closed: GateObligation[] = [];
  for (const obligation of open) {
    const condition = conditionOf(obligation.key);
    if (!waitSatisfied(condition, observed)) continue;

    // Which event proves it? This sweep's, when it moved something; otherwise the
    // one that recorded the fact when it first arrived. Both are real rows.
    const closedByEvent = satisfyingEvent ?? (await establishingEvent(tx, identity, observed));
    if (!closedByEvent) {
      logger.warn(
        { mirror: mirror.id, key: obligation.key, condition },
        "sensing: wait is satisfied but no observation event proves it - leaving it open",
      );
      continue;
    }
    const row = await graph.closeObligation(tx, {
      objectId: mirror.id,
      key: obligation.key,
      closedByEvent,
      now,
    });
    if (row) {
      closed.push(row);
      logger.info(
        { mirror: mirror.id, key: obligation.key, condition, event: closedByEvent },
        "sensing: external-wait closed by observation",
      );
    }
  }
  return closed;
}

/**
 * The event that established the fact this condition waits on, looked up by its
 * DERIVED id rather than by scanning history - the same identity function that
 * wrote it, run backwards. Bounded and exact: no window, no "recent N".
 *
 * Only the `status` field is probed, because that is the projection every
 * condition ultimately bottoms out in and it is the field a wait is about. A
 * condition satisfied without any status movement (checks-green on an already
 * green PR) simply finds nothing and the wait stays open until the next real
 * move, which is the honest, visible direction.
 */
async function establishingEvent(
  tx: GraphExec,
  identity: { repo: string; number: number },
  observed: ObservedPr,
): Promise<string | undefined> {
  const to = mirrorStatusFor(observed);
  // Every status the mirror could have come FROM. Small closed set, so this is a
  // handful of primary-key lookups rather than a scan.
  const candidates: (string | null)[] = ["observed", "open", "checks-green", "merged", "closed", null];
  for (const from of candidates) {
    if (from === to) continue;
    const id = observationEventId(identity, { field: "status", from, to });
    if (await graph.getEvent(tx, id)) return id;
  }
  return undefined;
}

/** The Timeline line for one observed change. Plain prose over the real values -
 *  the feed is the audit log, so it says the fact, not a summary of it. */
function observationNote(number: number, change: FieldChange): string {
  const from = change.from === null || change.from === undefined ? "unobserved" : String(change.from);
  return `observed PR #${number} ${change.field}: ${from} → ${String(change.to)}`;
}

function refuse(code: ObserveError, message: string, objectId: string): ObserveFail {
  logger.warn({ code, objectId }, `sensing: observation refused - ${message}`);
  return { ok: false, code, message };
}

export const _internals = { closeSatisfiedWaits, establishingEvent, observationNote };
