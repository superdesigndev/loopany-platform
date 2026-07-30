/**
 * Graph Engineering v1 - THE CLOCK SHADOW: "time arrived" as a first-class entrance.
 *
 * The fourth entrance class has existed in the kernel since the schema unit
 * (`ENTRANCE_CLASSES` = human | agent-run | rule | clock) with nothing behind it.
 * This module is what stands behind it: an in-process loop, exactly like the outbox
 * executor, that turns a due cursor into a real clock-entrance transition and lets
 * the existing machinery carry it the rest of the way.
 *
 * ── what it does, and the much longer list of what it does NOT ───────────────
 *
 * It writes GRAPH FACTS and nothing else. For each due object it enters the
 * object's configured fire transition through `applyTransition` with
 * `entrance: "clock"` and the SCHEDULE as the actor, and then advances the cursor.
 * That transition's declared actions land in the outbox in the same transaction,
 * the executor turns an approved dispatch into an effect DIRECTIVE, a machine agent
 * claims it and runs the work, and `graph/agent/runs.ts` reports back and advances
 * the object. Every one of those layers already existed; the clock is a new
 * entrance, not a new pipeline (decisions 10 and 12 - the server computes and
 * stores, machines act).
 *
 * So: no fetch, no spawn, no external call, no second dispatch channel. If this
 * module ever needs one of those, something has been modelled in the wrong place.
 *
 * ── the four properties this is built around ────────────────────────────────
 *
 * LEVEL-TRIGGERED CATCH-UP. A fire's cursor is advanced to the next occurrence
 * after NOW, never to the one after the instant we just fired. Three intervals of
 * downtime therefore produce ONE catch-up fire: being overdue is a level, not a
 * count of edges. There is deliberately no code path that can emit a burst of
 * back-fires, because there is no loop over missed occurrences anywhere.
 *
 * IDEMPOTENT FIRING. The fire's event id is DERIVED from `(object, transition,
 * scheduled instant)` - so the action ids, and therefore the directive id, are a
 * pure function of the same triple (`<eventId>-<seq>`). A crash after the fire
 * commits but before the cursor advances is the ordinary at-least-once case the
 * outbox already lives with: the retry re-derives the SAME event id, the replay
 * latch in `applyTransition` returns without applying anything, no second action is
 * enqueued, and the cursor advance then happens. One dispatch, not twins - by
 * identity, never by a "have I fired this before?" lookup.
 *
 * THE CURSOR ADVANCE IS A SEPARATE TRANSACTION, on purpose. Folding it into the
 * fire would make the pair atomic and the retry path above dead code that nobody
 * ever exercises. Committing the fire first is also the right order for the one
 * failure that matters: a crash in the window re-fires (harmless, by identity),
 * whereas advancing first would LOSE the fire.
 *
 * A REFUSED FIRE STILL ADVANCES. A cadence that lands while the previous run is
 * still going is ordinary, not an incident - but a scheduler that left the cursor in
 * the past would re-refuse it every tick forever. So a refusal advances the cursor
 * and records a `clock-skipped` event (derived, one row per missed instant) so the
 * miss is visible in the Timeline instead of living only in a log line.
 *
 * `now` is passed in; the background loop is the only thing here that reads a clock.
 */
import { logger } from "../../logger.js";
import { db } from "../../db/index.js";
import type { GraphObject } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import type { GraphExec } from "../../db/graphStore.js";
import { applyTransitionIn } from "../applyTransition.js";
import { derivedEventId } from "../ids.js";
import { consequenceOf, isActionKind, type TypeSpec } from "../types.js";
import { cadenceOf, describeCadence, nextFireAfter } from "./cadence.js";

/** The event a human arming a cadence writes - the standing approval every fire's
 *  outward action rests on (`schedule/arm.ts`). */
export const SCHEDULE_ARMED_EVENT = "schedule-armed";

/** The event a human disarming a cadence writes. */
export const SCHEDULE_DISARMED_EVENT = "schedule-disarmed";

/** The event a MISSED fire writes: the clock came round and the object could not
 *  take the transition (still running, paused, no longer legal). Its own kind
 *  rather than a silent log line, because "why did nothing happen at 07:00?" must
 *  be answerable from the Timeline. */
export const CLOCK_SKIPPED_EVENT = "clock-skipped";

/** Objects examined per pass. Small, like the outbox batch: a pass is one
 *  transaction per object, and a long pass is a long window to recover from. */
export const DEFAULT_BATCH_SIZE = 25;

/** Background loop cadence. Faster than any legal cadence (`MIN_INTERVAL_MS`), so
 *  the tick is never the thing that makes a schedule late. */
export const TICK_MS = 5_000;

/**
 * A SCHEDULE'S OWN ID - what a clock event names as its actor.
 *
 * Design §12's provenance contract says the actor for a `clock` entrance is a
 * schedule id, and a schedule belongs to exactly one object, so the object id IS
 * its identity. Prefixed rather than hashed for the same reason a run id is: a
 * person reading `sched-obj-…` in the Timeline can see which cadence fired without
 * a lookup.
 */
export function scheduleActorId(objectId: string): string {
  return `sched-${objectId}`;
}

/** The reverse, for a provenance query. Undefined for anything that is not one. */
export function objectIdOfSchedule(actorId: string): string | undefined {
  return actorId.startsWith("sched-") && actorId.length > 6 ? actorId.slice(6) : undefined;
}

// ---- resolving what a fire actually does ----

export type FireTransitionResolution = { ok: true; transition: string } | { ok: false; why: string };

/**
 * WHICH transition the clock enters.
 *
 * Preference order, and each step is a decision:
 *
 *   1. the EXPLICIT name (an arm request, or the `fireTransition` the arm stamped
 *      into the object's payload). Data wins over inference: a spec that grows a
 *      second clock transition must not silently re-point a live schedule.
 *   2. otherwise the UNIQUE clock-enterable transition that MOVES the object. A
 *      self-transition (`skip`, `evolve`) is excluded because those exist to record
 *      that something did NOT happen, and a scheduler whose fire was a no-op state
 *      change would be a cadence that logs and never works.
 *
 * Ambiguity is REFUSED rather than resolved by ordering - "the first clock
 * transition in the list" is exactly the kind of rule that turns a spec edit into a
 * behaviour change nobody reviewed. Refused at ARM time, so a person hears about it.
 */
export function fireTransitionOf(
  spec: TypeSpec | undefined,
  object: Pick<GraphObject, "payload" | "status" | "type">,
  explicit?: string,
): FireTransitionResolution {
  if (!spec) return { ok: false, why: `type "${object.type}" has no effective registry version` };
  const named = explicit ?? stringField((object.payload ?? {}) as Record<string, unknown>, "fireTransition");
  if (named) {
    const found = spec.transitions.find((t) => t.name === named);
    if (!found) return { ok: false, why: `"${named}" is not a transition of ${object.type}` };
    if (!clockMayEnter(found.entrance)) {
      return { ok: false, why: `${object.type}.${named} does not admit the clock entrance` };
    }
    return { ok: true, transition: named };
  }

  const candidates = spec.transitions.filter((t) => clockMayEnter(t.entrance) && !t.from.includes(t.to));
  if (!candidates.length) {
    return { ok: false, why: `${object.type} declares no clock-enterable transition that moves the object` };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      why:
        `${object.type} declares ${candidates.length} clock-enterable transitions ` +
        `(${candidates.map((t) => t.name).join(", ")}) - name the one this schedule fires`,
    };
  }
  return { ok: true, transition: candidates[0]!.name };
}

/** A transition with no `entrance` restriction admits every entrance, including
 *  the clock - which is why a plain builtin Task is schedulable with no spec edit. */
function clockMayEnter(entrance: unknown): boolean {
  if (entrance === undefined || entrance === null) return true;
  if (typeof entrance === "string") return entrance === "clock";
  return Array.isArray(entrance) && entrance.includes("clock");
}

/** Which of a transition's declared actions need an approval event (R3/R4). */
function approvalIndices(spec: TypeSpec, transition: string): number[] {
  const declared = spec.transitions.find((t) => t.name === transition)?.actions ?? [];
  const out: number[] = [];
  for (let i = 0; i < declared.length; i++) {
    const kind = declared[i]!.kind;
    if (!isActionKind(kind)) continue;
    const cls = consequenceOf(kind);
    if (cls === "R3" || cls === "R4") out.push(i);
  }
  return out;
}

// ---- one pass ----

export interface FireOutcome {
  objectId: string;
  title: string | null;
  /** The instant the cursor said it was due - the fire's identity seed. */
  dueAt: string;
  transition: string;
  state: "fired" | "replayed" | "skipped" | "unfireable";
  /** The cursor after the pass. Null ⇒ the cadence has no future occurrence. */
  nextFire: string | null;
  /** Actions the fire enqueued (a replay enqueues none - they already exist). */
  actions: number;
  detail: string;
}

export interface SchedulerPass {
  due: number;
  fired: number;
  replayed: number;
  skipped: number;
  outcomes: FireOutcome[];
}

export interface RunOnceInput {
  /** ISO instant. REQUIRED - the scheduler proper never reads a clock. */
  now: string;
  limit?: number;
  /** Scope the pass to one team. Omitted ⇒ every team. */
  teamId?: string;
}

/**
 * Drain ONE batch of due objects. Returns what happened to each, so a probe or a
 * log line can say what the pass did rather than trust that it did something.
 */
export async function runOnce(input: RunOnceInput): Promise<SchedulerPass> {
  const candidates = await graph.dueObjects(undefined, {
    now: input.now,
    limit: input.limit ?? DEFAULT_BATCH_SIZE,
    ...(input.teamId ? { teamId: input.teamId } : {}),
  });

  const pass: SchedulerPass = { due: candidates.length, fired: 0, replayed: 0, skipped: 0, outcomes: [] };
  for (const candidate of candidates) {
    const outcome = await fireOne(candidate, input.now);
    if (!outcome) continue; // claimed by another pass, or no longer due
    pass.outcomes.push(outcome);
    if (outcome.state === "fired") pass.fired++;
    else if (outcome.state === "replayed") pass.replayed++;
    else pass.skipped++;
  }
  if (pass.due) {
    logger.info({ due: pass.due, fired: pass.fired, replayed: pass.replayed, skipped: pass.skipped }, "scheduler: pass");
  }
  return pass;
}

/** What the fire transaction hands to the cursor transaction. `retire` says the
 *  schedule must lose its cursor rather than get a new one; `cadence` is read from
 *  the CLAIMED row, so the advance uses the cadence that was actually fired. */
interface FiredStep {
  objectId: string;
  title: string | null;
  dueAt: string;
  transition: string;
  state: FireOutcome["state"];
  actions: number;
  detail: string;
  retire: boolean;
  cadence: import("./cadence.js").CadenceSpec;
}

/**
 * ONE due object: claim it, fire it, advance it.
 *
 * Two transactions, in this order and for the reason in the module header - the
 * fire must be durable before the debt is cleared, and the window between them is
 * safe because the fire's identity is derived.
 */
async function fireOne(candidate: GraphObject, now: string): Promise<FireOutcome | undefined> {
  const dueAt = candidate.nextFire;
  if (!dueAt) return undefined;

  const fired: FiredStep | undefined = await db.transaction(async (raw) => {
    const tx = raw as unknown as GraphExec;
    // The claim: exact cursor match under SKIP LOCKED. Missing ⇒ a rival pass has
    // it (or already moved it), which is a skip and not a failure.
    const object = await graph.claimDueObject(tx, { objectId: candidate.id, dueAt });
    if (!object) return undefined;

    const spec = (await graph.getEffectiveType(tx, object.teamId, object.type))?.spec;
    const resolved = fireTransitionOf(spec, object);
    if (!resolved.ok || !spec) {
      // An unfireable schedule is a configuration mistake, not a transient one, so
      // the cursor is RETIRED rather than advanced: re-refusing it every tick
      // forever would be a busy loop with no reader.
      await recordSkip(tx, object, dueAt, "UNFIREABLE", resolved.ok ? "no effective type" : resolved.why, now);
      return {
        objectId: object.id,
        title: object.title,
        dueAt,
        transition: "-",
        state: "unfireable",
        actions: 0,
        detail: resolved.ok ? "no effective type version" : resolved.why,
        retire: true,
        cadence: cadenceOf(object),
      };
    }

    // THE STANDING APPROVAL. Every R3/R4 action this fire declares is approved by
    // the HUMAN event that armed the cadence - not by the clock, which has no
    // authority of its own. An unarmed object with outward fire actions therefore
    // gets `APPROVAL_REQUIRED` from the seam and lands as a visible skip, which is
    // the fail-closed answer.
    const needsApproval = approvalIndices(spec, resolved.transition);
    const approvals: Record<number, string> = {};
    if (object.scheduleArmedByEvent) for (const i of needsApproval) approvals[i] = object.scheduleArmedByEvent;

    const result = await applyTransitionIn(tx, {
      objectId: object.id,
      transition: resolved.transition,
      actor: { entrance: "clock", actorId: scheduleActorId(object.id) },
      now,
      // IDENTITY = (object, transition, SCHEDULED INSTANT). Note what is absent:
      // `now`. The fire is identified by the instant it was DUE, so a retry after a
      // crash - which necessarily happens at a different `now` - re-derives the same
      // id and collides instead of dispatching twice.
      derivedFrom: { fire: dueAt },
      ...(Object.keys(approvals).length ? { approvals } : {}),
      eventPayload: {
        note: `the clock came round · ${describeCadence(cadenceOf(object))}`,
        scheduledFor: dueAt,
        cadence: describeCadence(cadenceOf(object)),
        // How late the fire was. This is the catch-up story in the log: a fire 3
        // intervals overdue says so, and says it ONCE.
        lateMs: Math.max(0, Date.parse(now) - Date.parse(dueAt)),
      },
    });

    if (!result.ok) {
      await recordSkip(tx, object, dueAt, result.code, result.message, now);
      return {
        objectId: object.id,
        title: object.title,
        dueAt,
        transition: resolved.transition,
        state: "skipped",
        actions: 0,
        detail: `${result.code} - ${result.message}`,
        retire: false,
        cadence: cadenceOf(object),
      };
    }

    return {
      objectId: object.id,
      title: object.title,
      dueAt,
      transition: resolved.transition,
      state: result.replay ? "replayed" : "fired",
      actions: result.actions.length,
      detail: result.replay
        ? `replay of the fire scheduled for ${dueAt} - nothing re-enqueued`
        : `${resolved.transition} → ${result.object.status}, ${result.actions.length} action(s) enqueued`,
      retire: false,
      cadence: cadenceOf(object),
    };
  });

  if (!fired) return undefined;

  // ---- the cursor, in its own transaction ----
  //
  // LEVEL-TRIGGERED: the next occurrence after NOW, not after `dueAt`. This one
  // argument is the whole of the catch-up semantics.
  const next = fired.retire ? null : (nextFireAfter(fired.cadence, now, candidate.id) ?? null);
  await graph.advanceNextFire(undefined, {
    objectId: fired.objectId,
    from: fired.dueAt,
    to: next,
    // Only a fire that actually ran stamps "last fired". A skipped one advances the
    // cursor (else the scheduler re-refuses it every tick) and leaves the stamp
    // alone, so the column never claims a fire that did not happen - the miss is
    // recorded as its own `clock-skipped` event instead.
    firedAt: fired.state === "fired" || fired.state === "replayed" ? now : null,
    now,
  });

  const outcome: FireOutcome = {
    objectId: fired.objectId,
    title: fired.title,
    dueAt: fired.dueAt,
    transition: fired.transition,
    state: fired.state,
    nextFire: next,
    actions: fired.actions,
    detail: fired.detail,
  };
  if (outcome.state === "fired" || outcome.state === "replayed") {
    logger.info(
      { object: outcome.objectId, transition: outcome.transition, dueAt, next, actions: outcome.actions },
      `scheduler: ${outcome.state}`,
    );
  } else {
    logger.warn({ object: outcome.objectId, dueAt, next, detail: outcome.detail }, "scheduler: fire skipped");
  }
  return outcome;
}

/**
 * Record a MISSED fire.
 *
 * Derived from `(object, dueAt, code)`, so one row per missed instant however many
 * times the pass retries it - the same identity discipline every other re-derivable
 * write in the kernel uses. `entrance: "clock"` with the schedule as actor, because
 * the clock genuinely did come round; what did not happen is the transition.
 */
async function recordSkip(
  tx: GraphExec,
  object: GraphObject,
  dueAt: string,
  code: string,
  reason: string,
  now: string,
): Promise<void> {
  await graph.appendEvent(tx, {
    id: derivedEventId({ clockSkipped: object.id, dueAt, code }),
    teamId: object.teamId,
    objectId: object.id,
    kind: CLOCK_SKIPPED_EVENT,
    origin: "derived",
    payload: {
      scheduledFor: dueAt,
      code,
      reason,
      status: object.status,
      note: `the clock came round and this could not run: ${reason}`,
    },
    entrance: "clock",
    actorId: scheduleActorId(object.id),
    ts: now,
  });
}

// ---- the background loop ----

interface Running {
  stop: () => void;
}

/**
 * ONE scheduler per process, guarded on `globalThis` exactly like the outbox
 * executor and for the same reasons: dev HMR re-imports the module, and two
 * intervals would double the tick rate for no benefit. Correctness does not depend
 * on the guard - the per-object claim does, which is what makes a rolling deploy's
 * two live instances harmless.
 */
const g = globalThis as unknown as { __loopanyGraphScheduler?: Running };

export function startGraphScheduler(options: { signal?: AbortSignal; tickMs?: number } = {}): Running {
  if (g.__loopanyGraphScheduler) return g.__loopanyGraphScheduler;

  let ticking = false;
  const tick = async () => {
    // Skip rather than queue: a pass that outran the cadence would otherwise stack
    // passes contending for the same rows.
    if (ticking) return;
    ticking = true;
    try {
      await runOnce({ now: new Date().toISOString() });
    } catch (err) {
      logger.error({ err: String(err) }, "scheduler: tick failed");
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void tick(), options.tickMs ?? TICK_MS);
  timer.unref?.();
  const running: Running = {
    stop: () => {
      clearInterval(timer);
      if (g.__loopanyGraphScheduler === running) g.__loopanyGraphScheduler = undefined;
    },
  };
  options.signal?.addEventListener("abort", () => running.stop(), { once: true });
  g.__loopanyGraphScheduler = running;
  logger.info({ tickMs: options.tickMs ?? TICK_MS }, "graph scheduler: started");
  // FIRST TICK IMMEDIATELY. A restart must not leave a fire that fell inside the
  // downtime waiting out a whole interval - and because catch-up is level-triggered,
  // that first pass owes exactly one fire per overdue object however long the
  // outage was. This is the boot misfire catch-up, and it needs no special path.
  void tick();
  return running;
}

export function stopGraphScheduler(): void {
  g.__loopanyGraphScheduler?.stop();
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
