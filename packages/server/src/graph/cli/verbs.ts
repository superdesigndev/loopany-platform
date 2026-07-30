/**
 * THE SEVEN VERBS - the single operation surface of the graph (captain decisions
 * 15, 16, 17).
 *
 *   task create      make a piece of work
 *   task move        walk it through its state machine
 *   artifact push    leave a product behind
 *   review request   ask a person for a verdict
 *   mirror track     register an external thing we now care about
 *   wait open        record a standing question and who answers it
 *   wait answer      answer it, either way
 *
 * ── one implementation, three callers ───────────────────────────────────────
 *
 * Decision 16 makes this vocabulary the whole operation surface: the `graph` CLI
 * an agent run drives, the HTTP verb endpoints, and the workspace UI's own
 * buttons all land here. So every function takes an explicit ACTOR
 * (`EventProvenance`) rather than assuming a run, which is what makes the claim
 * real - a task a person created in the browser and a task an agent created from
 * a run produce the same rows with the same shape, and the Timeline tells them
 * apart by provenance rather than by which code path made them.
 *
 * The one thing that is NOT here is the human verdict. A verdict is a `task move`
 * with `entrance: "human"`, and it keeps its own endpoint because the UI's Approve
 * button is the product's most load-bearing control - but it runs the same seam
 * with the same guards, and `taskMove` below would do it identically.
 *
 * ── sequencing lives in the AGENT, not in a declaration ─────────────────────
 *
 * Decision 15's whole point. These verbs are thin: each is a guarded write plus
 * the facts needed to say what to do next. None of them chains into another, none
 * of them decides "and then". A discovery run creates a task, pushes its report
 * and asks for a review because its WORK ORDER told it to, in prose - not because
 * `escalate` declared an `enqueue-review` action.
 *
 * ── domain neutrality (decision 17) ─────────────────────────────────────────
 *
 * Nothing in this module knows what a pull request, a Reddit post or an SEO audit
 * is. `mirror track` registers an external thing by `(source, externalId)`;
 * GitHub PR URLs get a parser because that source is the earned accelerator, and
 * every other source rides the generic path. Domain semantics live in the
 * instance fields these verbs write and in the prose an agent is given.
 *
 * ── idempotency is structural, never a lookup ───────────────────────────────
 *
 * Every verb derives its identity from what it IS: a created object from
 * `(actor, key)`, an artifact from the sha256 of its own bytes, a transition from
 * `(actor, object, transition)`, a wait answer from `(actor, object, key,
 * answer)`. So a retried call collides on a primary key and changes nothing -
 * which is the property that lets a work order say "if in doubt, run it again".
 *
 * `now` is always passed in. Nothing here reads a clock (design §12 item 8).
 */
import { serializeArtifact } from "@loopany/artifact-format";

import type { GateObligation, GraphObject } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import { db } from "../../db/index.js";
import type { GraphExec } from "../../db/graphStore.js";
import { logger } from "../../logger.js";
import { applyTransition, applyTransitionIn, findTransition } from "../applyTransition.js";
import { contentHash, derivedEventId, organicEventId } from "../ids.js";
import { WAIT_REMINDER_MS } from "../outbox/handlers.js";
import { PR_SOURCE, PR_TYPE, mirrorTitle, parsePrUrl, prExternalId, prUrl } from "../sensing/pr.js";
import {
  WAIT_ANSWERED_EVENT,
  WAIT_OPENED_EVENT,
  WAIT_RECURRENCE_EVENT,
  type EventProvenance,
  type TypeSpec,
} from "../types.js";
import {
  DEMO_TEAM_ID,
  REVIEW_PRESETS,
  REVIEW_PRESET_NAMES,
  REVIEW_TYPE,
  VERDICT_KEY,
  verdictTransitionOfPreset,
} from "../workspace/specs.js";

// ---- the shared shape ----

/** Who is calling, in which team, and what they are working on. */
export interface VerbContext {
  teamId: string;
  /** Provenance for every row this call writes. An agent run, a person in the
   *  product, a rule, or the clock - the seam records it verbatim. */
  actor: EventProvenance;
  /**
   * The object this caller is working "from": the run's dispatching object, or
   * the object a UI action was invoked on. It supplies the default `--for` /
   * `--about` target and the `produces` edge, so a run rarely has to name ids it
   * would have to have been told.
   */
  subjectId?: string;
  now: string;
}

/** Every verb returns this. `data` is the machine-readable half (`--json`), and
 *  the renderer turns the rest into the self-guiding text a run reads. */
export interface VerbOk {
  ok: true;
  /** One line: what just happened. */
  summary: string;
  /** Structured result - ids, statuses, whatever the caller may need next. */
  data: Record<string, unknown>;
  /** THE NEXT COMMANDS (decision 15b). One to three, for THIS state. */
  next: string[];
  /** True when this call changed nothing because it had already happened. */
  replay?: boolean;
}

export interface VerbFail {
  ok: false;
  code: string;
  message: string;
  /** THE WAY OUT (decision 15b): what the caller may legally do instead. A
   *  refusal that does not say this is a refusal an agent cannot recover from. */
  allowed?: string[];
  data?: Record<string, unknown>;
}

export type VerbResult = VerbOk | VerbFail;

const fail = (code: string, message: string, extra: Omit<VerbFail, "ok" | "code" | "message"> = {}): VerbFail => ({
  ok: false,
  code,
  message,
  ...extra,
});

// ---- task create ----

export interface TaskCreateInput {
  /** Registry type. Must have an EFFECTIVE version - a proposal guards nothing. */
  type: string;
  title?: string;
  /** Instance fields. Domain semantics live here (decision 17). */
  fields?: Record<string, unknown>;
  /**
   * The identity seed. Two calls with the same actor and key are the SAME task,
   * so a retried work order never twins. Defaults to the title, because a run
   * that creates "the same issue" twice in one pass meant it once.
   */
  key?: string;
  /** Link it under this object with a `produces` edge. Defaults to the caller's
   *  subject, so a loop's run automatically owns what it makes. */
  forId?: string;
}

/**
 * Create a piece of work.
 *
 * The id is `obj-cli-<sha256(actor, key)>`, which is what makes the verb safe to
 * retry: the second call finds the row and reports a replay rather than minting a
 * twin the workspace would then show twice.
 */
export async function taskCreate(ctx: VerbContext, input: TaskCreateInput): Promise<VerbResult> {
  const type = input.type.trim();
  if (!type) return fail("VALIDATION_ERROR", "--type is required", { allowed: await typeNames(ctx.teamId) });

  const typeRow = await graph.getEffectiveType(undefined, ctx.teamId, type);
  if (!typeRow) {
    return fail(
      "UNKNOWN_TYPE",
      `"${type}" has no effective registry version in this workspace`,
      { allowed: await typeNames(ctx.teamId) },
    );
  }
  if (typeRow.spec.transitions.length === 0) {
    return fail(
      "NOT_A_TASK",
      `"${type}" declares no transitions - it is content, not work. Use \`graph artifact push\` for a product.`,
    );
  }

  const title = input.title?.trim() || `${type} from ${ctx.actor.actorId}`;
  const key = input.key?.trim() || title;
  const id = `obj-cli-${contentHash({ actor: ctx.actor.actorId, key })}`;
  const forId = input.forId ?? ctx.subjectId;

  const existing = await graph.getObject(undefined, id);
  if (existing) {
    return {
      ok: true,
      replay: true,
      summary: `${id} already exists (${existing.type}, ${existing.status}) - nothing created`,
      data: { objectId: id, type: existing.type, status: existing.status, replay: true },
      next: nextForTask(existing, typeRow.spec),
    };
  }

  const object = await graph.createObject(undefined, {
    id,
    teamId: ctx.teamId,
    archetype: "task",
    type,
    typeVersion: typeRow.version,
    status: typeRow.spec.initialState,
    title,
    payload: { ...(input.fields ?? {}), createdBy: ctx.actor.actorId },
    now: ctx.now,
  });
  if (forId) await produces(ctx, forId, id);
  await note(ctx, id, "object-created", `created ${type} “${title}”`, { key, forId: forId ?? null });

  logger.info({ verb: "task create", id, type, actor: ctx.actor.actorId }, "graph cli: task created");
  return {
    ok: true,
    summary: `created ${id} (${type}, ${object.status})`,
    data: { objectId: id, type, status: object.status, title },
    next: nextForTask(object, typeRow.spec),
  };
}

// ---- task move ----

export interface TaskMoveInput {
  objectId: string;
  transition: string;
  /** One line for the Timeline - why this move happened. */
  note?: string;
  /** Fields to write with the move (diffed onto the event like any other). */
  fields?: Record<string, unknown>;
}

/**
 * Walk a task through its state machine - a direct pass to `applyTransition`,
 * with one addition that is the whole reason this verb is worth having: A REFUSAL
 * COMES BACK WITH THE WAY OUT.
 *
 * The kernel's refusals are typed and precise ("`fix` cannot run from `open`"),
 * which is exactly right for a program and useless to an agent that now has to
 * guess. So an illegal move is answered with the transitions that ARE legal from
 * where the object actually is, plus any gate that is holding it - decision
 * 15(b), and the difference between an agent recovering in one turn and looping.
 */
export async function taskMove(ctx: VerbContext, input: TaskMoveInput): Promise<VerbResult> {
  const object = await graph.getObject(undefined, input.objectId);
  if (!object) return fail("NOT_FOUND", `no object ${input.objectId} in this workspace`);

  const result = await applyTransition({
    objectId: input.objectId,
    transition: input.transition,
    actor: ctx.actor,
    now: ctx.now,
    // Deterministic per (actor, object, transition): a retried move is a replay,
    // never a second event. A genuinely repeated move by a LATER actor still
    // lands, because the actor is part of the seed.
    derivedFrom: { cli: ctx.actor.actorId, object: input.objectId, transition: input.transition },
    ...(input.fields ? { fields: input.fields } : {}),
    eventPayload: { note: input.note ?? `${input.transition} via graph cli`, by: ctx.actor.actorId },
  });

  if (!result.ok) {
    const spec = (await graph.getEffectiveType(undefined, object.teamId, object.type))?.spec;
    const open = (await graph.listObjectObligations(undefined, object.id)).filter((o) => o.closedByEvent === null);
    return fail(result.code, result.message, {
      allowed: spec ? legalTransitions(spec, object.status, ctx.actor.entrance) : [],
      data: {
        objectId: object.id,
        status: object.status,
        openObligations: open.map((o) => ({ key: o.key, class: o.class, label: o.label })),
      },
    });
  }

  const spec = (await graph.getEffectiveType(undefined, object.teamId, object.type))?.spec;
  return {
    ok: true,
    replay: result.replay,
    summary: `${input.objectId} is now “${result.object.status}”${result.replay ? " (already was - replay)" : ""}`,
    data: {
      objectId: input.objectId,
      status: result.object.status,
      eventId: result.event.id,
      replay: result.replay,
      opened: result.opened.map((o) => o.key),
      closed: result.closed.map((o) => o.key),
    },
    next: spec ? nextForTask(result.object, spec) : [],
  };
}

// ---- artifact push ----

export interface ArtifactPushInput {
  /** The file's bytes. The CLI reads the file; the server never touches a disk. */
  body: string;
  /** Original filename, for the title when the body declares none. */
  filename?: string;
  title?: string;
  /** Doc type. `report` unless the caller says otherwise. */
  type?: string;
  /** What produced it. Defaults to the caller's subject. */
  forId?: string;
  /** An artifact this one supersedes. */
  replacesId?: string;
}

/**
 * Leave a product behind - a doc, created the ordinary way.
 *
 * IDENTITY IS THE CONTENT HASH, which is the strongest form idempotency takes in
 * this vocabulary: pushing the same bytes for the same producer twice is one
 * object, whether the second call is a retry, a re-delivered work order or an
 * agent that lost track. Different bytes are a different artifact, which is also
 * right - a revised report is a new product, and `--replaces` is how it says so.
 *
 * A doc has no state machine (decision 8), so there is no transition here: the
 * object, a `produces` edge and an `object-created` event, and that is all.
 */
export async function artifactPush(ctx: VerbContext, input: ArtifactPushInput): Promise<VerbResult> {
  const body = input.body;
  if (!body.trim()) return fail("VALIDATION_ERROR", "the artifact is empty - there is nothing to push");
  if (body.length > ARTIFACT_CAP) {
    return fail("TOO_LARGE", `the artifact is ${body.length} bytes, over the ${ARTIFACT_CAP} cap`);
  }

  const forId = input.forId ?? ctx.subjectId;
  const front = readFrontMatter(body);
  const type = (input.type ?? front.type ?? "report").trim();
  const title = (input.title ?? front.title ?? input.filename ?? "Untitled").trim();
  const id = `obj-art-${contentHash({ producer: forId ?? ctx.actor.actorId, body })}`;

  const existing = await graph.getObject(undefined, id);
  if (existing) {
    return {
      ok: true,
      replay: true,
      summary: `${id} already holds these exact bytes - nothing pushed`,
      data: { objectId: id, type: existing.type, replay: true },
      next: nextForArtifact(id),
    };
  }

  await graph.createObject(undefined, {
    id,
    teamId: ctx.teamId,
    archetype: "doc",
    type,
    status: "current",
    title,
    payload: {
      // The stored artifact FILE - the key the Library renders from. The caller
      // authored the body; we add the machine head when it has none, so a product
      // is always front matter + Markdown (captain decision 6).
      source: front.hasFrontMatter ? body : serializeArtifact({ frontMatter: { type, title, createdAt: ctx.now }, body: endNl(body) }),
      published: false,
      producedBy: ctx.actor.actorId,
      ...(input.replacesId ? { replaces: input.replacesId } : {}),
    },
    now: ctx.now,
  });
  if (forId) await produces(ctx, forId, id);
  if (input.replacesId) {
    const prior = await graph.getObject(undefined, input.replacesId);
    if (!prior) return fail("NOT_FOUND", `--replaces names ${input.replacesId}, which is not in this workspace`);
    await graph.upsertEdge(undefined, {
      teamId: ctx.teamId,
      kind: "replaces",
      srcId: id,
      dstId: input.replacesId,
      now: ctx.now,
    });
    // The superseded artifact says so on itself, so a reader looking at the OLD
    // one learns there is a newer one without walking the edge table.
    await graph.updateObjectFields(
      undefined,
      input.replacesId,
      { payload: { ...((prior.payload ?? {}) as Record<string, unknown>), supersededBy: id } },
      ctx.now,
    );
  }
  await note(ctx, id, "object-created", `pushed “${title}”`, { type, forId: forId ?? null, bytes: body.length });

  logger.info({ verb: "artifact push", id, type, bytes: body.length }, "graph cli: artifact pushed");
  return {
    ok: true,
    summary: `pushed ${id} (${type}, ${body.length} bytes)`,
    data: { objectId: id, type, title, bytes: body.length, ...(input.replacesId ? { replaces: input.replacesId } : {}) },
    next: nextForArtifact(id),
  };
}

/** Bytes one artifact may carry. A product a person reads, not a data dump. */
export const ARTIFACT_CAP = 512 * 1024;

// ---- review request ----

export interface ReviewRequestInput {
  /** What the verdict is about. Defaults to the caller's subject. */
  aboutId?: string;
  question: string;
  /** Which recipe (`REVIEW_PRESETS`). Instance data, never a type. */
  preset?: string;
  /** Extra instance fields - `consequence` prose, `approveSet`, intents. */
  fields?: Record<string, unknown>;
  title?: string;
}

/**
 * Ask a person for a verdict - the verb that replaces the `enqueue-review` chains
 * the specs used to declare (decision 15).
 *
 * ONE type, one obligation key, five presets (decision 16): the review is a
 * standard Task carrying its question and its consequences as fields, and the
 * preset only decides which words the button shows and which transition
 * discharges the gate.
 *
 * The gate opens through `applyTransition`, so the obligation, the event and the
 * provenance are all exactly what a declared chain produced - the difference is
 * only WHO decided to ask.
 */
export async function reviewRequest(ctx: VerbContext, input: ReviewRequestInput): Promise<VerbResult> {
  const question = input.question?.trim();
  if (!question) return fail("VALIDATION_ERROR", "--question is required - a review with no question asks nothing");

  const presetName = (input.preset ?? "decision").trim();
  const preset = REVIEW_PRESETS[presetName];
  if (!preset) {
    return fail("UNKNOWN_PRESET", `"${presetName}" is not a review preset`, { allowed: REVIEW_PRESET_NAMES });
  }

  const aboutId = input.aboutId ?? ctx.subjectId;
  const about = aboutId ? await graph.getObject(undefined, aboutId) : undefined;
  if (aboutId && !about) return fail("NOT_FOUND", `--about names ${aboutId}, which is not in this workspace`);

  const typeRow = await graph.getEffectiveType(undefined, ctx.teamId, REVIEW_TYPE);
  if (!typeRow) return fail("UNKNOWN_TYPE", `"${REVIEW_TYPE}" has no effective registry version in this workspace`);

  const id = `obj-rev-${contentHash({ actor: ctx.actor.actorId, about: aboutId ?? null, question })}`;
  const existing = await graph.getObject(undefined, id);
  if (!existing) {
    await graph.createObject(undefined, {
      id,
      teamId: ctx.teamId,
      archetype: "task",
      type: REVIEW_TYPE,
      typeVersion: typeRow.version,
      status: typeRow.spec.initialState,
      title: input.title?.trim() || question.slice(0, 120),
      payload: {
        preset: presetName,
        question,
        ...(aboutId ? { subject: aboutId, reviews: aboutId } : {}),
        ...preset.payload,
        ...(input.fields ?? {}),
        requestedBy: ctx.actor.actorId,
      },
      now: ctx.now,
    });
    if (about) {
      await graph.upsertEdge(undefined, { teamId: ctx.teamId, kind: "tracks", srcId: id, dstId: about.id, now: ctx.now });
      // Whoever produced the subject produces its review too, so the System view's
      // gate node hangs off the right loop rather than floating.
      for (const producer of await graph.edgesTo(undefined, about.id, "produces")) {
        await graph.upsertEdge(undefined, {
          teamId: ctx.teamId,
          kind: "produces",
          srcId: producer.srcId,
          dstId: id,
          now: ctx.now,
        });
      }
    } else if (ctx.subjectId) {
      await produces(ctx, ctx.subjectId, id);
    }
  }

  const submitted = await applyTransition({
    objectId: id,
    transition: "submit",
    actor: ctx.actor,
    now: ctx.now,
    derivedFrom: { review: id, transition: "submit" },
    eventPayload: { note: `review requested: ${question}`, question, preset: presetName },
  });
  if (!submitted.ok) {
    return fail(submitted.code, `the review was created but its gate did not open: ${submitted.message}`, {
      data: { objectId: id },
    });
  }

  logger.info({ verb: "review request", id, preset: presetName, about: aboutId ?? null }, "graph cli: review requested");
  return {
    ok: true,
    replay: submitted.replay,
    summary: `${id} is waiting on a person (${preset.label}) — ${question}`,
    data: {
      objectId: id,
      preset: presetName,
      status: submitted.object.status,
      question,
      verdictTransition: preset.verdict,
      ...(aboutId ? { about: aboutId } : {}),
      replay: submitted.replay,
    },
    next: [
      "A person now owes this verdict — your part is done unless you were asked to wait.",
      `graph wait open ${id} --key ${VERDICT_KEY} --question "has this been answered?" --watcher <loop-id>   # only if you must track it yourself`,
    ],
  };
}

// ---- mirror track ----

export interface MirrorTrackInput {
  /** The external thing: a GitHub PR URL, or any `<source>:<id>` reference. */
  ref: string;
  /** Explicit form, for a source with no URL shape at all. */
  source?: string;
  externalId?: string;
  title?: string;
  /** What produced it. Defaults to the caller's subject. */
  forId?: string;
}

/**
 * Register an external thing we now care about.
 *
 * DOMAIN-NEUTRAL BY CONSTRUCTION (decision 17): a mirror is `(source,
 * externalId)` and nothing else, so a Reddit thread, a search-console URL and a
 * pull request are the same row shape. GitHub PR URLs get a parser and the
 * `pull-request` type because that source has an EARNED sensing accelerator that
 * knows how to observe them; every other source lands on the built-in `mirror`
 * type and is observed by whatever the agent's instructions say - which is the
 * point, since the alternative is a handler per website.
 *
 * Idempotent by identity: the mirror id is derived from `(team, source,
 * externalId)`, so tracking the same thing twice converges on one row.
 */
export async function mirrorTrack(ctx: VerbContext, input: MirrorTrackInput): Promise<VerbResult> {
  const parsed = parseMirrorRef(input);
  if (!parsed.ok) return fail("VALIDATION_ERROR", parsed.why);

  const forId = input.forId ?? ctx.subjectId;
  const { object: mirror, created } = await graph.getOrCreateMirror(undefined, {
    teamId: ctx.teamId,
    externalSource: parsed.source,
    externalId: parsed.externalId,
    type: parsed.type,
    status: "observed",
    title: input.title?.trim() || parsed.title,
    payload: { ...parsed.payload, trackedBy: ctx.actor.actorId },
    now: ctx.now,
  });
  if (forId) await produces(ctx, forId, mirror.id);
  if (created) {
    await note(ctx, mirror.id, "object-created", `now tracking ${parsed.externalId}`, {
      source: parsed.source,
      externalId: parsed.externalId,
    });
  }

  logger.info({ verb: "mirror track", id: mirror.id, source: parsed.source, created }, "graph cli: mirror tracked");
  return {
    ok: true,
    replay: !created,
    summary: `${created ? "tracking" : "already tracking"} ${parsed.externalId} as ${mirror.id}`,
    data: {
      objectId: mirror.id,
      source: parsed.source,
      externalId: parsed.externalId,
      status: mirror.status,
      created,
    },
    next: [
      `graph wait open ${mirror.id} --key merge-wait --question "has it landed?" --watcher ${ctx.subjectId ?? "<loop-id>"}`,
      `graph review request --about ${mirror.id} --preset merge --question "merge this?"`,
    ],
  };
}

// ---- wait open ----

export interface WaitOpenInput {
  objectId: string;
  key: string;
  question: string;
  /** WHO ANSWERS IT (decision 13). Required - a wait nobody is named for is the
   *  debt this field exists to make impossible. */
  watcherId: string;
  label?: string;
}

/**
 * Record a standing question about the outside world, and name who answers it.
 *
 * Captain decision 13: a wait EXPLICITLY NAMES ITS WATCHER at creation - no
 * inference and no discovery query. The default watcher is the loop already
 * observing that source on its cadence; a dedicated watch task is created only on
 * a concrete mismatch. Either way it is an object id on this row.
 *
 * The watcher is VALIDATED here, and that is the whole safety story: a wait
 * pointed at a completed, paused or missing object is refused at creation rather
 * than discovered months later as an obligation nobody was ever going to answer.
 *
 * This is an `external-wait`, never a gate (design §12 item 5): nobody in the
 * product owes a verdict, we are waiting on the world. It re-surfaces on a bounded
 * schedule so a forgotten wait cannot rot invisibly.
 */
export async function waitOpen(ctx: VerbContext, input: WaitOpenInput): Promise<VerbResult> {
  const key = input.key?.trim();
  const question = input.question?.trim();
  if (!key) return fail("VALIDATION_ERROR", "--key is required - it is the wait's identity on this object");
  if (!question) return fail("VALIDATION_ERROR", "--question is required - the watcher has to know what to answer");

  const object = await graph.getObject(undefined, input.objectId);
  if (!object) return fail("NOT_FOUND", `no object ${input.objectId} in this workspace`);

  const watcherId = input.watcherId?.trim();
  if (!watcherId) {
    return fail("VALIDATION_ERROR", "--watcher is required - an unwatched wait is a debt nobody will pay");
  }
  const watcher = await graph.getObject(undefined, watcherId);
  if (!watcher) return fail("NOT_FOUND", `--watcher names ${watcherId}, which is not in this workspace`);
  const watcherSpec = (await graph.getEffectiveType(undefined, watcher.teamId, watcher.type))?.spec;
  if (watcherSpec && (watcherSpec.terminalStates ?? []).includes(watcher.status)) {
    return fail(
      "WATCHER_UNAVAILABLE",
      `${watcherId} is "${watcher.status}", which is terminal - it will never look again. ` +
        "Name a live loop, or create a watch task for this.",
    );
  }

  const existing = await graph.getObligation(undefined, input.objectId, key);
  if (existing && existing.closedByEvent === null) {
    return {
      ok: true,
      replay: true,
      summary: `${input.objectId} is already waiting on “${key}” (watcher ${existing.watcherObjectId ?? "unnamed"})`,
      data: { objectId: input.objectId, key, watcher: existing.watcherObjectId, replay: true },
      next: [`graph wait answer ${input.objectId} ${key} --met --evidence "<what you saw>"`],
    };
  }

  const eventId = derivedEventId({ waitOpen: input.objectId, key, by: ctx.actor.actorId });
  await graph.appendEvent(undefined, {
    id: eventId,
    teamId: ctx.teamId,
    objectId: input.objectId,
    kind: WAIT_OPENED_EVENT,
    origin: "derived",
    payload: { key, question, watcher: watcherId, note: `waiting: ${question}` },
    entrance: ctx.actor.entrance,
    actorId: ctx.actor.actorId,
    ts: ctx.now,
  });
  const { obligation, opened } = await graph.openObligation(undefined, {
    objectId: input.objectId,
    key,
    teamId: ctx.teamId,
    class: "external-wait",
    label: input.label?.trim() || question,
    openedByEvent: eventId,
    nextReminderAt: new Date(msOf(ctx.now) + WAIT_REMINDER_MS).toISOString(),
    watcherObjectId: watcherId,
    question,
    now: ctx.now,
  });

  logger.info({ verb: "wait open", object: input.objectId, key, watcher: watcherId }, "graph cli: wait opened");
  return {
    ok: true,
    replay: !opened,
    summary: `${input.objectId} now waits on “${key}” — ${watcher.title ?? watcherId} answers it`,
    data: { objectId: input.objectId, key, watcher: watcherId, question, openedAt: obligation.openedAt },
    next: [
      `graph wait answer ${input.objectId} ${key} --met --evidence "<what you saw>"`,
      `graph wait answer ${input.objectId} ${key} --not-met --evidence "<what you saw>"`,
    ],
  };
}

// ---- wait answer ----

export interface WaitAnswerInput {
  objectId: string;
  key: string;
  /** `true` = the condition holds, close it. `false` = not yet, renew it. */
  met: boolean;
  /** WHAT WAS SEEN. The answer's evidence, recorded on the closing event -
   *  decision 13's "answer = evidence". */
  evidence: string;
}

/**
 * Answer a standing question - the verb that makes AGENT EYES the default
 * observation mode (captain decisions 13 + 14).
 *
 * Three outcomes, and the third is the one worth building for:
 *
 *   MET on an open wait        the wait CLOSES, with the answer as its evidence.
 *   NOT MET on an open wait    it RENEWS. "Not yet" is an ordinary answer, not a
 *                              failure - a windowed judgment ("three consecutive
 *                              quiet sweeps") lives in the watcher's head and the
 *                              kernel counts nothing (decision 14).
 *   NOT MET on a CLOSED wait   RECURRENCE. The thing came back. The wait reopens
 *                              (so the watcher keeps watching) AND an attention
 *                              item is raised (so a person learns the fix stopped
 *                              holding). Re-watching alone would leave everybody
 *                              believing it was fixed.
 *
 * A `met` answer on an already-closed wait is a clean replay: the answer has not
 * changed and neither has the world.
 */
export async function waitAnswer(ctx: VerbContext, input: WaitAnswerInput): Promise<VerbResult> {
  const key = input.key?.trim();
  const evidence = input.evidence?.trim();
  if (!key) return fail("VALIDATION_ERROR", "the wait key is required");
  if (!evidence) {
    return fail("VALIDATION_ERROR", "--evidence is required - an answer with nothing behind it is an assertion");
  }

  const obligation = await graph.getObligation(undefined, input.objectId, key);
  if (!obligation) {
    const open = await graph.listOpenObligations(undefined, ctx.teamId, { objectId: input.objectId });
    return fail("NO_SUCH_WAIT", `${input.objectId} holds no wait keyed "${key}"`, {
      allowed: open.map((o) => `${o.key} (${o.class})`),
    });
  }
  if (obligation.class !== "external-wait") {
    return fail(
      "NOT_A_WAIT",
      `"${key}" is a ${obligation.class} obligation - a person answers that one in the workspace, not an agent`,
    );
  }

  const wasClosed = obligation.closedByEvent !== null;
  const answer = input.met ? "met" : "not-met";
  const recurrence = wasClosed && !input.met;

  // Deterministic per (actor, object, key, answer): a retried answer is one row.
  // A DIFFERENT answer from the same actor is a genuinely different fact and gets
  // its own event, which is what makes a recurrence visible rather than swallowed.
  const eventId = derivedEventId({ waitAnswer: input.objectId, key, answer, by: ctx.actor.actorId, at: recurrence ? ctx.now : null });

  return db.transaction(async (raw) => {
    const tx = raw as unknown as GraphExec;
    const { inserted } = await graph.appendEvent(tx, {
      id: eventId,
      teamId: ctx.teamId,
      objectId: input.objectId,
      kind: recurrence ? WAIT_RECURRENCE_EVENT : WAIT_ANSWERED_EVENT,
      origin: "derived",
      payload: {
        key,
        answer,
        evidence: clip(evidence),
        question: obligation.question,
        watcher: obligation.watcherObjectId,
        ...(recurrence
          ? {
              code: "WAIT_RECURRENCE",
              reason: `“${obligation.question ?? key}” was answered met and has come back: ${clip(evidence)}`,
            }
          : {}),
        note: recurrence
          ? `it came back: ${key}`
          : input.met
            ? `wait answered MET: ${key}`
            : `wait answered not yet: ${key}`,
      },
      entrance: ctx.actor.entrance,
      actorId: ctx.actor.actorId,
      ts: ctx.now,
    });

    let state: string;
    if (input.met && !wasClosed) {
      await graph.closeObligation(tx, { objectId: input.objectId, key, closedByEvent: eventId, now: ctx.now });
      state = "closed";
    } else if (input.met) {
      state = "already closed";
    } else if (recurrence) {
      await graph.reopenObligation(tx, {
        objectId: input.objectId,
        key,
        openedByEvent: eventId,
        nextReminderAt: new Date(msOf(ctx.now) + WAIT_REMINDER_MS).toISOString(),
        now: ctx.now,
      });
      state = "REOPENED";
    } else {
      await graph.renewObligation(tx, {
        objectId: input.objectId,
        key,
        nextReminderAt: new Date(msOf(ctx.now) + WAIT_REMINDER_MS).toISOString(),
      });
      state = "still open";
    }

    logger.info(
      { verb: "wait answer", object: input.objectId, key, answer, recurrence, replay: !inserted },
      "graph cli: wait answered",
    );
    return {
      ok: true as const,
      replay: !inserted,
      summary: recurrence
        ? `“${key}” came back — the wait is open again and a person has been told`
        : `“${key}” answered ${answer} — ${state}`,
      data: { objectId: input.objectId, key, answer, state, recurrence, eventId, replay: !inserted },
      next: recurrence
        ? [
            "This is now an attention item in the workspace — a person decides what happens next.",
            `graph wait answer ${input.objectId} ${key} --met --evidence "<if it clears again>"`,
          ]
        : input.met
          ? ["Nothing more is owed on this wait."]
          : [`graph wait answer ${input.objectId} ${key} --met --evidence "<when it clears>"`],
    };
  });
}

// ---- shared helpers ----

/** Every transition legal from `status` for THIS entrance - the "way out" a
 *  refusal hands back (decision 15b). A gate state admits only a human, so an
 *  agent asking is told the truth: nothing, until a person acts. */
export function legalTransitions(spec: TypeSpec, status: string, entrance: string): string[] {
  const gated = (spec.gateStates ?? []).includes(status);
  const out: string[] = [];
  for (const t of spec.transitions) {
    const from = t.from.includes(status) || (t.from.includes("*") && !(spec.terminalStates ?? []).includes(status));
    if (!from) continue;
    if (gated && entrance !== "human") continue;
    if (t.entrance) {
      const allowed = Array.isArray(t.entrance) ? t.entrance : [t.entrance];
      if (!(allowed as readonly string[]).includes(entrance)) continue;
    }
    out.push(t.name);
  }
  return out;
}

/** The one to three commands that make sense for a task in THIS state. */
function nextForTask(object: GraphObject, spec: TypeSpec): string[] {
  const moves = legalTransitions(spec, object.status, "agent-run");
  const out: string[] = [];
  if (moves.length) out.push(`graph task move ${object.id} ${moves[0]}${moves.length > 1 ? `   # or: ${moves.slice(1).join(", ")}` : ""}`);
  out.push(`graph artifact push <file> --for ${object.id}`);
  out.push(`graph review request --about ${object.id} --question "<what should a person decide?>"`);
  return out;
}

function nextForArtifact(id: string): string[] {
  return [
    `graph review request --about ${id} --question "<what should a person decide?>"`,
    `graph artifact push <file> --replaces ${id}   # when you revise it`,
  ];
}

async function typeNames(teamId: string): Promise<string[]> {
  const rows = await graph.listEffectiveTypes(undefined, teamId);
  return [...new Set(rows.map((r) => r.name))].sort();
}

/** The `produces` edge - "this object made that one". Best effort: a missing
 *  producer is not worth failing a write over, and the object still exists. */
async function produces(ctx: VerbContext, srcId: string, dstId: string): Promise<void> {
  const src = await graph.getObject(undefined, srcId);
  if (!src) return;
  await graph.upsertEdge(undefined, { teamId: ctx.teamId, kind: "produces", srcId, dstId, now: ctx.now });
}

/** One derived event recording something this verb did that is not a transition
 *  (a creation, a registration). Derived from the object and kind, so a retry is
 *  one row. */
async function note(
  ctx: VerbContext,
  objectId: string,
  kind: string,
  message: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await graph.appendEvent(undefined, {
    id: derivedEventId({ cli: kind, object: objectId, by: ctx.actor.actorId }),
    teamId: ctx.teamId,
    objectId,
    kind,
    origin: "derived",
    payload: { ...payload, note: message, by: ctx.actor.actorId },
    entrance: ctx.actor.entrance,
    actorId: ctx.actor.actorId,
    ts: ctx.now,
  });
}

/**
 * Resolve an external reference to `(source, externalId)`.
 *
 * A GitHub pull-request URL is recognized because that source has a real sensing
 * accelerator behind it - it becomes a `pull-request` mirror the machine agent
 * knows how to observe. EVERYTHING ELSE is generic: `source:id`, or explicit
 * `--source`/`--external-id`, landing on the built-in `mirror` type. That split
 * is decision 17 in one function: one earned exception, and a domain-neutral
 * default that needs no platform code per website.
 */
function parseMirrorRef(
  input: MirrorTrackInput,
): { ok: true; source: string; externalId: string; type: string; title: string; payload: Record<string, unknown> } | { ok: false; why: string } {
  const explicitSource = input.source?.trim();
  const explicitId = input.externalId?.trim();
  if (explicitSource && explicitId) {
    return {
      ok: true,
      source: explicitSource,
      externalId: `${explicitSource}/${explicitId}`.replace(/\/+/g, "/"),
      type: "mirror",
      title: input.title?.trim() || `${explicitSource}: ${explicitId}`,
      payload: { source: explicitSource, ref: explicitId },
    };
  }

  const ref = input.ref?.trim();
  if (!ref) return { ok: false, why: "a reference is required: a URL, or --source with --external-id" };

  const pr = parsePrUrl(ref);
  if (pr) {
    return {
      ok: true,
      source: PR_SOURCE,
      externalId: prExternalId(pr),
      type: PR_TYPE,
      title: mirrorTitle({ ...pr, title: `#${pr.number}`, state: "open", merged: false, checks: "none", draft: false }),
      payload: { repo: pr.repo, number: pr.number, sourceUrl: prUrl(pr) },
    };
  }

  // `source:rest` - the domain-neutral form. A bare URL uses its host as the
  // source, which is the honest reading of "register this external thing".
  const url = /^https?:\/\//.test(ref) ? safeUrl(ref) : undefined;
  if (url) {
    return {
      ok: true,
      source: url.host,
      externalId: ref,
      type: "mirror",
      title: input.title?.trim() || ref,
      payload: { sourceUrl: ref },
    };
  }
  const at = ref.indexOf(":");
  if (at > 0) {
    const source = ref.slice(0, at).trim();
    const rest = ref.slice(at + 1).trim();
    if (source && rest) {
      return {
        ok: true,
        source,
        externalId: `${source}/${rest}`,
        type: "mirror",
        title: input.title?.trim() || ref,
        payload: { source, ref: rest },
      };
    }
  }
  return {
    ok: false,
    why: `"${ref}" is not a reference this verb can read - use a URL, "<source>:<id>", or --source with --external-id`,
  };
}

function safeUrl(v: string): URL | undefined {
  try {
    return new URL(v);
  } catch {
    return undefined;
  }
}

/** The front matter an artifact already carries, if any. Deliberately a shallow
 *  read of the two keys this verb uses - the artifact library owns the real
 *  parse, and this must never reject a file it merely does not understand. */
function readFrontMatter(body: string): { hasFrontMatter: boolean; type?: string; title?: string } {
  if (!body.startsWith("---")) return { hasFrontMatter: false };
  const end = body.indexOf("\n---", 3);
  if (end === -1) return { hasFrontMatter: false };
  const head = body.slice(3, end);
  const read = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head);
    return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { hasFrontMatter: true, ...(read("type") ? { type: read("type")! } : {}), ...(read("title") ? { title: read("title")! } : {}) };
}

const EVIDENCE_CAP = 2_000;

function clip(s: string): string {
  return s.length > EVIDENCE_CAP ? `${s.slice(0, EVIDENCE_CAP)}…` : s;
}

function endNl(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

function msOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Re-exported so callers that only need the team default do not import the demo
 *  spec module directly. */
export { DEMO_TEAM_ID };

/** Kept out of the public surface but used by the endpoints: running a
 *  transition inside a caller's transaction (the verdict path composes one). */
export { applyTransitionIn, findTransition, organicEventId, VERDICT_KEY, verdictTransitionOfPreset };
