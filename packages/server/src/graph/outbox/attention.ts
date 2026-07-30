/**
 * Graph Engineering v1 - ATTENTION ITEMS: the inbox category for things that went
 * wrong, as opposed to things that need a decision.
 *
 * The design's inbox "aggregates objects in gate states, review-flagged artifacts,
 * and budget-exceeded parked chains" (§8). The first two are verdicts - "Needs
 * you". The third is a different feeling entirely, and so are its siblings: an
 * effect that will never happen, a close that was refused. Those are ATTENTION,
 * and mixing them into the verdict list would either alarm a queue of ordinary
 * approvals or bury a stuck consequence among them.
 *
 * ── computed from reality, never a flag ─────────────────────────────────────
 *
 * Four real sources, one shape:
 *
 *   dead-letter      `outbox_actions` rows in state `dead-letter` (typed
 *                    `refusal_code`, so grouping never parses a message)
 *   chain-parked     `chain-parked` events - a transition refused past budget
 *   close-refused    `close-refused` events - an attested close blocked by an open
 *                    obligation or an unsettled action (design §12 item 8)
 *   directive-failed `effect_directives` rows in state `failed` - an OUTWARD
 *                    effect that never reached the world. The row read is the
 *                    DIRECTIVE, not the action that wrote it: that action did
 *                    exactly what it was asked to (it queued a work order) and
 *                    is legitimately `done`, so surfacing it instead would point
 *                    a person at a row with nothing wrong with it.
 *
 * That fourth source is the one place an attention item can be raised by
 * something OUTSIDE this server - an agent's guard refusal, or its silence until
 * the lease budget ran out. Which is exactly why it has to land here: an outward
 * effect that quietly did not happen is the worst failure this system can have.
 *
 * Nothing sets an "attention" bit. That matters more than it sounds: a flag can
 * be set and never cleared (an item that nags forever) or cleared and never set
 * (an item that vanishes). A computed list is exactly as true as the rows behind
 * it, which is the same argument decision 3 makes for the verdict inbox.
 *
 * ── resolution is an event, through the counter ──────────────────────────────
 *
 * An item leaves the list only because a HUMAN-entrance event says so, and that
 * event's id is derived from `(kind, ref)` - so acknowledging twice is one row and
 * the list is `raised − acknowledged`, the same opened-minus-closed shape as the
 * obligations it sits beside. Two verbs:
 *
 *   acknowledge  "seen; this is not going to happen." Writes the ack event (and,
 *                for a parked chain, closes the park obligation with it).
 *   retry        "try again." Writes an audit event and puts the dead-lettered
 *                action back in the queue - deliberately NOT an ack, so if the
 *                retry dead-letters again the item COMES BACK. An ack would
 *                silence the second failure, which is the one worth hearing.
 */
import { logger } from "../../logger.js";
import type { EffectDirective, GraphEvent, GraphObject, OutboxAction } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import { CHAIN_PARK_KEY } from "../applyTransition.js";
import { derivedEventId, organicEventId } from "../ids.js";
import {
  ATTENTION_ACK_EVENT,
  ATTENTION_KINDS,
  CHAIN_PARKED_EVENT,
  CLOSE_REFUSED_EVENT,
  WAIT_RECURRENCE_EVENT,
  directiveRetryable,
  type AttentionKind,
} from "../types.js";

/** The event kind a `retry` writes. Distinct from the ack so a retry never
 *  silences the failure it is retrying. */
export const ATTENTION_RETRY_EVENT = "attention-retried";

export interface AttentionItem {
  /** `<kind>:<ref>` - stable, so a client can key rows and post back an id. */
  id: string;
  kind: AttentionKind;
  /** The row this item is computed FROM: an action id, or an event id. */
  ref: string;
  /** One line naming what is stuck. */
  title: string;
  /** What actually happened, verbatim from the row that recorded it. */
  detail: string;
  /** Typed reason where the source has one (`refusal_code` for a dead-letter). */
  reason: string;
  /** When it became true. */
  raisedAt: string;
  objectId: string | null;
  /** The object's title, when it still exists - what a person recognizes. */
  subject: string | null;
  /** Offer a retry? Only a dead-letter can be re-queued; a refused close and a
   *  parked chain are fixed by acting on the graph, not by re-running a row. */
  retryable: boolean;
  /** The action kind, for a dead-letter - what effect is missing. */
  actionKind?: string;
  attempts?: number;
}

export interface AttentionView {
  items: AttentionItem[];
  /** Per-kind tally, so the UI can label sections without re-scanning. */
  counts: Record<AttentionKind, number>;
}

/** The ack event's id: derived from the item's identity, so an ack is idempotent
 *  and "already acknowledged" is a primary-key collision rather than a lookup. */
export function ackEventId(kind: AttentionKind, ref: string): string {
  return derivedEventId({ attention: kind, ref });
}

/**
 * The attention list for a team: every raised item, minus the ones a human has
 * acknowledged. Ordered oldest-first - a stuck consequence does not get less
 * stuck while newer ones arrive.
 */
export async function attentionView(teamId: string): Promise<AttentionView> {
  const acked = new Set(
    (await graph.listEventsOfKind(undefined, teamId, ATTENTION_ACK_EVENT, 1000)).map((e) => e.id),
  );
  const items: AttentionItem[] = [];

  for (const action of await graph.listDeadLetters(undefined, teamId)) {
    const item = await deadLetterItem(action);
    if (!acked.has(ackEventId(item.kind, item.ref))) items.push(item);
  }
  for (const event of await graph.listEventsOfKind(undefined, teamId, CHAIN_PARKED_EVENT, 500)) {
    const item = await eventItem(event, "chain-parked");
    if (!acked.has(ackEventId(item.kind, item.ref))) items.push(item);
  }
  for (const event of await graph.listEventsOfKind(undefined, teamId, CLOSE_REFUSED_EVENT, 500)) {
    const item = await eventItem(event, "close-refused");
    if (!acked.has(ackEventId(item.kind, item.ref))) items.push(item);
  }
  for (const directive of await graph.listFailedDirectives(undefined, teamId)) {
    const item = await directiveItem(directive);
    if (!acked.has(ackEventId(item.kind, item.ref))) items.push(item);
  }
  // A verification wait whose answer said the thing came BACK (decision 14). The
  // wait reopens itself, so the watcher keeps watching; this item is the part
  // re-watching could never deliver - telling a person that a fix stopped holding.
  for (const event of await graph.listEventsOfKind(undefined, teamId, WAIT_RECURRENCE_EVENT, 500)) {
    const item = await eventItem(event, "wait-recurrence");
    if (!acked.has(ackEventId(item.kind, item.ref))) items.push(item);
  }

  items.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  const counts = Object.fromEntries(ATTENTION_KINDS.map((k) => [k, 0])) as Record<AttentionKind, number>;
  for (const i of items) counts[i.kind]++;
  return { items, counts };
}

async function deadLetterItem(action: OutboxAction): Promise<AttentionItem> {
  const object = action.objectId ? await graph.getObject(undefined, action.objectId) : undefined;
  return {
    id: `dead-letter:${action.id}`,
    kind: "dead-letter",
    ref: action.id,
    title: `“${action.kind}” never took effect`,
    detail: action.lastError ?? "no error recorded",
    reason: action.refusalCode ?? "UNKNOWN",
    raisedAt: action.deadLetteredAt ?? action.createdAt,
    objectId: action.objectId,
    subject: subjectOf(object),
    // A refusal is terminal by construction; only a genuinely exhausted transient
    // failure is worth another go, and offering "retry" on an unapprovable outward
    // effect would be a button that always loses.
    retryable: action.refusalCode === "RETRIES_EXHAUSTED",
    actionKind: action.kind,
    attempts: action.attempts,
  };
}

/**
 * A failed OUTWARD effect. The title names the external target rather than the
 * graph object, because "the comment on org/repo#12 never got posted" is the
 * sentence a person can act on - the object id is not.
 *
 * `retryable` comes from the TYPED refusal code, not from a guess: a transient
 * agent error or an expired lease is worth another go, and a guard refusal is
 * not. A repo does not join an allowlist by being retried, and offering a button
 * that always loses is worse than offering none.
 */
async function directiveItem(d: EffectDirective): Promise<AttentionItem> {
  const object = d.objectId ? await graph.getObject(undefined, d.objectId) : undefined;
  return {
    id: `directive-failed:${d.id}`,
    kind: "directive-failed",
    ref: d.id,
    title: `“${d.kind}” never reached ${d.targetExternalId}`,
    detail: d.lastError ?? "no error recorded",
    reason: d.refusalCode ?? "UNKNOWN",
    raisedAt: d.settledAt ?? d.createdAt,
    objectId: d.objectId,
    subject: subjectOf(object),
    retryable: directiveRetryable(d.refusalCode),
    actionKind: d.kind,
    attempts: d.attempts,
  };
}

async function eventItem(event: GraphEvent, kind: AttentionKind): Promise<AttentionItem> {
  const object = event.objectId ? await graph.getObject(undefined, event.objectId) : undefined;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const transition = typeof p.transition === "string" ? p.transition : undefined;
  const waitKey = typeof p.key === "string" ? p.key : undefined;
  const title =
    kind === "chain-parked"
      ? `Rule chain parked${transition ? ` at “${transition}”` : ""}`
      : kind === "wait-recurrence"
        ? `It came back${waitKey ? `: “${waitKey}”` : ""}`
        : `Close refused${transition ? ` on “${transition}”` : ""}`;
  return {
    id: `${kind}:${event.id}`,
    kind,
    ref: event.id,
    title,
    detail: typeof p.reason === "string" ? p.reason : summarizePayload(p),
    reason:
      typeof p.code === "string"
        ? p.code
        : kind === "chain-parked"
          ? "CHAIN_BUDGET_EXCEEDED"
          : kind === "wait-recurrence"
            ? "WAIT_RECURRENCE"
            : "ATTESTED_CLOSE",
    raisedAt: event.ts,
    objectId: event.objectId,
    subject: subjectOf(object),
    retryable: false,
  };
}

function subjectOf(o: GraphObject | undefined): string | null {
  return o ? (o.title ?? o.id) : null;
}

function summarizePayload(p: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === "note" && typeof v === "string") return v;
    if (typeof v === "string" || typeof v === "number") parts.push(`${k}: ${v}`);
  }
  return parts.join(" · ") || "no detail recorded";
}

// ---- resolution ----

export type ResolveVerb = "acknowledge" | "retry";

export interface ResolveInput {
  teamId: string;
  kind: AttentionKind;
  ref: string;
  verb: ResolveVerb;
  /** ISO. Required - nothing in the graph reads a clock. */
  now: string;
  /** The acting person. This is a HUMAN-entrance event, so the actor is a user id
   *  and never a placeholder. */
  userId: string;
}

export type ResolveResult =
  | { ok: true; verb: ResolveVerb; eventId: string; replay: boolean; detail: string }
  | { ok: false; code: "UNKNOWN_ITEM" | "NOT_RETRYABLE"; message: string };

/**
 * Resolve one attention item. Both verbs go THROUGH THE COUNTER: an event row
 * with `entrance: "human"` and the acting user as `actorId`, exactly like a
 * verdict, so "who cleared this and when" is answerable from the same log as
 * everything else.
 */
export async function resolveAttention(input: ResolveInput): Promise<ResolveResult> {
  const { teamId, kind, ref, verb, now, userId } = input;

  if (verb === "retry" && kind === "directive-failed") {
    // The directive-channel twin of the dead-letter retry below, and deliberately
    // the same shape: audit first, re-queue second, and NO acknowledgement - so a
    // second failure comes straight back to this list instead of being silenced
    // by the act of asking for one more try.
    const directive = await graph.getDirective(undefined, ref);
    if (!directive || directive.teamId !== teamId) {
      return { ok: false, code: "UNKNOWN_ITEM", message: `no effect directive ${ref} in this workspace` };
    }
    if (directive.state !== "failed") {
      return { ok: false, code: "NOT_RETRYABLE", message: `directive ${ref} is "${directive.state}", not failed` };
    }
    if (!directiveRetryable(directive.refusalCode)) {
      // A guard refusal is a decision about the world, not a blip. Re-queueing it
      // would hand the agent the same work order to refuse identically.
      return {
        ok: false,
        code: "NOT_RETRYABLE",
        message: `${directive.refusalCode} is a refusal, not a failure - retrying cannot change it`,
      };
    }
    const { event } = await graph.appendEvent(undefined, {
      id: organicEventId(Date.parse(now) || 0),
      teamId,
      objectId: directive.objectId,
      kind: ATTENTION_RETRY_EVENT,
      origin: "organic",
      payload: { directive: ref, previousError: directive.lastError, previousCode: directive.refusalCode },
      entrance: "human",
      actorId: userId,
      ts: now,
    });
    await graph.requeueDirective(undefined, ref);
    logger.info({ directive: ref, userId }, "attention: failed effect directive re-queued by a human");
    return {
      ok: true,
      verb,
      eventId: event.id,
      replay: false,
      detail: `${ref} is queued again - the next agent poll will pick it up, and it comes back here if it fails`,
    };
  }

  if (verb === "retry") {
    if (kind !== "dead-letter") {
      return { ok: false, code: "NOT_RETRYABLE", message: `a ${kind} item is not a queued action - nothing to re-run` };
    }
    const action = await graph.getAction(undefined, ref);
    if (!action || action.teamId !== teamId) {
      return { ok: false, code: "UNKNOWN_ITEM", message: `no action ${ref} in this workspace` };
    }
    if (action.state !== "dead-letter") {
      return { ok: false, code: "NOT_RETRYABLE", message: `action ${ref} is "${action.state}", not dead-lettered` };
    }
    // Audit first, then re-queue: if the process dies between them the log says a
    // retry was asked for and the row is still visibly dead-lettered, which is the
    // safe half-state to be in.
    const { event, inserted } = await graph.appendEvent(undefined, {
      // ORGANIC: two retries of the same row a day apart are two real decisions,
      // so this id is a ULID and is never deduplicated - unlike the ack, whose
      // whole job is to be idempotent.
      id: organicEventId(Date.parse(now) || 0),
      teamId,
      objectId: action.objectId,
      kind: ATTENTION_RETRY_EVENT,
      origin: "organic",
      payload: { action: ref, previousError: action.lastError, previousCode: action.refusalCode },
      entrance: "human",
      actorId: userId,
      ts: now,
    });
    await graph.requeueDeadLetter(undefined, ref);
    logger.info({ action: ref, userId }, "attention: dead-letter re-queued by a human");
    return {
      ok: true,
      verb,
      eventId: event.id,
      replay: !inserted,
      detail: `${ref} is queued again - it will be re-attempted, and it comes back here if it fails`,
    };
  }

  // acknowledge
  const objectId = await refObjectId(kind, ref);
  const { event, inserted } = await graph.appendEvent(undefined, {
    id: ackEventId(kind, ref),
    teamId,
    objectId,
    kind: ATTENTION_ACK_EVENT,
    origin: "derived", // identity IS `(kind, ref)`: acknowledging twice is one row
    payload: { attention: kind, ref },
    entrance: "human",
    actorId: userId,
    ts: now,
  });
  // A parked chain also holds a human-verdict obligation. The ack IS the verdict
  // on it, so it closes the obligation too - otherwise the object could never
  // reach a terminal state again, and the park would be permanent rather than
  // terminal-until-verdict.
  if (kind === "chain-parked" && objectId) {
    await graph.closeObligation(undefined, { objectId, key: CHAIN_PARK_KEY, closedByEvent: event.id, now });
  }
  logger.info({ kind, ref, userId }, "attention: item acknowledged");
  return {
    ok: true,
    verb,
    eventId: event.id,
    replay: !inserted,
    detail: inserted ? "acknowledged" : "was already acknowledged",
  };
}

/** Which object an item hangs off, so its ack event is attributed to it. */
async function refObjectId(kind: AttentionKind, ref: string): Promise<string | null> {
  if (kind === "dead-letter") return (await graph.getAction(undefined, ref))?.objectId ?? null;
  if (kind === "directive-failed") return (await graph.getDirective(undefined, ref))?.objectId ?? null;
  return (await graph.getEvent(undefined, ref))?.objectId ?? null;
}
