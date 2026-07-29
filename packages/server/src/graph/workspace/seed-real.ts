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
 * artifact file   → a Doc typed by its REAL front-matter `type`, mapped through
 *                   `LIFECYCLE` below. Bodies live in the artifact store (R2) and
 *                   are NOT in the database, so these are metadata-only and say
 *                   so - that is why `bodyAvailable` exists.
 * PR URL in a run → a `pull-request` MIRROR via get-or-create, at status
 *                   `observed`: we saw it referenced, we did not observe its
 *                   merge state.
 *
 * ── where the gates come from ────────────────────────────────────────────────
 *
 * They are REAL. Production loops encode lifecycle in the artifact front-matter
 * `type` the server already indexes: Support Inbox Triage writes `needs_human` /
 * `escalation`, LinkedIn Repurposer writes `drafted` / `queued`, Housekeeper
 * writes `open` / `merged`. Every one of those becomes the corresponding gate
 * state, so the inbox at :3700 is the captain's actual waiting list.
 */
import { renderMarkdown, safeParseArtifact } from "@loopany/artifact-format";
import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { edges as edgesTable } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import { cronText } from "../../lib/format.js";
import { applyTransition } from "../applyTransition.js";
import { resetGraphDemo, type SeedResult } from "./seed.js";
import { DEMO_TEAM_ID, DEMO_TYPES } from "./specs.js";
import { readSnapshot, type ProdFile, type ProdLoop, type ProdRun, type ProdSnapshot } from "./pull-prod.js";

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
  type: "post" | "report" | "playbook" | "merge-review";
  /** Transitions to run, in order, from the type's initial state. */
  path: string[];
  gate: boolean;
}

const LIFECYCLE: Record<string, Lifecycle> = {
  // a person actively owes a decision
  needs_human: { type: "report", path: ["escalate"], gate: true },
  needs_followup: { type: "report", path: ["escalate"], gate: true },
  escalation: { type: "report", path: ["escalate"], gate: true },
  // written, waiting to be published
  drafted: { type: "post", path: ["draft-ready"], gate: true },
  queued: { type: "post", path: ["draft-ready"], gate: true },
  // a change waiting to be merged
  open: { type: "merge-review", path: ["submit"], gate: true },
  // settled
  merged: { type: "merge-review", path: ["submit", "approve"], gate: false },
  posted: { type: "post", path: ["draft-ready", "publish"], gate: false },
  live: { type: "post", path: ["draft-ready", "publish"], gate: false },
  shipped: { type: "playbook", path: ["ship"], gate: false },
  resolved: { type: "report", path: ["complete"], gate: false },
  significant: { type: "report", path: ["complete"], gate: false },
  report: { type: "report", path: ["complete"], gate: false },
  brief: { type: "report", path: ["complete"], gate: false },
  digest: { type: "report", path: ["complete"], gate: false },
  converters: { type: "report", path: ["complete"], gate: false },
  rollup: { type: "report", path: ["complete"], gate: false },
  up: { type: "report", path: ["complete"], gate: false },
  skipped: { type: "report", path: ["complete"], gate: false },
  dead: { type: "report", path: ["complete"], gate: false },
};

const FALLBACK_LIFECYCLE: Lifecycle = { type: "report", path: ["complete"], gate: false };

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
  const snap = options.snapshot ?? readSnapshot();
  const teamId = options.teamId ?? DEMO_TEAM_ID;
  if (options.reset !== false) await resetGraphDemo(teamId);

  const dropped = [...snap.dropped];
  const refusals: string[] = [];
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

  /** Run one transition; drain its engine-local actions so a later terminal
   *  transition is not blocked by an executor that does not exist yet. */
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
  }): Promise<boolean> => {
    const out = await applyTransition({
      objectId: input.objectId,
      transition: input.transition,
      actor: { entrance: input.entrance, actorId: input.actorId },
      now: input.now,
      ...(input.fields && Object.keys(input.fields).length ? { fields: input.fields } : {}),
      ...(input.note ? { eventPayload: { note: input.note } } : {}),
    });
    if (!out.ok) {
      refusals.push(`${input.label}.${input.transition} @ ${input.now}: ${out.code} - ${out.message}`);
      return false;
    }
    if (!input.keepPending) {
      for (const a of out.actions) await graph.markActionDelivered(undefined, a.id, input.now);
    }
    return true;
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

    await step({
      objectId: row.id,
      transition: "activate",
      entrance: "human",
      actorId: SEED_ACTOR,
      now: loop.createdAt,
      note: `armed ${loop.name}`,
      label: loop.name,
    });
  }

  // ---- 2. runs → transitions, chronologically per loop ----
  const prMirrors = new Map<string, string>(); // externalId → object id
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
          const { object } = await graph.getOrCreateMirror(undefined, {
            teamId,
            externalSource: "github",
            externalId,
            type: "pull-request",
            status: "observed",
            title: `PR #${externalId.split("/").pop()} · ${externalId.split("/").slice(0, 2).join("/")}`,
            payload: { sourceUrl: url, referencedBy: loop.name },
            now: run.ts,
          });
          mirrorId = object.id;
          prMirrors.set(externalId, mirrorId);
        }
        await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: objectId, dstId: mirrorId, now: run.ts });
      }
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
      status: "draft",
      title: `${loop.name} · task file`,
      payload: {
        source: taskFileArtifact(loop, body),
        loopKey: loop.id,
        prodPath: loop.taskFile,
        bodyAvailable: true,
        originalType: "task",
      },
      now: loop.updatedAt,
    });
    await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: objectId, dstId: doc.id, now: loop.updatedAt });
    await step({
      objectId: doc.id,
      transition: "ship",
      entrance: "agent-run",
      actorId: `loop-${loop.id}`,
      now: loop.updatedAt,
      note: "published its standing task file",
      label: `${loop.name} task file`,
    });
  }

  // ---- 4. artifact files → Docs / merge reviews, by their REAL lifecycle ----
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

    const doc = await graph.createObject(undefined, {
      teamId,
      archetype: lifecycle.type === "merge-review" ? "task" : "doc",
      type: lifecycle.type,
      status: initialStateFor(lifecycle.type),
      title,
      payload: {
        // No `source`: the BYTES live in the artifact store (R2), not in the
        // database, so there is nothing local to render. Saying so beats
        // fabricating a body.
        bodyAvailable: false,
        prodPath: file.path,
        sizeBytes: file.size,
        originalType: originalType ?? null,
        frontMatter: file.meta ?? null,
        loopKey: file.loopId,
      },
      now: when,
    });
    await graph.upsertEdge(undefined, { teamId, kind: "produces", srcId: objectId, dstId: doc.id, now: when });

    for (const [i, transition] of lifecycle.path.entries()) {
      const last = i === lifecycle.path.length - 1;
      const ok = await step({
        objectId: doc.id,
        transition,
        // A gate-closing transition is `human` by the spec's own contract.
        entrance: closingTransition(transition) ? "human" : "agent-run",
        actorId: closingTransition(transition) ? SEED_ACTOR : `loop-${file.loopId}`,
        now: when,
        ...(i === 0 ? { note: `produced ${file.path}` } : {}),
        // The gate's own review action is what the human is looking at, so it
        // stays PENDING for anything still waiting.
        keepPending: last && lifecycle.gate,
        label: title,
      });
      if (!ok) break;
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

function initialStateFor(type: Lifecycle["type"]): string {
  switch (type) {
    case "post":
      return "draft";
    case "report":
      return "drafting";
    case "playbook":
      return "draft";
    case "merge-review":
      return "queued";
  }
}

/** The transitions that close a gate. Their spec declares `entrance: "human"`,
 *  so the replay has to enter them that way or the seam refuses - correctly. */
function closingTransition(name: string): boolean {
  return name === "approve" || name === "publish" || name === "decide";
}

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
