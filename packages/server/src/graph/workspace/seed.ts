/**
 * Graph Engineering v1 workspace demo - the SEEDER.
 *
 * Everything this writes goes through the real primitives. There is no direct
 * INSERT of a status, no hand-written event row, and no fixture table:
 *
 *   - loop / review / artifact objects       → `graphStore.createObject`
 *   - GitHub pull requests                    → `graphStore.getOrCreateMirror`
 *     (an UPSERT on the deterministic mirror id - re-seeding converges on ONE row)
 *   - relations + `produces` / `tracks` links → `graphStore.upsertEdge`
 *   - the custom types                        → `proposeTypeVersion` + `armTypeVersion`
 *     (arming is the only promotion; a proposal is invisible to a guard)
 *   - EVERY status in the demo                → `applyTransition`
 *
 * That last one is the point. Because the history script replays through the
 * transition seam, the seeded past carries what a hand-written fixture never
 * could: per-field `{old,new}` diffs, `entrance`/`actorId` provenance on every
 * event, gate obligations opened and closed BY events, and outbox rows written
 * in the same transaction as the status they belong to.
 *
 * The seeder also plays MINIMAL EXECUTOR: after each step it stamps the
 * transition's outbox actions done (`markActionDone`), because a
 * terminal transition is refused while actions are still pending (design §12
 * item 8). Steps flagged `keepPending` are left undrained on purpose, so the
 * demo has a real backlog of undelivered actions to show.
 *
 * Re-runnable: `seedGraphDemo` deletes the demo team's rows first. It is scoped
 * to `DEMO_TEAM_ID` and touches nothing else in the database.
 */
import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import {
  edges as edgesTable,
  effectDirectives as effectDirectivesTable,
  events as eventsTable,
  gateObligations as gateObligationsTable,
  graphNotifications as graphNotificationsTable,
  objects as objectsTable,
  outboxActions as outboxActionsTable,
  typeRegistry as typeRegistryTable,
} from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import { applyTransition, type ApplyTransitionResult } from "../applyTransition.js";
import { ARTIFACTS, HISTORY, LOOPS, PULL_REQUESTS, RELATIONS } from "./fleet.js";
import { DEMO_TEAM_ID, DEMO_TYPES, REVIEW_PRESETS, REVIEW_TYPE } from "./specs.js";
import { parseArtifact } from "@loopany/artifact-format";

/** Instant the demo's registry rows and objects are stamped as created. */
const SEED_AT = "2026-07-01T09:00:00+08:00";

/** The reviewing TASK that hangs off a pull request or a doc, keyed `<key>#review`.
 *  Content and mirrors never carry a verdict themselves (decision 8). */
const reviewKey = (key: string) => `${key}#review`;

/**
 * Review flow → the PRESET the review task carries.
 *
 * Was a map to three shepherd TYPES. Since the collapse (captain decision 16)
 * there is one `review` type and the flow is instance data, so this maps to a
 * preset name and the state machine is the same for all of them.
 */
const PRESET_OF_FLOW = {
  publish: "publish",
  decision: "decision",
  ship: "publish",
} as const;

export interface SeedResult {
  teamId: string;
  objects: number;
  edges: number;
  events: number;
  openObligations: number;
  pendingActions: number;
  /** Steps the state machine refused. Non-empty means the history script and the
   *  type specs disagree - a seed bug, surfaced instead of swallowed. */
  refusals: string[];
}

/** Drop every row this demo owns. Scoped to the demo team id, so a real
 *  workspace sharing the database is untouched. */
export async function resetGraphDemo(teamId = DEMO_TEAM_ID): Promise<void> {
  // Notifications FIRST: they are an outbox action's effect, keyed by the action
  // id, so leaving them behind would strand rows pointing at actions and events
  // this reset is about to delete - and the workspace would show a notification
  // for a decision that no longer exists in its own history.
  await db.delete(graphNotificationsTable).where(eq(graphNotificationsTable.teamId, teamId));
  // Effect directives are an outbox action's effect too - keyed by the action id
  // for exactly the same reason, so they strand for exactly the same reason.
  await db.delete(effectDirectivesTable).where(eq(effectDirectivesTable.teamId, teamId));
  await db.delete(outboxActionsTable).where(eq(outboxActionsTable.teamId, teamId));
  await db.delete(gateObligationsTable).where(eq(gateObligationsTable.teamId, teamId));
  await db.delete(eventsTable).where(eq(eventsTable.teamId, teamId));
  await db.delete(edgesTable).where(eq(edgesTable.teamId, teamId));
  await db.delete(objectsTable).where(eq(objectsTable.teamId, teamId));
  await db.delete(typeRegistryTable).where(eq(typeRegistryTable.teamId, teamId));
}

/**
 * Seed the demo workspace. Returns a tally so the CLI (and the test) can assert
 * the seed actually landed rather than reporting success on an empty write.
 */
export async function seedGraphDemo(options: { teamId?: string; reset?: boolean } = {}): Promise<SeedResult> {
  const teamId = options.teamId ?? DEMO_TEAM_ID;
  if (options.reset !== false) await resetGraphDemo(teamId);

  // ---- 1. the registry: archetype base types, then the demo's own types ----
  //
  // Every status resolution in the engine goes through `getEffectiveType`, so
  // even a plain Task's state machine has to be armed here - decision 4 has no
  // exception for archetypes.
  await graph.seedBuiltinTypes(undefined, teamId, SEED_AT);
  for (const t of DEMO_TYPES) {
    await graph.proposeTypeVersion(undefined, {
      teamId,
      name: t.name,
      archetype: t.archetype,
      version: 1,
      spec: t.spec,
      rationale: t.rationale,
      now: SEED_AT,
    });
    await graph.armTypeVersion(undefined, { teamId, name: t.name, version: 1, now: SEED_AT });
  }

  /** Seed key → object id, for the history script and the edge writer. */
  const ids = new Map<string, string>();

  // ---- 2. loop classes (a Task with `cron` set IS a Loop, design §4) ----
  for (const loop of LOOPS) {
    const row = await graph.createObject(undefined, {
      teamId,
      archetype: "task",
      type: "loop",
      status: "planned", // LOOP_SPEC.initialState - `activate` moves it below
      title: loop.name,
      cron: loop.cron,
      timezone: loop.cron ? "Asia/Shanghai" : null,
      payload: {
        band: loop.band,
        kind: loop.kind,
        cadence: loop.cadence,
        stat: loop.stat,
        rank: loop.rank,
        ...(loop.yOffset ? { yOffset: loop.yOffset } : {}),
        runs: 0,
      },
      now: loop.createdAt,
    });
    ids.set(loop.key, row.id);
  }

  // ---- 3. artifacts: real v1 artifact files, parsed at ingress ----
  //
  // The FILE is the source of truth. Parsing it here means the demo cannot
  // drift from the format: a malformed front matter block fails the seed.
  for (const artifact of ARTIFACTS) {
    const doc = parseArtifact(artifact.file);
    const declared = doc.frontMatter.type;
    if (declared !== artifact.type) {
      throw new Error(`artifact ${artifact.key}: front matter type "${declared}" != seed type "${artifact.type}"`);
    }
    const when = stringField(doc.frontMatter.createdAt) ?? SEED_AT;
    const row = await graph.createObject(undefined, {
      teamId,
      archetype: "doc",
      // Content has ONE nominal state and no transitions (decision 8).
      type: artifact.type,
      status: "current",
      title: typeof doc.frontMatter.title === "string" ? doc.frontMatter.title : artifact.key,
      payload: {
        // The bytes, kept verbatim: rendering is a projection, never storage.
        source: artifact.file,
        frontMatter: doc.frontMatter,
        loopKey: artifact.loop,
        // `published` is a FIELD. Content awaiting a verdict is not published
        // yet; content with no review flow is simply live.
        published: !artifact.review,
        version: 1,
      },
      now: when,
    });
    ids.set(artifact.key, row.id);
    await graph.upsertEdge(undefined, {
      teamId,
      kind: "produces",
      srcId: ids.get(artifact.loop)!,
      dstId: row.id,
      now: when,
    });

    if (!artifact.review) continue;
    // The verdict lives on a shepherd TASK that tracks the content.
    const shepherd = await graph.createObject(undefined, {
      teamId,
      archetype: "task",
      type: REVIEW_TYPE,
      status: "queued",
      title: row.title,
      payload: {
        loopKey: artifact.loop,
        reviews: row.id,
        subject: row.id,
        preset: PRESET_OF_FLOW[artifact.review],
        ...REVIEW_PRESETS[PRESET_OF_FLOW[artifact.review]]!.payload,
      },
      now: when,
    });
    ids.set(reviewKey(artifact.key), shepherd.id);
    await graph.upsertEdge(undefined, { teamId, kind: "tracks", srcId: shepherd.id, dstId: row.id, now: when });
    await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: ids.get(artifact.loop)!, dstId: shepherd.id, now: when });
  }

  // ---- 4. pull requests: an external MIRROR + the merge review we own ----
  for (const pr of PULL_REQUESTS) {
    const externalId = `${pr.repo}/pull/${pr.number}`;
    const { object: mirror } = await graph.getOrCreateMirror(undefined, {
      teamId,
      externalSource: "github",
      externalId,
      type: "pull-request",
      status: pr.observedStatus,
      title: `PR #${pr.number} · ${pr.title}`,
      payload: {
        repo: pr.repo,
        number: pr.number,
        sourceUrl: `https://github.com/${pr.repo}/pull/${pr.number}`,
      },
      now: pr.observedAt,
    });
    ids.set(pr.key, mirror.id);

    const review = await graph.createObject(undefined, {
      teamId,
      archetype: "task",
      type: REVIEW_TYPE,
      status: "queued", // REVIEW_SPEC.initialState
      title: mirror.title,
      payload: {
        repo: pr.repo,
        number: pr.number,
        loopKey: pr.loop,
        subject: mirror.id,
        preset: "merge",
        ...REVIEW_PRESETS.merge!.payload,
      },
      now: pr.observedAt,
    });
    ids.set(reviewKey(pr.key), review.id);

    // The review TRACKS the external fact; the loop PRODUCES the review.
    await graph.upsertEdge(undefined, { teamId, kind: "tracks", srcId: review.id, dstId: mirror.id, now: pr.observedAt });
    await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: ids.get(pr.loop)!, dstId: review.id, now: pr.observedAt });
  }

  // ---- 5. typed relations between loop classes ----
  for (const rel of RELATIONS) {
    const srcId = ids.get(rel.from);
    const dstId = ids.get(rel.to);
    if (!srcId || !dstId) throw new Error(`relation ${rel.from} -> ${rel.to}: unknown loop key`);
    await graph.upsertEdge(undefined, { teamId, kind: rel.kind, srcId, dstId, meta: { label: rel.label }, now: SEED_AT });
  }

  // ---- 6. arm every non-planned loop, then replay the history ----

  const refusals: string[] = [];

  /**
   * Loop key → the HUMAN event that armed it (its `activate`).
   *
   * A loop's `fire` declares an outward dispatch (R3), so every replayed fire needs
   * the standing human approval the live scheduler also uses - the arming act. The
   * seeded history's arming act is the captain's `activate`, so that is the event
   * the replay names. Nothing outward actually happens: the seed's minimal executor
   * stamps the action done without running the handler, exactly as it does for every
   * other action in the replay.
   */
  const armEvents = new Map<string, string>();

  /** Run one transition and drain (or deliberately keep) its outbox actions. */
  const step = async (input: {
    key: string;
    transition: string;
    entrance: "human" | "agent-run" | "rule" | "clock";
    actorId: string;
    at: string;
    note?: string;
    fields?: Record<string, unknown>;
    keepPending?: boolean;
  }): Promise<ApplyTransitionResult | undefined> => {
    const objectId = ids.get(input.key);
    if (!objectId) throw new Error(`history step for unknown object key "${input.key}"`);
    const approval = armEvents.get(input.key);
    const result = await applyTransition({
      objectId,
      transition: input.transition,
      actor: { entrance: input.entrance, actorId: input.actorId },
      now: input.at,
      ...(input.fields ? { fields: input.fields } : {}),
      ...(input.note ? { eventPayload: { note: input.note } } : {}),
      // The standing approval for whatever outward action this transition declares.
      // Harmless on a transition that declares none - an unused approval index is
      // never consulted, and the whole point is that a clock cannot self-approve.
      ...(approval ? { approvals: { 0: approval } } : {}),
    });
    if (!result.ok) {
      refusals.push(`${input.key}.${input.transition} @ ${input.at}: ${result.code} - ${result.message}`);
      return result;
    }
    if (input.keepPending) return result;
    // Minimal executor: an action a real executor would have delivered. Without
    // this a later terminal transition is (correctly) refused for pending actions.
    for (const action of result.actions) await graph.markActionDone(undefined, action.id, input.at);
    return result;
  };

  for (const loop of LOOPS) {
    if (loop.planned) continue;
    const armed = await step({
      key: loop.key,
      transition: "activate",
      entrance: "human",
      actorId: "u-demo-captain",
      at: loop.createdAt,
      note: `armed ${loop.name}`,
    });
    // The cadence stays CONFIGURATION here: `objects.cron` is set, `next_fire` is
    // NOT. This workspace replays production loops, and importing a cadence must
    // never be the same act as agreeing to run it on this server - arming is a
    // deliberate step (`pnpm graph:schedule`). What the activate event DOES supply
    // is the standing approval a replayed (or later armed) fire rests on.
    if (armed?.ok) armEvents.set(loop.key, armed.event.id);
  }

  for (const h of HISTORY) {
    await step({
      key: h.object,
      transition: h.transition,
      entrance: h.entrance,
      actorId: h.actorId,
      at: h.at,
      ...(h.note ? { note: h.note } : {}),
      ...(h.fields ? { fields: h.fields } : {}),
      ...(h.keepPending ? { keepPending: true } : {}),
    });
  }

  // ---- 7. tally ----
  const allObjects = await graph.listObjects(undefined, teamId);
  const allEdges = await db.select().from(edgesTable).where(eq(edgesTable.teamId, teamId));
  const open = await graph.listOpenObligations(undefined, teamId);
  const pending = await graph.listPendingActions(undefined, { teamId });
  return {
    teamId,
    objects: allObjects.length,
    edges: allEdges.length,
    events: await graph.countEvents(undefined, teamId),
    openObligations: open.length,
    pendingActions: pending.length,
    refusals,
  };
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
