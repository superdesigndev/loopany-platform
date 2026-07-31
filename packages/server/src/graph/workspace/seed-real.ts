/**
 * Graph v1 workspace demo - REPLAY the production snapshot through the kernel.
 *
 * Input is the local read-only snapshot (`pull-prod.ts`), never the network.
 * Output goes only to the local dev database. Nothing here invents content: a
 * row that has no clean mapping is DROPPED and reported (`SeedResult.dropped`),
 * which is the rule the brief set and the reason this file has so many explicit
 * little tables instead of one clever heuristic.
 *
 * ── the mapping ──────────────────────────────────────────────────────────────
 *
 * loop            → a `loop` Task with `cron` (design §4: a Loop IS a Task with
 *                   cron). `enabled=false` ends `paused`; `completed_at` set ends
 *                   `completed` (a closed loop that met its goal).
 * run             → transitions on that loop, replayed CHRONOLOGICALLY so every
 *                   `from` state is the one the previous run left:
 *                     exec  done      → fire (clock) + complete | stand-down
 *                     exec  error     → fire (clock) + fail
 *                     exec  canceled  → skip (clock)      [machine was asleep]
 *                     evolve          → evolve (agent-run)
 *                     edit            → edit   (human)
 *                   the run's `state` metrics ride as transition FIELDS, so the
 *                   event's diff carries the real metric movement; the run's own
 *                   `message` rides as the event note.
 * task file       → a `playbook` Doc carrying the REAL `task_file_content`. The
 *                   body is verbatim; a front-matter head is synthesized from the
 *                   loop's own columns because production task files predate the
 *                   v1 artifact format (formatting, not content).
 * artifact file   → a content Doc (no lifecycle - decision 8), plus a SHEPHERD
 *                   task when its real front-matter `type` says a person owes a
 *                   verdict. `LIFECYCLE` below is the whole mapping: which doc
 *                   type, whether `published` is set, and which shepherd walks
 *                   which transitions.
 * PR URL in a run → a `pull-request` MIRROR via get-or-create, at status
 *                   `observed`: we saw it referenced, we did not observe its
 *                   merge state.
 *
 * ── where the gates come from ────────────────────────────────────────────────
 *
 * They are REAL. Production loops encode lifecycle in the artifact front-matter
 * `type` the server already indexes: Support Inbox Triage writes `needs_human` /
 * `escalation`, LinkedIn Repurposer writes `drafted` / `queued`, Housekeeper
 * writes `open` / `merged`. Each of those mints a shepherd task parked in its
 * gate state, so the inbox at :3700 is the captain's actual waiting list - and
 * every item on it is a TASK, which is the whole point of decision 8.
 */
import { renderMarkdown, safeParseArtifact } from "@loopany/artifact-format";
import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { edges as edgesTable } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import { cronText } from "../../lib/format.js";
import { applyTransition } from "../applyTransition.js";
import { reviewRequest, waitOpen } from "../cli/verbs.js";
import { drainOutbox } from "../outbox/executor.js";
import { parsePrExternalId } from "../sensing/pr.js";
import { resetGraphDemo, type SeedResult } from "./seed.js";
import { DEMO_TEAM_ID, DEMO_TYPES, LOOP_SPEC, REVIEW_PRESETS, REVIEW_TYPE } from "./specs.js";
import { readSnapshot, type ProdFile, type ProdLoop, type ProdRun, type ProdSnapshot } from "./pull-prod.js";
import { restrictConfiguredSnapshot } from "./snapshot-scope.js";
import { MAX_BODY_BYTES, readCachedBody } from "./fetch-bodies.js";

const SEED_ACTOR = "u-demo-captain";

/**
 * Band is the System view's horizontal lane - LAYOUT ONLY, and the one editorial
 * judgement in this file. Keyed by the real loop name; anything unlisted lands in
 * `monitors`, which is where an always-on watcher belongs by default.
 */
const BAND_OF_LOOP: Record<string, string> = {
  "Support Inbox Triage": "bizops",
  "CRM daily run": "bizops",
  "Signup guard watch": "bizops",
  "Daily Converter Report (EN)": "bizops",
  "Daily Paid-Converter Behavior": "bizops",
  "Daily digest + A/B gate article": "bizops",
  "Upgrade-funnel daily loop": "bizops",

  Housekeeper: "engineering",
  "Daily react-doctor triage": "engineering",
  "React Doctor daily health": "engineering",
  "ENG-010 Frontend Error Triage (daily)": "engineering",
  "PostHog Session Watcher": "engineering",

  "Prompt-library build engine": "marketing",
  "LinkedIn Repurposer": "marketing",
  "Reddit Daily Brief (Superdesign AEO)": "marketing",
  "Reddit AI-citation daily brief": "marketing",
  "SEO Daily Engine": "marketing",
  "Design template reverse-engineering → resource corpus": "marketing",

  "PR #1085 edit-correction impact": "platform",
  "Prompt Library A/B Aftermath": "platform",
  "DS Article Perf Check": "platform",
};
const DEFAULT_BAND = "monitors";

/**
 * Real front-matter `type` → the registry type it becomes, the state it ends in,
 * and the transition path that gets it there. The `gate` column is what makes the
 * inbox real: those states are the gate states of their type's spec.
 *
 * An unlisted type falls through to `report` / `complete` and keeps its original
 * string in the payload, so nothing is lost and nothing is guessed.
 */
interface Lifecycle {
  /** The CONTENT type the artifact becomes. Always a doc - content has no
   *  lifecycle of its own (decision 8). */
  doc: "post" | "report" | "playbook";
  /** `published` is a plain field on the doc, so the settled flows set it here. */
  published: boolean;
  /**
   * The shepherd TASK that carries the human verdict, when this flow has one.
   * `path` is the transitions it walks; the LAST one is the gate-opening step
   * for a waiting item, or the closing verdict for one already settled.
   */
  shepherd?: { preset: "merge" | "publish" | "decision"; path: string[]; waiting: boolean };
}

const LIFECYCLE: Record<string, Lifecycle> = {
  // a person actively owes a decision — the shepherd stops at its gate state
  needs_human: { doc: "report", published: false, shepherd: { preset: "decision", path: ["submit"], waiting: true } },
  needs_followup: { doc: "report", published: false, shepherd: { preset: "decision", path: ["submit"], waiting: true } },
  escalation: { doc: "report", published: false, shepherd: { preset: "decision", path: ["submit"], waiting: true } },
  // written, waiting to be published
  drafted: { doc: "post", published: false, shepherd: { preset: "publish", path: ["submit"], waiting: true } },
  queued: { doc: "post", published: false, shepherd: { preset: "publish", path: ["submit"], waiting: true } },
  // a change waiting to be merged
  open: { doc: "playbook", published: false, shepherd: { preset: "merge", path: ["submit"], waiting: true } },
  // settled — the shepherd ran to its verdict, so the gate shows as cleared
  merged: { doc: "playbook", published: true, shepherd: { preset: "merge", path: ["submit", "approve"], waiting: false } },
  posted: { doc: "post", published: true, shepherd: { preset: "publish", path: ["submit", "approve"], waiting: false } },
  live: { doc: "post", published: true, shepherd: { preset: "publish", path: ["submit", "approve"], waiting: false } },
  shipped: { doc: "playbook", published: true, shepherd: { preset: "publish", path: ["submit", "approve"], waiting: false } },
  // plain products — no human ever owed anything, so no shepherd at all
  resolved: { doc: "report", published: true },
  significant: { doc: "report", published: true },
  report: { doc: "report", published: true },
  brief: { doc: "report", published: true },
  digest: { doc: "report", published: true },
  converters: { doc: "report", published: true },
  rollup: { doc: "report", published: true },
  up: { doc: "report", published: true },
  skipped: { doc: "report", published: true },
  dead: { doc: "report", published: true },
};

const FALLBACK_LIFECYCLE: Lifecycle = { doc: "report", published: true };

/**
 * Which waiting flows the ENGINE opens rather than the seeder: an unpublished
 * post awaiting a publish verdict, which is exactly what the loop's
 * `queue-review` selector (`specs.ts` LOOP_SPEC) declares it reviews.
 *
 * Only ONE flow, on purpose. The others are replayed HISTORY - a verdict that was
 * already given, or a review whose own gate-opening transition is part of a path
 * the seeder walks - and re-deriving those through the executor would fabricate
 * notifications for decisions that happened weeks ago. This one is the live path,
 * and one live path is what proves the mechanism.
 */
function queuedByEngine(lifecycle: Lifecycle): boolean {
  return lifecycle.shepherd?.preset === "publish" && lifecycle.shepherd.waiting === true;
}

/**
 * Is this loop still LIVE enough for its products to be handed to review?
 *
 * A loop whose real history ended in `completed` is terminal, and asking a
 * finished loop to request a review would attribute a live act to something that
 * has stopped. Those keep the seed-built review instead - an honest fallback
 * rather than a fabricated re-activation.
 */
async function canRequestReview(loopObjectId: string): Promise<boolean> {
  const loop = await graph.getObject(undefined, loopObjectId);
  if (!loop) return false;
  return !(LOOP_SPEC.terminalStates ?? []).includes(loop.status);
}

/** `task` front matter is the loop's own brief; it is seeded from
 *  `task_file_content` instead, so the synced copy would be a duplicate row. */
const SKIP_TYPES = new Set(["task"]);

const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

export interface RealSeedResult extends SeedResult {
  snapshot: { pulledAt: string; team: string; window: ProdSnapshot["window"] };
  /** Everything the REPLAY dropped, on top of what the pull already dropped. */
  dropped: { what: string; count: number; why: string }[];
}

export async function seedFromProdSnapshot(
  options: { snapshot?: ProdSnapshot; teamId?: string; reset?: boolean } = {},
): Promise<RealSeedResult> {
  // The SEED SCOPE (`LOOPANY_GRAPH_SEED_LOOPS`) is applied here because this is
  // the chokepoint every caller passes through - the CLI and the operator seed
  // endpoint alike - so a scoped deploy cannot be defeated by picking the other
  // door. It is pure and idempotent, so the route applying it first (to avoid
  // fetching bodies it will not seed) costs nothing here.
  const snap = restrictConfiguredSnapshot(options.snapshot ?? readSnapshot()).snapshot;
  const teamId = options.teamId ?? DEMO_TEAM_ID;
  if (options.reset !== false) await resetGraphDemo(teamId);

  const dropped = [...snap.dropped];
  const refusals: string[] = [];
  /** Unpublished posts handed to the `review request` VERB in step 5, instead of
   *  getting a seed-built review task here. */
  const engineQueued: { loopId: string; docId: string; title: string }[] = [];
  const bump = (what: string, why: string) => {
    const row = dropped.find((d) => d.what === what && d.why === why);
    if (row) row.count++;
    else dropped.push({ what, count: 1, why });
  };

  // ---- registry: archetype base types, then the demo's own ----
  const seedAt = earliest(snap.loops.map((l) => l.createdAt)) ?? snap.pulledAt;
  await graph.seedBuiltinTypes(undefined, teamId, seedAt);
  for (const t of DEMO_TYPES) {
    await graph.proposeTypeVersion(undefined, {
      teamId,
      name: t.name,
      archetype: t.archetype,
      version: 1,
      spec: t.spec,
      rationale: t.rationale,
      now: seedAt,
    });
    await graph.armTypeVersion(undefined, { teamId, name: t.name, version: 1, now: seedAt });
  }

  /**
   * Loop object id → the HUMAN event that armed it (its `activate`).
   *
   * A loop's `fire` declares an outward dispatch (R3), which cannot be
   * auto-approved (captain decision 2) - so a replayed fire names the same standing
   * approval a live one would: the arming act. Nothing outward happens here; the
   * replay's minimal executor stamps the action done without running the handler,
   * exactly as it does for every other action it replays.
   */
  const armEvents = new Map<string, string>();

  /** Run one transition; drain its engine-local actions so a later terminal
   *  transition is not blocked by an executor that does not exist yet. Returns the
   *  event id on success (truthy), so a caller can both branch on it and keep it. */
  const step = async (input: {
    objectId: string;
    transition: string;
    entrance: "human" | "agent-run" | "rule" | "clock";
    actorId: string;
    now: string;
    note?: string;
    fields?: Record<string, unknown>;
    keepPending?: boolean;
    label: string;
  }): Promise<string | undefined> => {
    const approval = armEvents.get(input.objectId);
    const out = await applyTransition({
      objectId: input.objectId,
      transition: input.transition,
      actor: { entrance: input.entrance, actorId: input.actorId },
      now: input.now,
      ...(input.fields && Object.keys(input.fields).length ? { fields: input.fields } : {}),
      ...(input.note ? { eventPayload: { note: input.note } } : {}),
      ...(approval ? { approvals: { 0: approval } } : {}),
    });
    if (!out.ok) {
      refusals.push(`${input.label}.${input.transition} @ ${input.now}: ${out.code} - ${out.message}`);
      return undefined;
    }
    if (!input.keepPending) {
      for (const a of out.actions) await graph.markActionDone(undefined, a.id, input.now);
    }
    return out.event.id;
  };

  // ---- 1. loops ----
  const loopObjectId = new Map<string, string>();
  const runsByLoop = groupBy(snap.runs, (r) => r.loopId);

  for (const loop of snap.loops) {
    const band = BAND_OF_LOOP[loop.name] ?? DEFAULT_BAND;
    const row = await graph.createObject(undefined, {
      teamId,
      archetype: "task",
      type: "loop",
      status: "planned",
      title: loop.name,
      cron: loop.cron,
      timezone: loop.timezone,
      payload: {
        band,
        kind: isSensor(loop.cron) ? "sensor" : "loop",
        cadence: loop.cron ? cronText(loop.cron) : "no schedule",
        stat: loopStat(loop),
        rank: 0, // densified per band by the read model
        runs: loop.runCount,
        agent: loop.agent,
        prodLoopId: loop.id,
        ...(loop.machineId ? { machineId: loop.machineId } : {}),
        ...(loop.goal ? { goal: loop.goal } : {}),
        ...(loop.state ? { metrics: loop.state } : {}),
      },
      now: loop.createdAt,
    });
    loopObjectId.set(loop.id, row.id);

    const armed = await step({
      objectId: row.id,
      transition: "activate",
      entrance: "human",
      actorId: SEED_ACTOR,
      now: loop.createdAt,
      note: `armed ${loop.name}`,
      label: loop.name,
    });
    // The cadence lands as CONFIGURATION (`cron` set, `next_fire` NOT): these are
    // real production loops, and importing one must never be the same act as
    // agreeing to run it here. `pnpm graph:schedule` is the deliberate arming step.
    if (armed) armEvents.set(row.id, armed);
  }

  // ---- 2. runs → transitions, chronologically per loop ----
  const prMirrors = new Map<string, string>(); // externalId → object id
  /** Loop object id → the PR mirrors IT first referenced. Only the discovering
   *  loop takes the wait: a PR mentioned again by a second loop is the same
   *  external fact, and two loops waiting on one merge would double-count it. */
  const watchedByLoop = new Map<string, string[]>();
  for (const loop of snap.loops) {
    const objectId = loopObjectId.get(loop.id)!;
    const runs = [...(runsByLoop.get(loop.id) ?? [])].sort((a, b) => a.ts.localeCompare(b.ts));

    for (const run of runs) {
      if (run.phase === "pending") {
        bump("runs", "still pending at pull time - nothing has happened to replay");
        continue;
      }
      const note = runNote(run);
      const fields = metricFields(run.state);

      if (run.role === "evolve") {
        await step({ objectId, transition: "evolve", entrance: "agent-run", actorId: `run-${run.id}`, now: run.ts, note, fields, label: loop.name });
      } else if (run.role === "edit") {
        await step({ objectId, transition: "edit", entrance: "human", actorId: SEED_ACTOR, now: run.ts, note, label: loop.name });
      } else if (run.phase === "canceled") {
        await step({ objectId, transition: "skip", entrance: "clock", actorId: `sched-${loop.id}`, now: run.ts, note, label: loop.name });
      } else {
        // An exec run is TWO events, which is what actually happened: the clock
        // fired it, then the agent reported back.
        const fired = await step({
          objectId,
          transition: "fire",
          entrance: "clock",
          actorId: `sched-${loop.id}`,
          now: run.ts,
          label: loop.name,
        });
        if (!fired) continue;
        const settle = run.phase === "error" ? "fail" : quiet(run) ? "stand-down" : "complete";
        await step({
          objectId,
          transition: settle,
          entrance: "agent-run",
          actorId: `run-${run.id}`,
          now: settleTs(run),
          note,
          fields,
          label: loop.name,
        });
      }

      // Every PR the run referenced becomes a mirror, get-or-create.
      for (const [externalId, url] of prReferences(run.message)) {
        let mirrorId = prMirrors.get(externalId);
        if (!mirrorId) {
          const identity = parsePrExternalId(externalId);
          const { object } = await graph.getOrCreateMirror(undefined, {
            teamId,
            externalSource: "github",
            externalId,
            type: "pull-request",
            status: "observed",
            title: `PR #${externalId.split("/").pop()} · ${externalId.split("/").slice(0, 2).join("/")}`,
            // `repo`/`number` are the identity `PULL_REQUEST_SPEC` declares as
            // fields, so they are stored rather than left implicit in the
            // external id - the poller reads them straight off the payload.
            payload: {
              ...(identity ? { repo: identity.repo, number: identity.number } : {}),
              sourceUrl: url,
              referencedBy: loop.name,
            },
            now: run.ts,
          });
          mirrorId = object.id;
          prMirrors.set(externalId, mirrorId);
          watchedByLoop.set(objectId, [...(watchedByLoop.get(objectId) ?? []), mirrorId]);
        }
        await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: objectId, dstId: mirrorId, now: run.ts });
      }
    }

    // ── the standing wait on every PR this loop opened ───────────────────────
    //
    // THROUGH THE VERB, not a declared chain (captain decisions 15 + 16). This
    // used to run a `watch-prs` self-transition whose `register-watch` action
    // fanned out over the loop's `produces` edges; that is spec-declared
    // sequencing, so it is gone and the seeder calls the same `wait open` verb a
    // run would - which also means the seeded waits carry a NAMED WATCHER
    // (decision 13), which the old chain could not express at all.
    //
    // The watcher is the loop itself: it is the thing already observing that
    // source on its cadence, which is decision 13's stated default.
    const watched = watchedByLoop.get(objectId);
    for (const mirrorId of watched ?? []) {
      const opened = await waitOpen(
        {
          teamId,
          actor: { entrance: "agent-run", actorId: `run-watch-${loop.id}` },
          subjectId: objectId,
          now: latestRunTs(runs) ?? loop.updatedAt,
        },
        {
          objectId: mirrorId,
          key: "merge-wait",
          question: "Has GitHub shown this pull request merged?",
          watcherId: objectId,
          label: "Waiting for GitHub to show the PR merged",
        },
      );
      if (!opened.ok) bump("pr watches", `${opened.code}: ${opened.message}`);
    }

    // The loop's REAL end state.
    if (loop.completedAt) {
      await step({
        objectId,
        transition: "finish",
        entrance: "agent-run",
        actorId: `run-finish-${loop.id}`,
        now: loop.completedAt,
        note: loop.completionReason ?? "goal met",
        label: loop.name,
      });
    } else if (!loop.enabled) {
      await step({ objectId, transition: "pause", entrance: "human", actorId: SEED_ACTOR, now: loop.updatedAt, note: "paused by the owner", label: loop.name });
    }
  }

  // ---- 3. task files → playbook Docs with the REAL body ----
  for (const loop of snap.loops) {
    const body = loop.taskFileContent;
    if (!body || body.trim().length === 0) {
      bump("task files", "the loop has no synced task-file content");
      continue;
    }
    const objectId = loopObjectId.get(loop.id)!;
    const doc = await graph.createObject(undefined, {
      teamId,
      archetype: "doc",
      type: "playbook",
      status: "current",
      title: `${loop.name} · task file`,
      payload: {
        source: taskFileArtifact(loop, body),
        loopKey: loop.id,
        prodPath: loop.taskFile,
        bodyAvailable: true,
        // A standing brief is live content, not something awaiting a verdict:
        // it gets no shepherd, and `published` is simply true.
        published: true,
        version: 1,
        originalType: "task",
      },
      now: loop.updatedAt,
    });
    await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: objectId, dstId: doc.id, now: loop.updatedAt });
  }

  // ---- 4. artifact files → a content Doc, plus a shepherd TASK when a
  //         person owes a verdict on it ----
  for (const file of snap.files) {
    const objectId = loopObjectId.get(file.loopId);
    if (!objectId) {
      bump("artifact files", "belongs to a loop outside the pulled team");
      continue;
    }
    const originalType = file.meta?.type;
    if (originalType && SKIP_TYPES.has(originalType)) {
      bump("artifact files", "front-matter type `task` - seeded from the loop's task_file_content instead");
      continue;
    }
    const lifecycle = (originalType && LIFECYCLE[originalType]) || FALLBACK_LIFECYCLE;
    const title = file.meta?.title ?? titleFromPath(file.path);
    const when = file.meta?.date ? `${file.meta.date}T12:00:00Z` : file.updatedAt;

    // The REAL bytes, if `pnpm graph:bodies` has fetched them. Absent is a
    // legitimate outcome (never synced, GC'd, binary, or over the inline cap) and
    // the Library says so rather than pretending the document is empty.
    const body = readCachedBody(file.hash);
    const absentReason = body ? undefined : bodyAbsentReason(file);
    if (absentReason) bump("artifact bodies", absentReason);

    const doc = await graph.createObject(undefined, {
      teamId,
      archetype: "doc",
      type: lifecycle.doc,
      status: "current", // docs have one nominal state and no transitions
      title,
      payload: {
        ...(body ? { source: body } : {}),
        bodyAvailable: Boolean(body),
        ...(absentReason ? { bodyAbsentReason: absentReason } : {}),
        // `published` is a FIELD (decision 8), not a state. A shepherd's
        // approving transition flips it through an `update-fields` action.
        published: lifecycle.published,
        version: 1,
        prodPath: file.path,
        sizeBytes: file.size,
        originalType: originalType ?? null,
        frontMatter: file.meta ?? null,
        loopKey: file.loopId,
      },
      now: when,
    });
    await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: objectId, dstId: doc.id, now: when });

    if (!lifecycle.shepherd) continue;

    // THE ENGINE-CREATED PATH. A post still awaiting a publish verdict does NOT
    // get a hand-built shepherd: the producing loop runs `queue-review` below and
    // the OUTBOX EXECUTOR creates it through `applyTransition`. Same end state,
    // real provenance - the review exists because a rule fired, which is how it
    // will work when the product is live and no seeder is involved.
    //
    // Gated on the loop actually being able to run that transition. `queue-review`
    // goes from `idle`/`paused`, and a loop whose real history ended in
    // `completed` is terminal - so those keep the seeded path. Deciding it HERE
    // (the loop's status is already final by now) rather than reacting to a
    // refusal later is what keeps the waiting item from being lost either way: a
    // truncated archive is fine, a truncated inbox is a lie.
    if (queuedByEngine(lifecycle) && (await canRequestReview(objectId))) {
      engineQueued.push({ loopId: objectId, docId: doc.id, title });
      continue;
    }

    // The verdict lives on a small TASK that tracks the content - the same
    // relationship a merge review has with a pull request.
    const shepherd = await graph.createObject(undefined, {
      teamId,
      archetype: "task",
      type: REVIEW_TYPE,
      status: "queued",
      title,
      payload: {
        loopKey: file.loopId,
        reviews: doc.id,
        subject: doc.id,
        preset: lifecycle.shepherd.preset,
        question: `Your verdict on “${title}”`,
        ...REVIEW_PRESETS[lifecycle.shepherd.preset]!.payload,
        prodPath: file.path,
      },
      now: when,
    });
    await graph.upsertEdge(undefined, { teamId, kind: "tracks", srcId: shepherd.id, dstId: doc.id, now: when });
    await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: objectId, dstId: shepherd.id, now: when });

    for (const [i, transition] of lifecycle.shepherd.path.entries()) {
      const last = i === lifecycle.shepherd.path.length - 1;
      const human = HUMAN_VERDICTS.has(transition);
      const ok = await step({
        objectId: shepherd.id,
        transition,
        // A gate state's outgoing transition is `human` by the spec's contract.
        entrance: human ? "human" : "agent-run",
        actorId: human ? SEED_ACTOR : `loop-${file.loopId}`,
        now: when,
        ...(i === 0 ? { note: `produced ${file.path}` } : {}),
        // What a person is still looking at stays PENDING; a settled flow's
        // consequences are applied, including the `published` field write.
        keepPending: last && lifecycle.shepherd.waiting,
        label: title,
      });
      if (!ok) break;
    }
  }

  // ---- 5. hand the unpublished posts to review, THROUGH THE VERB ----
  //
  // This is the live flow, not a fixture - and since decisions 15 + 16 the live
  // flow is a verb call, not a declared chain. It used to run `queue-review` on
  // the loop, whose `enqueue-review` action fanned out over its `produces` edges
  // and had the executor create one shepherd per unpublished post. That is
  // exactly the spec-declared sequencing decision 15 moves into the agent, so the
  // seeder now calls `review request` per post with the PRODUCING RUN as the
  // actor - the same call, with the same provenance, that a real discovery run
  // makes from the CLI.
  for (const { loopId, docId, title } of engineQueued) {
    const requested = await reviewRequest(
      {
        teamId,
        actor: { entrance: "agent-run", actorId: `run-review-${loopId}` },
        subjectId: loopId,
        now: new Date().toISOString(),
      },
      {
        aboutId: docId,
        preset: "publish",
        question: `Ready to publish “${title}”?`,
        title,
      },
    );
    if (!requested.ok) bump("review handoff", `${requested.code}: ${requested.message}`);
  }
  // Drain what the reviews enqueued. The background executor would pick these up
  // within a tick anyway; draining here means `pnpm graph:seed` leaves a
  // CONSISTENT workspace rather than one that becomes consistent shortly after
  // the server starts.
  if (engineQueued.length) {
    const drained = await drainOutbox({ now: new Date().toISOString(), teamId, limit: 100, maxPasses: 50 });
    if (drained.deadLettered) {
      bump("review handoff", `${drained.deadLettered} action(s) dead-lettered - see the Attention section`);
    }
  }

  // ---- tally ----
  const objects = await graph.listObjects(undefined, teamId);
  const edges = await db.select().from(edgesTable).where(eq(edgesTable.teamId, teamId));
  const open = await graph.listOpenObligations(undefined, teamId);
  const pending = await graph.listPendingActions(undefined, { teamId });
  return {
    teamId,
    objects: objects.length,
    edges: edges.length,
    events: await graph.countEvents(undefined, teamId),
    openObligations: open.length,
    pendingActions: pending.length,
    refusals,
    dropped,
    snapshot: { pulledAt: snap.pulledAt, team: `${snap.team.name} (${snap.team.id})`, window: snap.window },
  };
}

// ---- small, explicit helpers ----

/** An hour field of `*` means it runs many times a day - a sensor, not a loop
 *  that produces one product per run. Derived from the real cron, not a list. */
function isSensor(cron: string | null): boolean {
  if (!cron) return false;
  const hour = cron.trim().split(/\s+/)[1];
  return hour === "*" || /^\*\//.test(hour ?? "");
}

const HUMAN_VERDICTS = new Set(["approve", "dispatch", "reject"]);

/** A run that reported nothing new. Both signals are real columns. */
function quiet(run: ProdRun): boolean {
  return run.status === "nothing-new" || run.outcome === "silent";
}

/** When the agent reported back. `duration_ms` is real; without it the report
 *  lands one second after the fire so the two events never collide. */
function settleTs(run: ProdRun): string {
  const started = Date.parse(run.ts);
  const ms = run.durationMs && run.durationMs > 0 ? run.durationMs : 1000;
  return new Date(started + ms).toISOString();
}

/** The Timeline line. The run's own message, first paragraph, clipped - never
 *  rewritten. Falls back to the error, then to nothing (the diff still speaks). */
function runNote(run: ProdRun): string | undefined {
  const raw = run.message?.trim() || run.error?.trim();
  if (!raw) return undefined;
  const firstBlock = raw.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
  return firstBlock.length > 240 ? `${firstBlock.slice(0, 237)}…` : firstBlock;
}

/** A run's metric state becomes transition FIELDS, so the event diff carries the
 *  real movement (`payload.backlog: 6 → 5`). Scalars only - a nested blob would
 *  make the diff unreadable without adding information. */
function metricFields(state: Record<string, unknown> | null): Record<string, unknown> {
  if (!state) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= 120) out[k] = v;
  }
  return out;
}

function loopStat(loop: ProdLoop): string {
  const metrics = metricFields(loop.state);
  const shown = Object.entries(metrics)
    .slice(0, 3)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(" · ");
  const cadence = loop.cron ? cronText(loop.cron) : "unscheduled";
  return shown ? `${cadence} · ${shown}` : `${cadence} · ${loop.runCount} runs`;
}

/** The last instant this loop actually did something - when the standing PR watch
 *  is stamped as opened. Falls back to the loop's own `updatedAt` at the caller. */
function latestRunTs(runs: ProdRun[]): string | undefined {
  return runs.length ? runs[runs.length - 1]!.ts : undefined;
}

function* prReferences(message: string | null): Generator<[string, string]> {
  if (!message) return;
  PR_URL.lastIndex = 0;
  const seen = new Set<string>();
  for (const m of message.matchAll(PR_URL)) {
    const externalId = `${m[1]}/${m[2]}/pull/${m[3]}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    yield [externalId, m[0]];
  }
}

/** Why an artifact has no local body. Every one of these is a real condition,
 *  and the Library shows the reason rather than a bare blank. */
function bodyAbsentReason(file: ProdFile): string {
  if (file.binary) return "binary file - no readable document";
  if (file.size > MAX_BODY_BYTES) return `over the ${MAX_BODY_BYTES}-byte inline cap`;
  return "bytes not in the local cache - run `pnpm graph:bodies`, or they are no longer in the artifact store";
}

function titleFromPath(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.[a-z]+$/i, "").replace(/[-_]/g, " ");
}

/**
 * Production task files predate the v1 artifact format, so they carry no front
 * matter. Synthesize the head from the loop's OWN columns and keep the body byte
 * for byte - the content is untouched, only the machine head is added.
 */
function taskFileArtifact(loop: ProdLoop, body: string): string {
  const head = [
    "type: playbook",
    `title: ${JSON.stringify(`${loop.name} · task file`)}`,
    `loop: ${JSON.stringify(loop.name)}`,
    ...(loop.taskFile ? [`path: ${JSON.stringify(loop.taskFile)}`] : []),
    `updatedAt: ${JSON.stringify(loop.updatedAt)}`,
  ].join("\n");
  const artifact = `---\n${head}\n---\n\n${body}\n`;
  // Prove the synthesized head parses before it is stored; a malformed head
  // would only surface later as a blank Library row.
  const parsed = safeParseArtifact(artifact);
  if (!parsed.ok) {
    // Fall back to rendering the body alone rather than storing something the
    // reader will choke on.
    return `---\ntype: playbook\ntitle: ${JSON.stringify(`${loop.name} · task file`)}\n---\n\n${stripFrontMatter(body)}\n`;
  }
  return artifact;
}

/** Defensive: if a task file DOES already open with `---`, the synthesized head
 *  would make two blocks. Drop the inner one in that (rare) fallback path. */
function stripFrontMatter(body: string): string {
  if (!body.startsWith("---")) return body;
  const end = body.indexOf("\n---", 3);
  return end === -1 ? body : body.slice(end + 4);
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

function earliest(values: string[]): string | undefined {
  return values.length ? values.reduce((a, b) => (a < b ? a : b)) : undefined;
}

export { renderMarkdown };
