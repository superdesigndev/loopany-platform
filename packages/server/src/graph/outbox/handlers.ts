/**
 * Graph Engineering v1 - the OUTBOX HANDLER REGISTRY.
 *
 * One handler per action kind, keyed by the closed `ActionKind` vocabulary. A
 * kind with no handler is NOT quietly marked done - the executor dead-letters it
 * with `NO_HANDLER`, so an unimplemented consequence is visible rather than
 * silently dropped. That posture is why this registry is a plain lookup and not a
 * default-to-noop map.
 *
 * NO HANDLER HERE EVER TOUCHES THE OUTSIDE WORLD. Most are in-graph: `notify`
 * writes a notification row, `enqueue-review` creates a shepherd task through
 * `applyTransition`, `update-fields` writes plain fields on a tracked object. The
 * two OUTWARD (R3) handlers - `external-comment` and `external-merge` - do not
 * perform their effect either: they write an EFFECT DIRECTIVE, a work order a
 * machine-side agent claims and executes with local credentials
 * (`graph/effects/`). The server stays zero-exec; what changed is that an outward
 * consequence now has somewhere to go instead of dead-lettering.
 *
 * The outward ceiling therefore no longer holds by ABSENCE. It holds by three
 * independent checks on the same fact: the schema CHECK when the action was
 * enqueued, the executor's re-check that the approval event exists and was
 * entered by a HUMAN, and the agent's own re-check of the approval block that
 * rides with the work order. Governance (R4) kinds still have no handler at all.
 *
 * ── idempotency, which is the whole contract ─────────────────────────────────
 *
 * The executor is at-least-once by construction (a crash between the effect and
 * the stamp is indistinguishable from a crash before it), so a handler that is
 * not idempotent is a bug waiting for a bad deploy. Each one below derives its
 * effect's IDENTITY from the action id rather than checking-then-writing:
 *
 *   notify            the notification row's primary key IS the action id
 *   enqueue-review    the shepherd's object id is `obj-rev-<sha256(action, target)>`,
 *                     and its gate-opening transition is `derivedFrom` the action -
 *                     so a replay collides on both the object and the event
 *   update-fields     a field write is naturally idempotent (same value, same result)
 *   external-comment  the directive row's primary key IS the action id, and the
 *   external-merge    comment it asks for carries that id as a marker - so the
 *                     idempotency survives all the way out to GitHub
 *
 * None of them reads "have I run before?". Identity does that work, which is the
 * one dedup strategy that does not degrade with history length (design §12 item 6).
 */
import { logger } from "../../logger.js";
import type { GraphObject, OutboxAction } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import type { GraphExec } from "../../db/graphStore.js";
import { applyTransitionIn } from "../applyTransition.js";
import {
  buildCommentBody,
  directiveMarker,
  effectKindOf,
  mergeMethodOf,
  targetOfMirror,
} from "../effects/directive.js";
import { derivedEventId, reviewObjectId } from "../ids.js";
import { conditionOf, observedFromPayload, waitSatisfied } from "../sensing/pr.js";
import type { ActionKind, TypeSpec } from "../types.js";

/** What a handler is given. `now` is passed in - handlers never read a clock,
 *  for the same reason transitions never do (design §12 item 8). */
export interface HandlerContext {
  /** The transaction the whole attempt runs in: the effect and its stamp commit
   *  together, so a rolled-back attempt leaves no half-effect behind. */
  tx: GraphExec;
  action: OutboxAction;
  now: string;
  /** Chain budget in force for this pass, so a handler that runs a transition
   *  hands the budget down instead of re-deriving it. */
  chainBudget: number;
}

/**
 * A handler's outcome. Three shapes, and the difference between the last two is
 * the difference between "try again" and "stop and tell someone":
 *
 *  - `{ok: true}`        the effect landed (or was already there). Stamp it done.
 *  - `{ok: false, retryable: true}`  transient. Back off and retry, then
 *                        dead-letter when the budget runs out.
 *  - `{ok: false, retryable: false}` a reason retrying cannot fix (a missing
 *                        target, a refusal from the transition seam). Dead-letter
 *                        immediately - a hundred retries of a permanent refusal
 *                        is just a slower way of hiding it.
 */
export type HandlerResult =
  | { ok: true; detail?: string }
  | { ok: false; retryable: boolean; detail: string };

export type ActionHandler = (ctx: HandlerContext) => Promise<HandlerResult>;

const payloadOf = (a: OutboxAction) => (a.payload ?? {}) as Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

// ---- notify (R2) ----

/**
 * The visible consequence of a verdict: a notification row in the workspace.
 *
 * Deliberately the smallest possible real effect. It is NOT a push, a webhook or
 * a daemon delivery - those are outward (R3) and belong behind an approval and a
 * later unit. What it proves is the thing that was missing: a human decision now
 * CAUSES something a human can see, through the outbox, with provenance.
 *
 * Title/body come from the action payload when the spec supplies them, else from
 * the object the transition ran on - so a spec that declares a bare
 * `{channel: "inbox"}` still produces a legible line rather than an empty row.
 */
const notify: ActionHandler = async ({ tx, action, now }) => {
  const p = payloadOf(action);
  const object = action.objectId ? await graph.getObject(tx, action.objectId) : undefined;
  const title = str(p.title) ?? (object ? `${object.title ?? object.id} · ${object.status}` : "Workspace update");

  const { created } = await graph.insertNotification(tx, {
    // IDEMPOTENCY: the action id IS the primary key.
    id: action.id,
    teamId: action.teamId,
    objectId: action.objectId,
    eventId: action.eventId,
    channel: str(p.channel) ?? "inbox",
    title,
    body: str(p.body) ?? (object ? describeObject(object) : null),
    createdAt: now,
  });
  return { ok: true, detail: created ? "notification written" : "notification already existed (replay)" };
};

function describeObject(o: GraphObject): string {
  const kind = o.type === o.archetype ? o.archetype : `${o.type} (${o.archetype})`;
  return `${kind} is now “${o.status}”.`;
}

// ---- enqueue-review (R2) ----

/**
 * Make sure a HUMAN REVIEW is queued for something - the action that turns "this
 * content needs a verdict" into an actual row a person can act on.
 *
 * Payload contract:
 *
 *   queue        display label for the review queue (`publish`, `merge`, …)
 *   review       the SHEPHERD TYPE to create (`publish-review`, …). Required for
 *                the create path; without it the handler can only confirm an
 *                already-open review.
 *   transition   the shepherd's gate-opening transition. Optional - resolved from
 *                the effective spec when omitted (the one transition out of the
 *                initial state that OPENS a `human-verdict` obligation), so a new
 *                review type needs no payload change.
 *   via          `self` (default) - the review target is the action's own object;
 *                `tracks`        - follow the object's `tracks` edge;
 *                `produces`      - fan out over the object's `produces` edges.
 *   select       for `via: "produces"`: `{type?, unpublished?}` filter, so a loop
 *                can declare "review the posts I make" without naming instances.
 *
 * ALREADY-QUEUED IS SUCCESS. When the target is itself a shepherd task already
 * sitting in a gate state with its obligation open, the review IS queued and the
 * handler is done. That is not a special case bolted on: today's specs declare
 * this action ON the gate-opening transition, so the common path is exactly
 * "confirm what the transition just opened", and treating it as anything but
 * success would dead-letter the entire existing fleet.
 *
 * THE CREATED OBJECT CARRIES PROVENANCE. The shepherd is created and then moved
 * through `applyTransition` with `entrance: "rule"` and `actorId` = the action
 * id, so its gate obligation opens the normal way and the Timeline can name what
 * caused it. Its id is derived from `(action, target)`, so a re-execution
 * resolves the SAME object instead of minting a twin.
 */
const enqueueReview: ActionHandler = async (ctx) => {
  const { tx, action } = ctx;
  const p = payloadOf(action);
  if (!action.objectId) return { ok: false, retryable: false, detail: "action carries no object" };

  const via = str(p.via) ?? "self";
  const targets = await resolveReviewTargets(ctx, via);
  if (!targets.ok) return targets.fail;
  if (!targets.objects.length) {
    // Nothing matched the selector. A clean stop, not a failure: a loop that
    // produced nothing reviewable this pass owes no review.
    return { ok: true, detail: `no review target matched (via ${via})` };
  }

  const detail: string[] = [];
  for (const target of targets.objects) {
    const outcome = await ensureReview(ctx, target);
    if (!outcome.ok) return outcome;
    detail.push(outcome.detail ?? target.id);
  }
  return { ok: true, detail: detail.join("; ") };
};

type TargetResolution =
  | { ok: true; objects: GraphObject[] }
  | { ok: false; fail: Extract<HandlerResult, { ok: false }> };

async function resolveReviewTargets(ctx: HandlerContext, via: string): Promise<TargetResolution> {
  const { tx, action } = ctx;
  const p = payloadOf(action);
  const objectId = action.objectId!;

  if (via === "self") {
    const self = await graph.getObject(tx, objectId);
    if (!self) return { ok: false, fail: { ok: false, retryable: false, detail: `object ${objectId} is gone` } };
    return { ok: true, objects: [self] };
  }
  if (via === "tracks") {
    const edge = (await graph.edgesFrom(tx, objectId, "tracks"))[0];
    if (!edge) return { ok: true, objects: [] };
    const target = await graph.getObject(tx, edge.dstId);
    return { ok: true, objects: target ? [target] : [] };
  }
  if (via === "produces") {
    const select = (p.select ?? {}) as { type?: unknown; unpublished?: unknown };
    const wantType = str(select.type);
    const produced = await graph.edgesFrom(tx, objectId, "produces");
    const out: GraphObject[] = [];
    for (const edge of produced) {
      const candidate = await graph.getObject(tx, edge.dstId);
      if (!candidate) continue;
      if (wantType && candidate.type !== wantType) continue;
      if (select.unpublished === true && (candidate.payload as Record<string, unknown> | null)?.published === true) {
        continue;
      }
      // Something already reviewing it means the review is queued; a second
      // shepherd would be a twin with a different id, which is exactly the
      // duplicate class the deterministic-identity rule exists to prevent.
      if (await hasReviewer(ctx, candidate.id)) continue;
      out.push(candidate);
    }
    return { ok: true, objects: out };
  }
  return { ok: false, fail: { ok: false, retryable: false, detail: `unknown via "${via}"` } };
}

/** Is some task already tracking this object with an OPEN obligation? */
async function hasReviewer(ctx: HandlerContext, objectId: string): Promise<boolean> {
  const incoming = await graph.edgesTo(ctx.tx, objectId, "tracks");
  for (const edge of incoming) {
    const open = await graph.countOpenObligations(ctx.tx, edge.srcId);
    if (open > 0) return true;
    // A settled review still counts: its verdict was given, and re-opening one
    // on the same content would ask the same question twice.
    const reviewer = await graph.getObject(ctx.tx, edge.srcId);
    if (reviewer && reviewer.archetype === "task") return true;
  }
  return false;
}

/**
 * The create path: the target needs a shepherd, so make one and open its gate.
 *
 * Both halves are idempotent by identity - `reviewObjectId(action, target)` for
 * the object, and `derivedFrom` on the transition so its event id is a pure
 * function of the same pair. Re-executing the action therefore lands on the SAME
 * shepherd and the SAME event, and the second pass changes nothing.
 */
async function ensureReview(ctx: HandlerContext, target: GraphObject): Promise<HandlerResult> {
  const { tx, action, now } = ctx;
  const p = payloadOf(action);

  // Already a shepherd holding an open verdict? Then the review is queued and
  // there is nothing to do - the common case for today's specs, which declare
  // this action on the very transition that opened the gate.
  if (target.archetype === "task" && (await graph.countOpenObligations(tx, target.id)) > 0) {
    return { ok: true, detail: `${target.id} already holds an open obligation` };
  }

  const reviewType = str(p.review);
  if (!reviewType) {
    return {
      ok: false,
      retryable: false,
      detail: `nothing is holding a verdict on ${target.id} and the action names no \`review\` type to create one`,
    };
  }
  const typeRow = await graph.getEffectiveType(tx, action.teamId, reviewType);
  if (!typeRow) {
    return { ok: false, retryable: false, detail: `review type "${reviewType}" has no effective registry version` };
  }
  const spec = typeRow.spec;
  const transition = str(p.transition) ?? gateOpeningTransition(spec);
  if (!transition) {
    return { ok: false, retryable: false, detail: `"${reviewType}" declares no transition that opens a human verdict` };
  }

  const shepherdId = reviewObjectId(action.id, target.id);
  const existing = await graph.getObject(tx, shepherdId);
  if (!existing) {
    await graph.createObject(tx, {
      id: shepherdId,
      teamId: action.teamId,
      archetype: "task",
      type: reviewType,
      typeVersion: typeRow.version,
      status: spec.initialState,
      title: target.title ?? target.id,
      payload: {
        reviews: target.id,
        queue: str(p.queue) ?? reviewType,
        // Attribution: this task exists because an action fired, not because a
        // person or a seed script made it.
        createdByAction: action.id,
        ...(loopKeyOf(target) ? { loopKey: loopKeyOf(target) } : {}),
      },
      now,
    });
    await graph.upsertEdge(tx, {
      teamId: action.teamId,
      kind: "tracks",
      srcId: shepherdId,
      dstId: target.id,
      createdByEvent: action.eventId,
      now,
    });
    // Whoever produced the content produces its review too, so the System view's
    // gate node hangs off the right loop rather than floating.
    for (const producer of await graph.edgesTo(tx, target.id, "produces")) {
      await graph.upsertEdge(tx, {
        teamId: action.teamId,
        kind: "produces",
        srcId: producer.srcId,
        dstId: shepherdId,
        createdByEvent: action.eventId,
        now,
      });
    }
  }

  // Open the gate THROUGH the seam: entrance `rule`, actor = the action id. The
  // obligation opens the normal way, the event carries real provenance, and the
  // chain depth is handed down so a rule that spawns rules still hits the budget.
  const result = await applyTransitionIn(tx, {
    objectId: shepherdId,
    transition,
    actor: { entrance: "rule", actorId: action.id },
    now,
    derivedFrom: { action: action.id, target: target.id, transition },
    chainDepth: action.chainDepth,
    chainBudget: ctx.chainBudget,
    eventPayload: { note: `review queued for ${target.title ?? target.id}`, queue: str(p.queue) ?? reviewType },
  });
  if (!result.ok) {
    // The seam refused. A refusal is a decision, not a blip - retrying it would
    // only re-run the same guards against the same world.
    return { ok: false, retryable: false, detail: `${transition} refused: ${result.code} - ${result.message}` };
  }
  return { ok: true, detail: `${shepherdId} → ${result.object.status}` };
}

/** The transition that takes a fresh review from its initial state into its gate:
 *  the one that OPENS a `human-verdict` obligation. Resolved from the spec so a
 *  new review type needs no payload and no lookup table. */
export function gateOpeningTransition(spec: TypeSpec): string | undefined {
  const gates = new Set(spec.gateStates ?? []);
  return spec.transitions.find(
    (t) =>
      t.from.includes(spec.initialState) &&
      gates.has(t.to) &&
      (t.opens ?? []).some((g) => g.class === "human-verdict"),
  )?.name;
}

function loopKeyOf(o: GraphObject): string | undefined {
  return str((o.payload as Record<string, unknown> | null)?.loopKey);
}

// ---- update-fields (R0) ----

/**
 * Write plain fields onto the object a task TRACKS - how `published` becomes true
 * on a doc that has no state machine (decision 8). The task records the decision;
 * this action applies its consequence.
 *
 * `via: "tracks"` is what lets a STATIC spec name an instance-specific target:
 * the executor follows the edge at execution time.
 *
 * A MIRROR IS NEVER WRITTEN. A mirror is an external fact we observe, and putting
 * our verdict in one would record a belief as an observation - the mirror's
 * `merged` comes from the poller seeing GitHub say so, never from us deciding it
 * should. What differs is how loudly we say no:
 *
 *   via: "self"              REFUSAL. The action named this object; a mirror here
 *                            is a real mismatch between the spec and the graph.
 *   via: tracks / produces   CLEAN SKIP. A selector landed somewhere this
 *                            declaration does not apply, which is ordinary - the
 *                            merge-review type tracks a doc in the replayed
 *                            history and a PR mirror in the live flow, and the
 *                            live flow's outward effect is a DIRECTIVE, not a
 *                            field write. Dead-lettering that would put an
 *                            attention item on every real merge approval.
 *
 * Same distinction `external-comment`/`external-merge` draw, deliberately: across
 * the vocabulary, an explicitly-named wrong target is an error and a selector
 * that matches nothing applicable is a no-op.
 */
const updateFields: ActionHandler = async ({ tx, action, now }) => {
  const p = payloadOf(action);
  const set = p.set as Record<string, unknown> | undefined;
  if (!set || !Object.keys(set).length) return { ok: false, retryable: false, detail: "no `set` in payload" };
  if (!action.objectId) return { ok: false, retryable: false, detail: "action carries no object" };

  const via = str(p.via) ?? "self";
  let targetId = action.objectId;
  if (via === "tracks") {
    const edge = (await graph.edgesFrom(tx, action.objectId, "tracks"))[0];
    if (!edge) return { ok: false, retryable: false, detail: `${action.objectId} tracks nothing` };
    targetId = edge.dstId;
  } else if (via !== "self") {
    return { ok: false, retryable: false, detail: `unknown via "${via}"` };
  }

  const target = await graph.getObject(tx, targetId);
  if (!target) return { ok: false, retryable: false, detail: `target ${targetId} is gone` };
  if (target.archetype === "mirror") {
    const why = "a mirror is an observed external fact - our verdict is never written into one";
    return via === "self"
      ? { ok: false, retryable: false, detail: `refusing: ${why}` }
      : { ok: true, detail: `${target.id} is a mirror - nothing written (${why})` };
  }

  await graph.updateObjectFields(
    tx,
    target.id,
    { payload: { ...((target.payload ?? {}) as Record<string, unknown>), ...set } },
    now,
  );
  // A field write leaves no state-change event of its own, so record WHY the
  // content changed. Derived from the action id: one row however often it runs.
  await graph.appendEvent(tx, {
    id: derivedEventId({ action: action.id, kind: "fields-written", target: target.id }),
    teamId: action.teamId,
    objectId: target.id,
    kind: "fields-written",
    origin: "derived",
    payload: { set, note: `fields written by ${action.kind}`, action: action.id },
    entrance: "rule",
    actorId: action.id,
    ts: now,
  });
  return { ok: true, detail: `wrote ${Object.keys(set).join(", ")} on ${target.id}` };
};

// ---- register-watch (R1) ----

/**
 * Open an EXTERNAL-WAIT obligation on the mirror a task is waiting on - design
 * §7's "a Task entering a waiting state registers watch interest on its linked
 * Mirror (declarative action)", and design §12 item 5's rule that waiting for the
 * world to reflect a decision is an obligation and NOT a gate.
 *
 * Payload contract:
 *
 *   via        `self` (default) | `tracks` | `produces` - how to find the mirror,
 *              reusing the SAME resolver `enqueue-review` uses, so "which
 *              instance?" has one answer across the action vocabulary.
 *   select     for `via: "produces"`: `{type?}` filter, so a loop can declare
 *              "the pull requests I open" without naming instances.
 *   wait       the obligation KEY (default `merge-wait`). The condition rides the
 *              key (`merge-wait` ⇒ `merged`, `merge-wait:checks-green` ⇒ that) -
 *              see `sensing/observe.ts` `conditionOf`, which is what lets a sweep
 *              read the binding off the row with no side table.
 *   label      the prose an inbox row would show.
 *
 * ── two deliberate no-ops ───────────────────────────────────────────────────
 *
 * A NON-MIRROR target is a clean success, not a refusal: today's `merge-review`
 * type tracks a pull-request mirror in the live flow and a plain doc in the
 * replayed history, and there is nothing to watch about a doc. Dead-lettering the
 * doc case would turn an inapplicable declaration into an attention item.
 *
 * An ALREADY-SATISFIED condition opens nothing. A wait for something that is
 * already true would never be closed by a sweep (no change ⇒ no observation event
 * to close it with) and would sit open forever looking like a stuck watch. Not
 * opening it is the honest answer, and the detail says so.
 *
 * IDEMPOTENT by identity: `(objectId, key)` is the obligation's primary key, so a
 * re-executed action re-opens nothing and the original `openedByEvent` stands.
 */
const registerWatch: ActionHandler = async (ctx) => {
  const { tx, action, now } = ctx;
  const p = payloadOf(action);
  if (!action.objectId) return { ok: false, retryable: false, detail: "action carries no object" };

  const targets = await resolveReviewTargets(ctx, str(p.via) ?? "self");
  if (!targets.ok) return targets.fail;

  const key = str(p.wait) ?? "merge-wait";
  const condition = conditionOf(key);

  const detail: string[] = [];
  for (const target of targets.objects) {
    if (target.archetype !== "mirror") {
      detail.push(`${target.id} is a ${target.archetype} - nothing external to watch`);
      continue;
    }
    // Already true upstream? Then there is no wait, and inventing one would be a
    // watch nothing can ever close.
    const facts = observedFromPayload(target);
    if (facts && waitSatisfied(condition, facts)) {
      detail.push(`${target.id} already satisfies "${condition}" - no wait opened`);
      continue;
    }
    const { opened } = await graph.openObligation(tx, {
      objectId: target.id,
      key,
      teamId: action.teamId,
      class: "external-wait",
      label: str(p.label) ?? `Waiting for the world to show "${condition}"`,
      // Every obligation is opened BY an event; a mirror cannot run a transition,
      // so the opener is the event whose transition enqueued this action.
      openedByEvent: action.eventId,
      // A passive wait re-surfaces on a bounded schedule so a forgotten watch
      // cannot rot invisibly (decision 3).
      nextReminderAt: new Date(msOf(now) + WAIT_REMINDER_MS).toISOString(),
      now,
    });
    detail.push(opened ? `watching ${target.id} for "${condition}"` : `${target.id} was already watched for "${key}"`);
  }
  return { ok: true, detail: detail.join("; ") || "no watch target matched" };
};

/** How long a passive wait sits before it re-surfaces (decision 3's bounded
 *  schedule). A stamp today - nothing consumes it yet - but writing it is what
 *  makes the reminder a later read rather than a later migration. */
export const WAIT_REMINDER_MS = 24 * 60 * 60 * 1000;

function msOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

// ---- external-comment / external-merge (R3): the outward effects ----

/**
 * Turn an approved OUTWARD action into a work order for a machine agent.
 *
 * This is the handler that changes what R3 means in this codebase. It still does
 * not perform the effect - the server holds no GitHub credentials and executes
 * nothing outward, which is the zero-exec invariant the whole product rests on -
 * but it no longer dead-ends either. It resolves the target, authors the exact
 * bytes to be posted, and writes ONE row in `effect_directives`. An agent running
 * where the credentials live claims it, does the thing, and reports back through
 * the same channel (`graph/effects/channel.ts`).
 *
 * Payload contract:
 *
 *   via        `tracks` (default) | `self` | `produces` - how to find the mirror,
 *              through the SAME resolver `enqueue-review` and `register-watch`
 *              use, so "which instance?" has one answer across the vocabulary.
 *   select     for `via: "produces"`: `{type?}` filter.
 *   requires   `{field, equals}` evaluated against the ACTION'S OWN OBJECT (the
 *              shepherd), NOT the target. This is how a static spec declares an
 *              effect that only some instances want - the merge-review type
 *              declares both a comment and a merge, and the merge stands down
 *              unless that review carries explicit merge intent. A stand-down is
 *              a clean success with the reason in its detail, never a refusal:
 *              an inapplicable declaration is not a stuck consequence.
 *   note       one line of prose for the comment body.
 *   method     merge strategy (`squash` default).
 *   machine    bind the directive to one machine. Omitted ⇒ any agent may claim.
 *
 * ── the two shapes of "this target is not deliverable" ──────────────────────
 *
 * A SELECTOR that lands on something outside GitHub is a clean skip. The
 * merge-review type tracks a PR mirror in the live flow and a plain playbook doc
 * in the replayed history, and there is nothing to comment on about a doc;
 * dead-lettering that would turn "this declaration does not apply here" into an
 * attention item, which is the mistake `register-watch` already refuses to make.
 *
 * `via: "self"` is different: the action NAMED this object, so a non-deliverable
 * target is a real mismatch between the spec and the graph, and it refuses.
 */
const outwardEffect: ActionHandler = async (ctx) => {
  const { tx, action, now } = ctx;
  const p = payloadOf(action);
  const effectKind = effectKindOf(action.kind);
  if (!effectKind) {
    return { ok: false, retryable: false, detail: `"${action.kind}" has no directive shape in this build` };
  }
  if (!action.objectId) return { ok: false, retryable: false, detail: "action carries no object" };
  // The executor already refused an R3 row without a resolvable HUMAN approval.
  // Re-read it here anyway: this is the value that gets WRITTEN onto the work
  // order, and a directive whose approval column was somehow empty would be a
  // work order the agent could not check.
  if (!action.approvalEvent) {
    return { ok: false, retryable: false, detail: "outward action carries no approval event - refusing to build a work order" };
  }

  const holder = await graph.getObject(tx, action.objectId);
  if (!holder) return { ok: false, retryable: false, detail: `object ${action.objectId} is gone` };

  const stand = standDownReason(holder, p.requires);
  if (stand) return { ok: true, detail: stand };

  const via = str(p.via) ?? "tracks";
  const targets = await resolveReviewTargets(ctx, via);
  if (!targets.ok) return targets.fail;
  if (!targets.objects.length) {
    return { ok: true, detail: `no ${effectKind} target matched (via ${via})` };
  }

  const detail: string[] = [];
  for (const target of targets.objects) {
    const resolved = targetOfMirror(target);
    if (!resolved.ok) {
      if (via === "self") return { ok: false, retryable: false, detail: resolved.why };
      detail.push(`${target.id}: ${resolved.why} - nothing to deliver`);
      continue;
    }
    const approvalEvent = await graph.getEvent(tx, action.approvalEvent);
    const body =
      effectKind === "github-comment"
        ? buildCommentBody(action.id, {
            reviewTitle: holder.title,
            transition: approvalEvent?.transition ?? null,
            approvalEvent: action.approvalEvent,
            note: str(p.note) ?? null,
          })
        : undefined;

    const { created } = await graph.insertDirective(tx, {
      // IDEMPOTENCY: the action id IS the primary key, and (for a comment) the
      // marker embedded in the body - so one work order and one comment, however
      // many times the at-least-once boundary fires.
      id: action.id,
      teamId: action.teamId,
      actionId: action.id,
      eventId: action.eventId,
      objectId: target.id,
      kind: effectKind,
      targetSource: resolved.target.source,
      targetExternalId: resolved.target.externalId,
      targetMachine: str(p.machine) ?? null,
      payload: {
        repo: resolved.target.repo,
        number: resolved.target.number,
        ...(body !== undefined ? { body, marker: directiveMarker(action.id) } : {}),
        ...(effectKind === "github-merge" ? { method: mergeMethodOf(p.method) } : {}),
      },
      approvalEvent: action.approvalEvent,
      state: "pending",
      attempts: 0,
      createdAt: now,
    });
    detail.push(
      created
        ? `${effectKind} directive queued for ${resolved.target.externalId}`
        : `${effectKind} directive already queued for ${resolved.target.externalId} (replay)`,
    );
  }
  return { ok: true, detail: detail.join("; ") };
};

/**
 * Should this instance stand down? `requires: {field, equals}` is checked against
 * the shepherd's own payload, so one static spec can declare "comment always,
 * merge only when this review was opened with merge intent". A missing `requires`
 * means the effect always applies.
 */
function standDownReason(holder: GraphObject, requires: unknown): string | undefined {
  if (requires == null) return undefined;
  const r = requires as { field?: unknown; equals?: unknown };
  const field = str(r.field);
  if (!field) return undefined;
  const actual = ((holder.payload ?? {}) as Record<string, unknown>)[field];
  const want = r.equals ?? true;
  if (JSON.stringify(actual ?? null) === JSON.stringify(want ?? null)) return undefined;
  return `${holder.id} does not declare ${field} = ${JSON.stringify(want)} - standing down, no outward effect`;
}

// ---- the registry ----

/**
 * Kind → handler. PARTIAL ON PURPOSE: every kind absent from this map
 * dead-letters with `NO_HANDLER`, which is how an unimplemented consequence stays
 * visible. Outward (R3) and governance (R4) kinds are absent by design.
 */
const HANDLERS: Partial<Record<ActionKind, ActionHandler>> = {
  notify,
  "enqueue-review": enqueueReview,
  "update-fields": updateFields,
  "register-watch": registerWatch,
  // R3. These do not perform their effect either - they write a work order for a
  // machine agent (see `outwardEffect`). Governance (R4) kinds remain absent.
  "external-comment": outwardEffect,
  "external-merge": outwardEffect,
};

export function handlerFor(kind: string): ActionHandler | undefined {
  return HANDLERS[kind as ActionKind];
}

/** Which kinds this build can actually execute - used by the executor's own log
 *  line and by the tests, so "what is implemented" has one answer. */
export function handledKinds(): ActionKind[] {
  return Object.keys(HANDLERS) as ActionKind[];
}

/**
 * TEST SEAM: register an extra handler for one kind. Exists so a probe can build
 * a genuine transition→action→transition chain (the chain-depth bomb) out of the
 * real executor rather than a mock of it. Returns a restore function; production
 * code never calls this.
 */
export function registerHandler(kind: ActionKind, handler: ActionHandler): () => void {
  const previous = HANDLERS[kind];
  HANDLERS[kind] = handler;
  logger.debug({ kind }, "outbox: handler overridden (test seam)");
  return () => {
    if (previous) HANDLERS[kind] = previous;
    else delete HANDLERS[kind];
  };
}

export const _internals = {
  notify,
  enqueueReview,
  updateFields,
  registerWatch,
  outwardEffect,
  describeObject,
  standDownReason,
};
