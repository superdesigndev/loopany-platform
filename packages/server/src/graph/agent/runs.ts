/**
 * Graph Engineering v1 - THE RUNS BRIDGE, report-back direction.
 *
 * Dispatch goes out over the directive channel (a `run-task` work order, written
 * by the `dispatch-outward-run` handler). This module is the way BACK: the two
 * calls a machine agent makes while it runs the work, and everything the graph
 * does with them.
 *
 *   runStarted  → one `run-started` event on the dispatching object
 *   runFinished → one `run-finished` event, optionally a report DOC, and the
 *                 dispatching object's state ADVANCED through `applyTransition`
 *
 * ── why the run's own identity is derived, not minted ────────────────────────
 *
 * `runIdOf(directiveId)` is a pure function, so the run id is fixed before the run
 * starts and is the SAME id however many times the lease is re-offered, the agent
 * restarts, or a report is re-delivered. Every row this module writes keys off it:
 * both events are `derived`, the report doc's id is derived, and the advancing
 * transition passes `derivedFrom`. So the whole report-back path is replay-safe by
 * construction rather than by a "have I seen this run before?" lookup - the same
 * dedup-by-identity discipline the observation pipe and the outbox use, and the
 * reason "run-finished advances the dispatching task exactly once" is a property
 * and not a hope.
 *
 * ── provenance: two entrances, on purpose ───────────────────────────────────
 *
 * The run's own events carry `entrance: "agent-run"` with the RUN ID as the actor,
 * because that is exactly what that entrance class means (design §12: actor id =
 * run id). The TRANSITION they cause carries `entrance: "rule"` with the
 * directive/action id as the actor, because the state change is the engine's
 * declarative consequence of a run finishing - not the run reaching into our state
 * machine. That is the same shape an observation takes when it closes a wait: the
 * fact is attributed to what observed it, the consequence to the rule that
 * declared it.
 *
 * ── the lease is the authority ──────────────────────────────────────────────
 *
 * Both verbs require the caller to still HOLD the directive's lease. Without that
 * check any process with the channel token could advance any task by naming a
 * directive id, and a zombie agent could advance a task its successor had already
 * finished. The check is the same one `effects/channel.ts` makes on a report, and
 * it fails with the same `LEASE_LOST` answer, which is the truth.
 *
 * ── the clock ───────────────────────────────────────────────────────────────
 *
 * `now` is passed in. The route reads the clock.
 */
import { serializeArtifact } from "@loopany/artifact-format";

import { logger } from "../../logger.js";
import { db } from "../../db/index.js";
import type { EffectDirective, GraphEvent, GraphObject } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import type { GraphExec } from "../../db/graphStore.js";
import { applyTransitionIn } from "../applyTransition.js";
import { instructionOf, runIdOf, runReportDocId, RUN_FINISHED_EVENT, RUN_STARTED_EVENT } from "../effects/instruction.js";
import { derivedEventId } from "../ids.js";

/** The outcome a finished run reports. Two values, closed: a run either did the
 *  thing or it did not, and every richer distinction (timed out, refused, crashed)
 *  rides the directive's typed refusal code where the attention list can group on
 *  it. */
export const RUN_OUTCOMES = ["success", "failure"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export function isRunOutcome(v: unknown): v is RunOutcome {
  return typeof v === "string" && (RUN_OUTCOMES as readonly string[]).includes(v);
}

export type RunError = "UNKNOWN_DIRECTIVE" | "NOT_A_RUN" | "LEASE_LOST" | "NO_OBJECT";

export interface RunFail {
  ok: false;
  code: RunError;
  message: string;
}

export interface RunStartedOk {
  ok: true;
  runId: string;
  objectId: string;
  /** True when the `run-started` event already existed - a re-delivery, which
   *  applied nothing. */
  replay: boolean;
}

export interface RunFinishedOk {
  ok: true;
  runId: string;
  objectId: string;
  outcome: RunOutcome;
  /** True when this exact outcome had already been recorded. */
  replay: boolean;
  /** The transition the outcome ran on the dispatching object, when the work
   *  order declared one for this outcome and the seam accepted it. */
  advanced?: { transition: string; status: string; replay: boolean };
  /** Why the object did not advance, when it did not. Always a real reason - a
   *  run whose consequence silently evaporated is the failure this bridge exists
   *  to prevent. */
  notAdvanced?: string;
  /** The report Doc this run produced, when it produced one. */
  report?: { objectId: string; created: boolean };
}

// ---- lease resolution, shared by both verbs ----

interface Held {
  directive: EffectDirective;
  object: GraphObject;
  runId: string;
}

/**
 * Resolve `(directive, agent)` to a work order this caller may still report on.
 *
 * Every refusal here is a REFUSAL and not a soft path: an unknown directive, a
 * directive that is not a run, a lease somebody else holds, and a work order whose
 * object has been deleted are four different mistakes, and collapsing them would
 * make the agent's log useless exactly when it matters.
 */
async function held(input: { directiveId: string; agent: string }): Promise<Held | RunFail> {
  const directive = await graph.getDirective(undefined, input.directiveId);
  if (!directive) {
    return { ok: false, code: "UNKNOWN_DIRECTIVE", message: `no directive ${input.directiveId}` };
  }
  if (directive.kind !== "run-task") {
    return {
      ok: false,
      code: "NOT_A_RUN",
      message: `${directive.id} is a "${directive.kind}" work order - only a run reports a run lifecycle`,
    };
  }
  if (directive.state !== "claimed" || directive.claimedBy !== input.agent) {
    return {
      ok: false,
      code: "LEASE_LOST",
      message:
        `${directive.id} is "${directive.state}" and held by ${directive.claimedBy ?? "nobody"} - ` +
        `${input.agent} may not report on it`,
    };
  }
  if (!directive.objectId) {
    return { ok: false, code: "NO_OBJECT", message: `${directive.id} names no dispatching object` };
  }
  const object = await graph.getObject(undefined, directive.objectId);
  if (!object) {
    return { ok: false, code: "NO_OBJECT", message: `object ${directive.objectId} is gone` };
  }
  return { directive, object, runId: runIdOf(directive.id) };
}

const isFail = (v: Held | RunFail): v is RunFail => "ok" in v && v.ok === false;

// ---- run-started ----

export interface RunStartedInput {
  now: string;
  agent: string;
  directiveId: string;
}

/**
 * The run began.
 *
 * One derived event, on the dispatching object, with the run as its actor. It
 * writes nothing else - in particular it does NOT advance the object, because
 * "started" is not an outcome and a task that moved on the strength of a run
 * merely beginning would have to be moved back if the run died.
 */
export async function runStarted(input: RunStartedInput): Promise<RunStartedOk | RunFail> {
  const resolved = await held({ directiveId: input.directiveId, agent: input.agent });
  if (isFail(resolved)) return refuse(resolved);
  const { directive, object, runId } = resolved;
  const spec = instructionOf(directive.payload);

  const { inserted } = await graph.appendEvent(undefined, {
    id: runEventId(runId, "started"),
    teamId: directive.teamId,
    objectId: object.id,
    kind: RUN_STARTED_EVENT,
    origin: "derived",
    payload: {
      run: runId,
      directive: directive.id,
      agent: input.agent,
      label: spec?.label ?? null,
      intent: spec?.intent ?? null,
      note: `run started: ${spec?.label ?? "dispatched work"}`,
    },
    entrance: "agent-run",
    actorId: runId,
    ts: input.now,
  });

  logger.info({ run: runId, directive: directive.id, object: object.id, replay: !inserted }, "runs: run started");
  return { ok: true, runId, objectId: object.id, replay: !inserted };
}

// ---- run-finished ----

export interface RunFinishedInput {
  now: string;
  agent: string;
  directiveId: string;
  outcome: RunOutcome;
  /** One line for the Timeline. The run's own words about what it did. */
  summary?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  /** A product the run wants to leave behind. Created as a `report` DOC through
   *  the ordinary kernel path, with the run as its provenance. */
  report?: { title?: string | null; body: string } | null;
}

/**
 * The run finished, and the graph moves.
 *
 * Three writes, in this order and all replay-safe by derived identity:
 *
 *   1. the `run-finished` EVENT - what happened, attributed to the run;
 *   2. the report DOC, when the run produced one - created through
 *      `graphStore.createObject` + a `produces` edge + an `object-created` event,
 *      which is the ordinary path for content (a doc has no state machine, so
 *      there is no transition to run on it - captain decision 8);
 *   3. the TRANSITION the work order declared for this outcome, through
 *      `applyTransition` with `entrance: "rule"`.
 *
 * All three land in ONE transaction. That matters: a run whose event was recorded
 * but whose consequence was not would look settled and be stuck, which is the
 * precise failure the outbox's own "written together or not at all" rule exists to
 * prevent one layer up.
 *
 * A work order that declares NO transition for this outcome is a legitimate
 * posture (a run that only produces a report), and the result says so in
 * `notAdvanced` rather than leaving a caller to infer it from an absence.
 */
export async function runFinished(input: RunFinishedInput): Promise<RunFinishedOk | RunFail> {
  const resolved = await held({ directiveId: input.directiveId, agent: input.agent });
  if (isFail(resolved)) return refuse(resolved);
  const { directive, object, runId } = resolved;
  const spec = instructionOf(directive.payload);

  return db.transaction(async (raw) => {
    const tx = raw as unknown as GraphExec;

    const { inserted } = await graph.appendEvent(tx, {
      // The outcome is part of the identity: a run cannot both succeed and fail,
      // so this collides only with a genuine re-delivery of the same outcome, and
      // a contradictory second report is visible as its own row rather than
      // silently swallowed by a coarser key.
      id: runEventId(runId, "finished", input.outcome),
      teamId: directive.teamId,
      objectId: object.id,
      kind: RUN_FINISHED_EVENT,
      origin: "derived",
      payload: {
        run: runId,
        directive: directive.id,
        agent: input.agent,
        outcome: input.outcome,
        label: spec?.label ?? null,
        exitCode: input.exitCode ?? null,
        durationMs: input.durationMs ?? null,
        summary: clip(input.summary) ?? null,
        note: finishedNote(input.outcome, spec?.label, input.summary, input.exitCode),
      },
      entrance: "agent-run",
      actorId: runId,
      ts: input.now,
    });

    const report = input.report?.body?.trim()
      ? await writeReportDoc(tx, {
          directive,
          object,
          runId,
          title: clip(input.report.title) ?? spec?.label ?? "Run report",
          body: input.report.body,
          now: input.now,
        })
      : undefined;

    const transition = input.outcome === "success" ? spec?.onSuccess : spec?.onFailure;
    let advanced: RunFinishedOk["advanced"];
    let notAdvanced: string | undefined;
    if (!transition) {
      notAdvanced = `the work order declares no transition for a ${input.outcome} outcome`;
    } else {
      const moved = await applyTransitionIn(tx, {
        objectId: object.id,
        transition,
        // The engine's own consequence of a run finishing - see the module header
        // on why this is `rule` and not `agent-run`.
        actor: { entrance: "rule", actorId: directive.actionId },
        now: input.now,
        derivedFrom: { run: runId, outcome: input.outcome, transition },
        eventPayload: {
          note: `${transition} after run ${input.outcome}`,
          run: runId,
          directive: directive.id,
          ...(report ? { report: report.objectId } : {}),
        },
      });
      if (moved.ok) {
        advanced = { transition, status: moved.object.status, replay: moved.replay };
      } else {
        // A refused transition is NOT swallowed. The run's outcome is recorded
        // either way, and the refusal is reported so the agent's log and the
        // response both say the consequence did not land - on a failure outcome
        // the directive is about to fail anyway, which raises the attention item.
        notAdvanced = `${transition} refused: ${moved.code} - ${moved.message}`;
        logger.warn(
          { run: runId, object: object.id, transition, code: moved.code },
          "runs: the outcome transition was refused",
        );
      }
    }

    logger.info(
      {
        run: runId,
        directive: directive.id,
        object: object.id,
        outcome: input.outcome,
        replay: !inserted,
        advanced: advanced?.transition ?? null,
        report: report?.objectId ?? null,
      },
      "runs: run finished",
    );
    return {
      ok: true as const,
      runId,
      objectId: object.id,
      outcome: input.outcome,
      replay: !inserted,
      ...(advanced ? { advanced } : {}),
      ...(notAdvanced ? { notAdvanced } : {}),
      ...(report ? { report } : {}),
    };
  });
}

/**
 * The run's product, as a `report` DOC.
 *
 * Through the ordinary kernel path and nothing special: `createObject` with a
 * DERIVED id (so a re-delivered report lands on the same row instead of minting a
 * twin), a `produces` edge from the object that dispatched the run, and an
 * `object-created` event carrying the run as its actor. A doc has no state machine
 * (decision 8), so there is no transition to run on it - its content and its
 * `published` field are plain writes, which is exactly what this is.
 *
 * The doc's TYPE is `report`, the type the demo workspace already arms for a dated
 * run product - so a run's report appears in the Library beside every other
 * report rather than in a category invented for it.
 */
async function writeReportDoc(
  tx: GraphExec,
  input: {
    directive: EffectDirective;
    object: GraphObject;
    runId: string;
    title: string;
    body: string;
    now: string;
  },
): Promise<{ objectId: string; created: boolean }> {
  const id = runReportDocId(input.runId);
  const existing = await graph.getObject(tx, id);
  if (!existing) {
    await graph.createObject(tx, {
      id,
      teamId: input.directive.teamId,
      archetype: "doc",
      type: "report",
      status: "current",
      title: input.title,
      payload: {
        // `source` is the STORED ARTIFACT FILE - the key the Library renders from
        // (`read.ts renderStored`), so a run's report reads like every other
        // product rather than needing a rendering special case. The run authored
        // the body; we author the machine head, which is the only part it could
        // not know (captain decision 6: front matter + Markdown, always).
        source: reportArtifact(input.title, input.body, input.runId, input.now),
        published: false,
        producedByRun: input.runId,
        producedByDirective: input.directive.id,
      },
      now: input.now,
    });
    // The object that dispatched the run PRODUCES its report - the same edge kind
    // a loop uses for its own products, so the System view and the Library find it
    // with no special case.
    await graph.upsertEdge(tx, {
      teamId: input.directive.teamId,
      kind: "produces",
      srcId: input.object.id,
      dstId: id,
      createdByEvent: input.directive.eventId,
      now: input.now,
    });
  }
  await graph.appendEvent(tx, {
    id: runEventId(input.runId, "report"),
    teamId: input.directive.teamId,
    objectId: id,
    kind: "object-created",
    origin: "derived",
    payload: {
      run: input.runId,
      directive: input.directive.id,
      dispatchedBy: input.object.id,
      note: `run ${input.runId} produced “${input.title}”`,
    },
    entrance: "agent-run",
    actorId: input.runId,
    ts: input.now,
  });
  return { objectId: id, created: !existing };
}

/**
 * Wrap a run's output as a v1 ARTIFACT FILE (captain decision 6: YAML front matter
 * + Markdown body, always - HTML is a render-side projection and never storage).
 *
 * Serialized through the shipped library rather than hand-assembled, so the head is
 * canonical and the round trip is the library's problem and not this module's. The
 * body is the run's own words, verbatim: we add a head, we do not rewrite content.
 */
function reportArtifact(title: string, body: string, runId: string, now: string): string {
  return serializeArtifact({
    frontMatter: {
      type: "report",
      title,
      createdAt: now,
      // Provenance IN the file, not only in the graph - an artifact that leaves this
      // database should still be able to say which run produced it.
      producedByRun: runId,
    },
    body: body.endsWith("\n") ? body : `${body}\n`,
  });
}

// ---- small local helpers ----

/** A run event's id. DERIVED from the run and the phase, so every write in this
 *  module is idempotent on re-delivery. Not exported: nothing outside this module
 *  should be able to mint one. */
function runEventId(runId: string, phase: "started" | "finished" | "report", outcome?: string): string {
  return derivedEventId({ run: runId, phase, ...(outcome ? { outcome } : {}) });
}

function finishedNote(
  outcome: RunOutcome,
  label: string | undefined,
  summary: string | null | undefined,
  exitCode: number | null | undefined,
): string {
  const what = label ?? "dispatched run";
  const said = clip(summary);
  if (outcome === "success") return said ? `run finished: ${what} — ${said}` : `run finished: ${what}`;
  const why = said ?? (typeof exitCode === "number" ? `exit ${exitCode}` : "no reason reported");
  return `run FAILED: ${what} — ${why}`;
}

/** Event payloads are read by humans in the Timeline and stored in a jsonb column;
 *  a run that printed a megabyte belongs in its report doc, not in every row. */
const SUMMARY_CAP = 600;

function clip(v: string | null | undefined): string | undefined {
  const s = (v ?? "").trim();
  if (!s) return undefined;
  return s.length > SUMMARY_CAP ? `${s.slice(0, SUMMARY_CAP)}…` : s;
}

function refuse(fail: RunFail): RunFail {
  logger.warn({ code: fail.code }, `runs: report refused - ${fail.message}`);
  return fail;
}
