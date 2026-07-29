/**
 * Graph Engineering v1 workspace demo - the READ MODEL.
 *
 * Four projections over the kernel tables, one per view, plus the single honest
 * WRITE path (`recordVerdict`). Everything here derives from real rows:
 *
 *   System   objects + edges. Gate nodes are NOT stored - they are computed from
 *            `gate_obligations` over each loop's products, which is the design's
 *            own claim ("the inbox is computed opened-minus-closed") drawn as a
 *            graph. A loop is never itself "waiting on you"; its products are.
 *   Library  doc objects (+ merge reviews standing in front of their PR mirror).
 *            Body HTML is rendered from the STORED artifact file through
 *            `@loopany/artifact-format` - a sanitized projection, never storage.
 *   Timeline the `events` table, newest first. The prose comes out of the event
 *            payload and the per-field diff, so the feed is the audit log.
 *   Inbox    `listOpenObligations(class: "human-verdict")`, resolved to the
 *            object that owes the verdict and the transition that discharges it.
 *
 * `recordVerdict` is the one write: it resolves the gate-closing transition from
 * the EFFECTIVE type spec and runs it through `applyTransition` with
 * `entrance: "human"`. It cannot invent a transition, cannot close an obligation
 * out of band, and cannot move an object that is not sitting in a gate state -
 * all three are refused by the seam, not by this module.
 */
import { desc, eq } from "drizzle-orm";

import { renderArtifactBody, safeParseArtifact } from "@loopany/artifact-format";

import { db } from "../../db/index.js";
import {
  edges as edgesTable,
  events as eventsTable,
  gateObligations as gateObligationsTable,
  type GateObligation,
  type GraphEdge,
  type GraphObject,
} from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import { applyTransition, type ApplyTransitionResult } from "../applyTransition.js";
import type { TypeSpec } from "../types.js";
import { CATEGORY_OF_TYPE, DEMO_TEAM_ID, DEMO_USER_ID, LIBRARY_CATEGORIES } from "./specs.js";

// ---- shared loading ----

interface Loaded {
  objects: GraphObject[];
  byId: Map<string, GraphObject>;
  edges: GraphEdge[];
  obligations: GateObligation[];
  /** The newest event instant in the workspace - the demo's "now", so relative
   *  ages stay stable no matter when the demo is run. */
  now: number;
}

async function load(teamId: string): Promise<Loaded> {
  const objects = await graph.listObjects(undefined, teamId);
  const edges = await db.select().from(edgesTable).where(eq(edgesTable.teamId, teamId));
  const obligations = await db.select().from(gateObligationsTable).where(eq(gateObligationsTable.teamId, teamId));
  const newest = (
    await db.select().from(eventsTable).where(eq(eventsTable.teamId, teamId)).orderBy(desc(eventsTable.ts)).limit(1)
  )[0];
  return {
    objects,
    byId: new Map(objects.map((o) => [o.id, o])),
    edges,
    obligations,
    now: newest ? Date.parse(newest.ts) : Date.now(),
  };
}

/** `produces` edges, indexed loop id → product ids. */
function productIndex(edges: GraphEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "produces") continue;
    out.set(e.srcId, [...(out.get(e.srcId) ?? []), e.dstId]);
  }
  return out;
}

/** Product id → the loop that produced it. */
function producerIndex(edges: GraphEdge[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of edges) if (e.kind === "produces") out.set(e.dstId, e.srcId);
  return out;
}

const payloadOf = (o: GraphObject) => (o.payload ?? {}) as Record<string, unknown>;
const num = (v: unknown, fallback = 0) => (typeof v === "number" ? v : fallback);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// ---- System ----

export type SystemNodeKind = "sensor" | "loop" | "gate" | "human" | "machine";

export interface SystemNode {
  id: string;
  kind: SystemNodeKind;
  name: string;
  eyebrow: string;
  stat: string;
  badge?: string;
  rank: number;
  yOffset?: number;
  planned?: boolean;
  activity?: "running" | "waiting" | "idle" | "online";
  band: string;
  bandLabel?: string;
  waiting?: number;
  /** Library artifact ids this node opens (a gate opens what it is holding). */
  artifactIds?: string[];
}

export interface SystemEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  /** A relation (drawn as a dashed arc) rather than pipeline flow. */
  relation?: boolean;
  /** Touches the shared people/machines band. */
  shared?: boolean;
  /** Either end is a planned class. */
  planned?: boolean;
  animated?: boolean;
}

export interface SystemView {
  nodes: SystemNode[];
  edges: SystemEdge[];
  bands: string[];
}

const BAND_ORDER = ["platform", "engineering", "marketing", "bizops", "monitors", "shared"];
const BAND_LABEL: Record<string, string> = {
  platform: "Platform",
  engineering: "Engineering",
  marketing: "Marketing",
  bizops: "Bizops",
  monitors: "Monitors",
};

/** What the gate holding these objects is called. Derived from what is actually
 *  waiting, so a new artifact type names its own gate without a lookup table. */
function gateName(types: Set<string>): string {
  if (types.has("merge-review")) return "Merge gate";
  if (types.has("post")) return "Publish gate";
  if (types.has("playbook")) return "Ship gate";
  if (types.has("report")) return "Your call";
  return "Review gate";
}

export async function systemView(teamId = DEMO_TEAM_ID): Promise<SystemView> {
  const { objects, byId, edges, obligations } = await load(teamId);
  const products = productIndex(edges);
  const loops = objects.filter((o) => o.type === "loop");

  const nodes: SystemNode[] = [];
  const outEdges: SystemEdge[] = [];
  const firstOfBand = new Set<string>();

  for (const loop of loops) {
    const p = payloadOf(loop);
    const band = str(p.band) ?? "platform";
    const planned = loop.status === "planned";
    const bandLabel = !firstOfBand.has(band) && !planned ? BAND_LABEL[band] : undefined;
    if (bandLabel) firstOfBand.add(band);
    nodes.push({
      id: loop.id,
      kind: str(p.kind) === "sensor" ? "sensor" : "loop",
      name: loop.title ?? "loop",
      eyebrow: str(p.cadence) ?? "loop class",
      stat: str(p.stat) ?? "",
      ...(planned ? {} : { badge: String(num(p.runs)) }),
      rank: num(p.rank),
      ...(p.yOffset ? { yOffset: num(p.yOffset) } : {}),
      ...(planned ? { planned: true } : {}),
      activity: planned ? undefined : loop.status === "running" ? "running" : "idle",
      band,
      ...(bandLabel ? { bandLabel } : {}),
    });
  }

  // ---- derived gate nodes: one per loop that holds (or has held) obligations ----
  for (const loop of loops) {
    const scope = new Set<string>([loop.id, ...(products.get(loop.id) ?? [])]);
    const held = obligations.filter((o) => scope.has(o.objectId));
    if (!held.length) continue;
    const open = held.filter((o) => o.closedByEvent === null);
    const types = new Set(held.map((o) => byId.get(o.objectId)?.type ?? "").filter(Boolean));
    const gateId = `gate:${loop.id}`;
    const p = payloadOf(loop);
    nodes.push({
      id: gateId,
      kind: "gate",
      name: gateName(types),
      eyebrow: `${loop.title} · gate class`,
      stat: open.length ? `${open.length} waiting on you` : "Clear",
      badge: String(open.length),
      rank: num(p.rank) + 0.5,
      ...(p.yOffset ? { yOffset: num(p.yOffset) } : {}),
      activity: open.length ? "waiting" : "idle",
      band: str(p.band) ?? "platform",
      waiting: open.length,
      artifactIds: open.map((o) => o.objectId),
    });
    outEdges.push({
      id: `e-gate-${loop.id}`,
      source: loop.id,
      target: gateId,
      label: "produces",
      animated: open.length > 0,
    });
    outEdges.push({ id: `e-you-${loop.id}`, source: gateId, target: "you", label: "needs verdict", shared: true, animated: open.length > 0 });
  }

  // ---- the shared band: the person and the machines ----
  const openHuman = obligations.filter((o) => o.closedByEvent === null && o.class === "human-verdict");
  const activeLoops = loops.filter((l) => l.status !== "planned");
  // Real machine count when the loops carry their binding (a pulled workspace
  // does); otherwise the fleet is described by what it runs, not by a guess.
  const machineIds = new Set(loops.map((l) => str(payloadOf(l).machineId)).filter(Boolean));
  nodes.push({
    id: "you",
    kind: "human",
    name: "Human reviewer",
    eyebrow: "human role class",
    stat: `${openHuman.length} decisions waiting`,
    badge: String(openHuman.length),
    rank: 3,
    activity: "online",
    band: "shared",
  });
  nodes.push({
    id: "machine",
    kind: "machine",
    name: machineIds.size ? `Machine fleet ×${machineIds.size}` : "Machine fleet",
    eyebrow: "machine role class",
    stat: `Runs ${activeLoops.length} armed loop classes`,
    badge: String(machineIds.size || activeLoops.length),
    rank: 1,
    activity: "online",
    band: "shared",
  });
  // One machine link per band, to the band's first armed class - enough to show
  // where execution lives without drawing 23 identical edges.
  const seenBand = new Set<string>();
  for (const loop of activeLoops) {
    const band = str(payloadOf(loop).band) ?? "platform";
    if (seenBand.has(band)) continue;
    seenBand.add(band);
    outEdges.push({ id: `e-machine-${loop.id}`, source: "machine", target: loop.id, label: `runs ${band}`, relation: true, shared: true });
  }

  // ---- real edges between loop classes ----
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (e.kind !== "feeds" && e.kind !== "informs") continue;
    if (!nodeIds.has(e.srcId) || !nodeIds.has(e.dstId)) continue;
    const plannedEnd = byId.get(e.srcId)?.status === "planned" || byId.get(e.dstId)?.status === "planned";
    outEdges.push({
      id: e.id,
      source: e.srcId,
      target: e.dstId,
      label: str((e.meta as Record<string, unknown> | null)?.label) ?? e.kind,
      ...(e.kind === "informs" ? { relation: true } : {}),
      ...(plannedEnd ? { planned: true } : {}),
      animated: e.kind === "feeds" && !plannedEnd,
    });
  }

  nodes.sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band) || a.rank - b.rank);
  return { nodes: assignColumns(nodes), edges: outEdges, bands: BAND_ORDER };
}

/**
 * Collapse the seeded ranks (which carry `+0.5` for every derived gate) into
 * dense integer COLUMNS per band row, so no two nodes ever land on top of each
 * other. It has to happen after the gates are derived, because how many gate
 * nodes a band grows is a property of the data, not of the fleet definition.
 *
 * Rows are split by `yOffset`: the main row and the planned second row lay out
 * independently, exactly as the reference demo did by hand.
 */
function assignColumns(nodes: SystemNode[]): SystemNode[] {
  const groups = new Map<string, SystemNode[]>();
  for (const n of nodes) {
    const key = `${n.band}:${n.yOffset ?? 0}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.rank - b.rank);
    // The planned second row is sparse, so spread it across the band instead of
    // bunching it under the first few columns.
    const spread = group[0]?.yOffset ? 2 : 1;
    group.forEach((n, i) => {
      n.rank = i * spread + (spread > 1 ? 0.5 : 0);
    });
  }
  return nodes;
}

// ---- Library ----

export interface LibraryArtifact {
  id: string;
  category: string;
  title: string;
  /** The loop that produced it. */
  source: string;
  /** Display label for the object's current state. */
  state: string;
  age: string;
  icon: "pr" | "post" | "report" | "doc";
  kind: "document" | "mirror";
  /** Sanitized HTML, rendered from the stored artifact file. Absent for a mirror. */
  html?: string;
  /** External link, for a merge review standing in front of its PR mirror. */
  sourceUrl?: string;
  externalLabel?: string;
  needsHuman: boolean;
  /** The verdict this artifact is waiting for, if any - label plus the exact
   *  transition `POST /api/graph/verdict` will run. */
  verdict?: { transition: string; label: string; obligation: string };
  /**
   * False when the artifact's BYTES are not in this database. Real production
   * products live in the artifact store (R2) and only their front-matter index
   * is in Postgres, so a pulled workspace has the title, type and date but no
   * body. The preview says so instead of rendering an empty document.
   */
  bodyAvailable: boolean;
  /** The artifact's real path in its loop folder, when it has one. */
  path?: string;
  /** The producing loop's own front-matter `type` (`needs_human`, `drafted`,
   *  `merged`, …). Kept verbatim: the registry type is a mapping, not a rename. */
  originalType?: string;
}

export interface LibraryView {
  categories: string[];
  artifacts: LibraryArtifact[];
  needsYou: number;
  /** Total artifacts in the workspace; `artifacts` may be capped below it. */
  total: number;
  /** How many were left out of this page, so a large real workspace never looks
   *  smaller than it is. Items needing a human are NEVER capped away. */
  truncated: number;
}

/** Settled artifacts served per request. Anything holding an open obligation is
 *  exempt - the inbox must be complete even when the archive is not. */
const LIBRARY_SETTLED_CAP = 90;

const ICON_OF_TYPE: Record<string, LibraryArtifact["icon"]> = {
  "merge-review": "pr",
  post: "post",
  report: "report",
  playbook: "doc",
};

/** Status → the label the Library shows. Derived per type so a state the demo
 *  never reaches still renders honestly (its own status, humanized). */
function stateLabel(object: GraphObject, mirror?: GraphObject): string {
  if (object.type === "merge-review") {
    if (object.status === "awaiting-verdict") return humanize(mirror?.status ?? "open");
    return humanize(object.status);
  }
  return humanize(object.status);
}

function humanize(s: string): string {
  return s.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Verdict labels, keyed by the obligation the transition closes. */
const VERDICT_LABEL: Record<string, string> = {
  "merge-verdict": "Approve",
  "publish-verdict": "Review",
  "ship-verdict": "Review",
  "policy-verdict": "Your call",
};

/**
 * The transition that discharges an open obligation, resolved from the object's
 * EFFECTIVE type spec: the one transition out of the object's current state that
 * closes this key. Nothing is hardcoded - a new type gets its verdict button for
 * free, and a spec with no such transition simply offers none.
 */
function verdictTransition(spec: TypeSpec, status: string, key: string): string | undefined {
  return spec.transitions.find((t) => t.from.includes(status) && (t.closes ?? []).includes(key))?.name;
}

function relativeAge(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export async function libraryView(teamId = DEMO_TEAM_ID): Promise<LibraryView> {
  const { objects, byId, edges, obligations, now } = await load(teamId);
  const producer = producerIndex(edges);
  const openByObject = new Map<string, GateObligation>();
  for (const o of obligations) if (o.closedByEvent === null) openByObject.set(o.objectId, o);

  // A merge review points at its mirror through a `tracks` edge.
  const tracks = new Map<string, string>();
  for (const e of edges) if (e.kind === "tracks") tracks.set(e.srcId, e.dstId);

  const specCache = new Map<string, TypeSpec | undefined>();
  const specOf = async (type: string): Promise<TypeSpec | undefined> => {
    if (!specCache.has(type)) specCache.set(type, (await graph.getEffectiveType(undefined, teamId, type))?.spec);
    return specCache.get(type);
  };

  const artifacts: LibraryArtifact[] = [];
  for (const o of objects) {
    const category = CATEGORY_OF_TYPE[o.type];
    if (!category) continue; // loops and raw mirrors are not Library rows

    const p = payloadOf(o);
    const loopId = producer.get(o.id);
    const source = (loopId && byId.get(loopId)?.title) ?? "unknown loop";
    const mirror = tracks.has(o.id) ? byId.get(tracks.get(o.id)!) : undefined;
    const open = openByObject.get(o.id);

    let verdict: LibraryArtifact["verdict"];
    if (open) {
      const spec = await specOf(o.type);
      const transition = spec ? verdictTransition(spec, o.status, open.key) : undefined;
      if (transition) verdict = { transition, label: VERDICT_LABEL[open.key] ?? "Decide", obligation: open.key };
    }

    const isMirrorFronted = o.type === "merge-review";
    const externalUrl = str((mirror?.payload as Record<string, unknown> | null)?.sourceUrl);
    const bodyAvailable = typeof p.source === "string";
    artifacts.push({
      id: o.id,
      category,
      title: o.title ?? o.id,
      source,
      state: stateLabel(o, mirror),
      age: relativeAge(o.statusChangedAt, now),
      icon: ICON_OF_TYPE[o.type] ?? "doc",
      // A row is only "mirror" (external, not previewable) when it really has an
      // external link. A merge review with no observed PR is still a document.
      kind: isMirrorFronted && externalUrl ? "mirror" : "document",
      ...(isMirrorFronted && externalUrl
        ? { sourceUrl: externalUrl, externalLabel: "View on GitHub" }
        : { html: bodyAvailable ? renderStored(p.source) : undefined }),
      needsHuman: Boolean(open),
      ...(verdict ? { verdict } : {}),
      bodyAvailable,
      ...(str(p.prodPath) ? { path: str(p.prodPath) } : {}),
      ...(str(p.originalType) ? { originalType: str(p.originalType) } : {}),
    });
  }

  // Newest first. On a real workspace the archive is long, so the settled tail
  // is capped and the drop is REPORTED - but anything waiting on a human is
  // exempt, because a truncated inbox would be a lie.
  const byRecency = [...objects]
    .filter((o) => CATEGORY_OF_TYPE[o.type])
    .sort((a, b) => b.statusChangedAt.localeCompare(a.statusChangedAt))
    .map((o) => o.id);
  const order = new Map(byRecency.map((id, i) => [id, i]));
  artifacts.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const waiting = artifacts.filter((a) => a.needsHuman);
  const settled = artifacts.filter((a) => !a.needsHuman);
  const shownSettled = settled.slice(0, LIBRARY_SETTLED_CAP);

  return {
    categories: [...LIBRARY_CATEGORIES],
    artifacts: [...waiting, ...shownSettled],
    needsYou: waiting.length,
    total: artifacts.length,
    truncated: settled.length - shownSettled.length,
  };
}

/**
 * Render a stored artifact file to sanitized HTML. Uses the SAFE parse: one
 * malformed stored body must degrade to a visible note, never blank the whole
 * Library. Raw HTML in the body is stripped (this content came from an agent,
 * not from us).
 */
function renderStored(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  const parsed = safeParseArtifact(source);
  if (!parsed.ok) return `<p>This artifact could not be parsed: ${parsed.error.code}</p>`;
  return renderArtifactBody(parsed.value, { rawHtml: "strip" });
}

// ---- Timeline ----

export interface TimelineEntry {
  id: string;
  ts: string;
  /** Object the event is about. */
  actor: string;
  /** Prose line, from the event payload note or reconstructed from the diff. */
  message: string;
  transition: string | null;
  entrance: string;
  actorId: string;
  band: string;
  kind: "decision" | "artifact" | "observe" | "run";
  objectId: string | null;
}

export interface TimelineView {
  events: TimelineEntry[];
  total: number;
}

export async function timelineView(teamId = DEMO_TEAM_ID, limit = 120): Promise<TimelineView> {
  const { byId, edges } = await load(teamId);
  const producer = producerIndex(edges);
  const rows = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.teamId, teamId))
    .orderBy(desc(eventsTable.ts), desc(eventsTable.id))
    .limit(limit);
  const total = await graph.countEvents(undefined, teamId);

  const events: TimelineEntry[] = rows.map((e) => {
    const object = e.objectId ? byId.get(e.objectId) : undefined;
    const loop = object ? byId.get(producer.get(object.id) ?? object.id) : undefined;
    const note = str((e.payload as Record<string, unknown> | null)?.note);
    return {
      id: e.id,
      ts: e.ts,
      actor: loop?.title ?? object?.title ?? "workspace",
      message: note ?? describeDiff(e.transition, e.diff, object?.title ?? undefined),
      transition: e.transition,
      entrance: e.entrance,
      actorId: e.actorId,
      band: str(payloadOf(loop ?? object ?? ({ payload: null } as GraphObject)).band) ?? "platform",
      kind: classify(e.entrance, object),
      objectId: e.objectId,
    };
  });
  return { events, total };
}

/**
 * The Timeline's row type is derived from the two provenance columns the kernel
 * records on EVERY event - never from a parallel fixture:
 * a human entrance is a decision; an agent run against a product is an artifact
 * event; anything a sensor or the clock produced is observation or run activity.
 */
function classify(entrance: string, object: GraphObject | undefined): TimelineEntry["kind"] {
  if (entrance === "human") return "decision";
  if (object && (object.archetype === "doc" || object.type === "merge-review")) return "artifact";
  if (object && str(payloadOf(object).kind) === "sensor") return "observe";
  return "run";
}

/** No note on the event? The diff still says exactly what happened. */
function describeDiff(transition: string | null, diff: unknown, title?: string): string {
  const d = (diff ?? {}) as Record<string, { old: unknown; new: unknown }>;
  const status = d["status"];
  if (transition && status) return `${transition} · ${String(status.old)} → ${String(status.new)}`;
  return transition ? `ran ${transition}` : (title ?? "changed");
}

// ---- Inbox ----

export interface InboxItem {
  objectId: string;
  key: string;
  class: string;
  label: string;
  openedAt: string;
  title: string;
  type: string;
  source: string;
  /** The transition that discharges it, if the effective spec declares one. */
  verdict?: { transition: string; label: string };
}

export async function inboxView(teamId = DEMO_TEAM_ID): Promise<{ items: InboxItem[] }> {
  const { byId, edges } = await load(teamId);
  const producer = producerIndex(edges);
  const open = await graph.listOpenObligations(undefined, teamId, { class: "human-verdict" });

  const items: InboxItem[] = [];
  for (const o of open) {
    const object = byId.get(o.objectId);
    if (!object) continue;
    const spec = (await graph.getEffectiveType(undefined, teamId, object.type))?.spec;
    const transition = spec ? verdictTransition(spec, object.status, o.key) : undefined;
    items.push({
      objectId: o.objectId,
      key: o.key,
      class: o.class,
      label: o.label ?? o.key,
      openedAt: o.openedAt,
      title: object.title ?? object.id,
      type: object.type,
      source: byId.get(producer.get(object.id) ?? "")?.title ?? "unknown loop",
      ...(transition ? { verdict: { transition, label: VERDICT_LABEL[o.key] ?? "Decide" } } : {}),
    });
  }
  items.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  return { items };
}

// ---- the one write path ----

export interface VerdictInput {
  objectId: string;
  transition: string;
  /** ISO instant. Required - transitions never read the clock. */
  now: string;
  userId?: string;
}

/**
 * Close a human-verdict gate from the UI. This is a thin, honest wrapper: it
 * supplies `entrance: "human"` and the acting user, and hands everything else to
 * `applyTransition`. Every guard still applies - a transition that is not legal
 * from the object's current state, or that a gate state forbids to a non-human,
 * comes back as a typed refusal rather than a partial write.
 *
 * It first runs `drainEngineLocalActions`, because the outbox EXECUTOR is a
 * later unit and a verdict that enters a terminal state is (correctly) refused
 * while the gate's own `enqueue-review` action is still pending. Standing in for
 * the executor here is deliberate and bounded - see that function's note.
 */
export async function recordVerdict(input: VerdictInput): Promise<ApplyTransitionResult> {
  await drainEngineLocalActions(input.objectId, input.now);
  return applyTransition({
    objectId: input.objectId,
    transition: input.transition,
    actor: { entrance: "human", actorId: input.userId ?? DEMO_USER_ID },
    now: input.now,
  });
}

/**
 * MINIMAL EXECUTOR STAND-IN. Marks this object's pending ENGINE-LOCAL actions
 * (R0/R1/R2) delivered, exactly as the real outbox executor will.
 *
 * The ceiling is preserved and is the whole point: an OUTWARD (R3) or GOVERNANCE
 * (R4) action is never touched here. Those carry an approval event by schema
 * CHECK, and delivering one is an effect on the world - not something a read
 * surface gets to do on the way to rendering a page. If one is pending, the
 * terminal-state guard will refuse the verdict, which is the correct outcome.
 *
 * Returns how many rows it stamped, so the caller can say so rather than have it
 * happen invisibly.
 */
export async function drainEngineLocalActions(objectId: string, now: string): Promise<number> {
  const pending = await graph.listPendingActions(undefined, { objectId });
  let drained = 0;
  for (const action of pending) {
    if (action.consequenceClass === "R3" || action.consequenceClass === "R4") continue;
    if (await graph.markActionDelivered(undefined, action.id, now)) drained++;
  }
  return drained;
}

/** Workspace-level counters for the shell (sidebar badge, machine line). */
export async function summaryView(teamId = DEMO_TEAM_ID): Promise<{
  loops: number;
  artifacts: number;
  needsYou: number;
  events: number;
  pendingActions: number;
}> {
  const { objects, obligations } = await load(teamId);
  const pending = await graph.listPendingActions(undefined, { teamId });
  return {
    loops: objects.filter((o) => o.type === "loop" && o.status !== "planned").length,
    artifacts: objects.filter((o) => CATEGORY_OF_TYPE[o.type]).length,
    needsYou: obligations.filter((o) => o.closedByEvent === null && o.class === "human-verdict").length,
    events: await graph.countEvents(undefined, teamId),
    pendingActions: pending.length,
  };
}

export async function objectsForTeam(teamId = DEMO_TEAM_ID): Promise<GraphObject[]> {
  return graph.listObjects(undefined, teamId);
}

export { DEMO_TEAM_ID };
export const _internals = { verdictTransition, classify, relativeAge, gateName, describeDiff, stateLabel };
