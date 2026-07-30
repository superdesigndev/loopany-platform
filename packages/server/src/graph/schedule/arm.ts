/**
 * Graph Engineering v1 - ARMING A SCHEDULE: the one way a cadence becomes live.
 *
 * A cadence on its own is CONFIGURATION (`objects.cron` / `objects.interval_ms`).
 * Arming is what gives it a CURSOR (`objects.next_fire`), and the cursor is the
 * whole of the scheduler's claim predicate - so nothing fires until somebody arms
 * it. That split is deliberate and it is a safety property, not tidiness: this
 * workspace replays real production loops, cadences and all, and importing a
 * cadence must never be the same act as agreeing to run it here.
 *
 * ── arming is a HUMAN act, and that is what authorizes the fires ─────────────
 *
 * A scheduled run dispatches work to a machine - an outward (R3) effect, which
 * captain decision 2 makes structurally non-auto-approvable: it must rest on a
 * human approval EVENT. A fire cannot ask a person, because not asking is the entire
 * point of a schedule. So the approval is the ARMING act: this module writes a
 * `schedule-armed` event with `entrance: "human"` and the arming user as its actor,
 * stamps its id on the object, and the scheduler hands that id to
 * `applyTransition` as the approval for every R3 action the fire declares.
 *
 * Nothing is relaxed by this. The event must EXIST and must be human-entered, and
 * that is re-checked twice downstream where it counts: the outbox executor
 * re-resolves the id and refuses a non-human approval before any work order is
 * written (`outbox/executor.ts safetyRefusal`), and the machine agent re-checks the
 * approval block a third time before it executes. What a clock still cannot do is
 * approve its own outward effect - it can only point at a person who already did.
 *
 * ── the fire transition is chosen HERE, not guessed at fire time ─────────────
 *
 * Which transition the clock enters is part of the schedule (see `fireTransitionOf`
 * in `scheduler.ts`): resolved from the effective type spec, or named explicitly.
 * It is validated at ARM time, so an unfireable schedule is refused by the person
 * arming it rather than discovered as a silent no-op at 03:00.
 *
 * `now` is passed in. This module reads no clock.
 */
import { logger } from "../../logger.js";
import { db } from "../../db/index.js";
import type { GraphObject } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import type { GraphExec } from "../../db/graphStore.js";
import { organicEventId } from "../ids.js";
import { cadenceOf, describeCadence, hasCadence, nextFireAfter, type CadenceSpec } from "./cadence.js";
import { fireTransitionOf, SCHEDULE_ARMED_EVENT, SCHEDULE_DISARMED_EVENT } from "./scheduler.js";

export interface ArmScheduleInput {
  objectId: string;
  /** The cadence to arm. Omit to re-arm the cadence the object already carries. */
  cadence?: CadenceSpec;
  /** The transition the clock should enter. Omit to resolve it from the effective
   *  type spec (the unique clock-enterable transition that MOVES the object). */
  fireTransition?: string;
  /** The person arming it. Their event is the standing approval - so this is a user
   *  id, never a rule or a run. */
  userId: string;
  /** ISO. Passed in; this module reads no clock. */
  now: string;
  /** Instance fields the fire's work order needs (`brief`, `workdir`, `repos`).
   *  Merged into the object's payload, because a static type spec cannot know them. */
  fields?: Record<string, unknown>;
}

export type ArmScheduleResult =
  | { ok: true; object: GraphObject; eventId: string; nextFire: string; fireTransition: string; cadence: string }
  | { ok: false; code: ArmError; message: string };

export type ArmError = "UNKNOWN_OBJECT" | "NOT_SCHEDULABLE" | "NO_CADENCE" | "NO_FIRE_TRANSITION" | "NEVER_FIRES";

/**
 * Arm a cadence: record the human authorization, write the cadence, compute the
 * first cursor.
 *
 * One transaction, so an object never carries a cursor whose approving event is not
 * in the log - which is exactly the state where a fire would dispatch outward work
 * resting on an approval nobody can resolve.
 */
export async function armSchedule(input: ArmScheduleInput): Promise<ArmScheduleResult> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as GraphExec;
    const object = await graph.getObjectForUpdate(tx, input.objectId);
    if (!object) return refuse("UNKNOWN_OBJECT", `no object ${input.objectId}`);
    // A mirror's state is the world's; scheduling one would mean firing a cadence
    // at a fact we only observe. The schema refuses it too - this is the readable
    // half of the same rule.
    if (object.archetype === "mirror") {
      return refuse("NOT_SCHEDULABLE", `${object.id} is a mirror - an observed fact carries no cadence`);
    }

    const cadence = input.cadence ?? cadenceOf(object);
    if (!hasCadence(cadence)) {
      return refuse("NO_CADENCE", `${object.id} carries no cadence and none was supplied`);
    }

    const spec = (await graph.getEffectiveType(tx, object.teamId, object.type))?.spec;
    const resolved = fireTransitionOf(spec, object, input.fireTransition);
    if (!resolved.ok) return refuse("NO_FIRE_TRANSITION", resolved.why);

    const nextFire = nextFireAfter(cadence, input.now, object.id);
    if (!nextFire) return refuse("NEVER_FIRES", `${describeCadence(cadence)} has no future occurrence`);

    // The STANDING APPROVAL. Organic (a person arming a cadence twice is two real
    // acts, a week apart or a second apart) and `entrance: "human"`, which is the
    // property every downstream re-check reads.
    const eventId = organicEventId(msOf(input.now));
    await graph.appendEvent(tx, {
      id: eventId,
      teamId: object.teamId,
      objectId: object.id,
      kind: SCHEDULE_ARMED_EVENT,
      origin: "organic",
      payload: {
        cadence: describeCadence(cadence),
        ...(cadence.cron ? { cron: cadence.cron } : {}),
        ...(cadence.intervalMs ? { intervalMs: cadence.intervalMs } : {}),
        ...(cadence.timezone ? { timezone: cadence.timezone } : {}),
        fireTransition: resolved.transition,
        nextFire,
        note: `armed ${describeCadence(cadence)} — next fire ${nextFire}`,
      },
      entrance: "human",
      actorId: input.userId,
      ts: input.now,
    });

    const updated = await graph.updateObjectFields(
      tx,
      object.id,
      {
        cron: cadence.cron ?? null,
        intervalMs: cadence.intervalMs ?? null,
        timezone: cadence.timezone ?? object.timezone ?? null,
        nextFire,
        scheduleArmedByEvent: eventId,
        payload: {
          ...((object.payload ?? {}) as Record<string, unknown>),
          ...(input.fields ?? {}),
          // The chosen transition rides the payload as well as the arming event, so
          // the scheduler resolves it from DATA rather than re-inferring it from a
          // spec that may have grown a second clock transition since.
          fireTransition: resolved.transition,
        },
      },
      input.now,
    );

    logger.info(
      { object: object.id, cadence: describeCadence(cadence), nextFire, transition: resolved.transition },
      "schedule: armed",
    );
    return {
      ok: true as const,
      object: updated ?? object,
      eventId,
      nextFire,
      fireTransition: resolved.transition,
      cadence: describeCadence(cadence),
    };
  });
}

/**
 * DISARM: drop the cursor, keep the cadence.
 *
 * The cadence stays because it is configuration and a person may want it back; the
 * CURSOR goes, because that is what makes the object due. The arming event pointer
 * is cleared too - a standing approval must not outlive the schedule it authorized,
 * or a later re-arm would silently inherit an approval given for something else.
 */
export async function disarmSchedule(input: {
  objectId: string;
  userId: string;
  now: string;
}): Promise<{ ok: true; object: GraphObject; eventId: string } | { ok: false; code: "UNKNOWN_OBJECT"; message: string }> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as GraphExec;
    const object = await graph.getObjectForUpdate(tx, input.objectId);
    if (!object) return { ok: false as const, code: "UNKNOWN_OBJECT" as const, message: `no object ${input.objectId}` };
    const eventId = organicEventId(msOf(input.now));
    await graph.appendEvent(tx, {
      id: eventId,
      teamId: object.teamId,
      objectId: object.id,
      kind: SCHEDULE_DISARMED_EVENT,
      origin: "organic",
      payload: { note: "schedule disarmed — the cadence stays, the clock stops" },
      entrance: "human",
      actorId: input.userId,
      ts: input.now,
    });
    const updated = await graph.updateObjectFields(
      tx,
      object.id,
      { nextFire: null, scheduleArmedByEvent: null },
      input.now,
    );
    logger.info({ object: object.id }, "schedule: disarmed");
    return { ok: true as const, object: updated ?? object, eventId };
  });
}

function refuse(code: ArmError, message: string): { ok: false; code: ArmError; message: string } {
  logger.warn({ code }, `schedule: arm refused - ${message}`);
  return { ok: false, code, message };
}

function msOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}
