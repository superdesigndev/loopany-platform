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

import { renderArtifactBody, renderMarkdown, safeParseArtifact } from "@loopany/artifact-format";

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
import { applyTransition, CHAIN_PARK_KEY, type ApplyTransitionResult } from "../applyTransition.js";
import { attentionView as attention, type AttentionView } from "../outbox/attention.js";
import { drainOutbox } from "../outbox/executor.js";
import { sensingHealth, type SensingHealth } from "../sensing/watch.js";
import { cadenceOf, describeCadence } from "../schedule/cadence.js";
import { CLOCK_SKIPPED_EVENT } from "../schedule/scheduler.js";
import { RUN_FINISHED_EVENT, RUN_STARTED_EVENT } from "../effects/instruction.js";
import type { TypeSpec } from "../types.js";
import {
  CATEGORY_OF_TYPE,
  DEMO_TEAM_ID,
  DEMO_USER_ID,
  LIBRARY_CATEGORIES,
  REVIEW_PRESETS,
  REVIEW_TYPE,
  SHEPHERD_TYPES,
  WORK_PRESET,
} from "./specs.js";

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
  /** Open HUMAN-VERDICT obligations in this node's scope - what a person owes. */
  waiting?: number;
  /**
   * Open EXTERNAL-WAIT obligations in scope - what the outside world owes us.
   *
   * Counted SEPARATELY from `waiting` on purpose, and not merely for display:
   * design §12 item 5 draws the line that waiting for the world to reflect a
   * decision is an obligation and NOT a gate, so folding a merge watch into
   * "waiting on you" would tell a person they owe something they do not. The
   * poller closes these from observations, so this is the count that MOVES on its
   * own - the visible proof that the graph updates itself.
   */
  watching?: number;
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
function gateName(presets: Set<string>): string {
  // Named off the review PRESET, which is instance data (captain decision 16) -
  // there is one review type now, so a gate cannot be named by a type name
  // without inventing five of them again.
  if (presets.has("merge")) return "Merge gate";
  if (presets.has("publish")) return "Publish gate";
  if (presets.has(WORK_PRESET)) return "Go-ahead";
  if (presets.has("decision")) return "Your call";
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
  //
  // The two obligation CLASSES are counted apart. `waiting` is the human-verdict
  // count - the gate's whole reason to exist - while `watching` is the passive
  // external-wait count, which belongs to the same node (it is the same loop's
  // products) but must never read as a debt a person owes.
  for (const loop of loops) {
    const scope = new Set<string>([loop.id, ...(products.get(loop.id) ?? [])]);
    const held = obligations.filter((o) => scope.has(o.objectId));
    if (!held.length) continue;
    const openAll = held.filter((o) => o.closedByEvent === null);
    const open = openAll.filter((o) => o.class === "human-verdict");
    const watching = openAll.filter((o) => o.class === "external-wait");
    const types = new Set(held.map((o) => byId.get(o.objectId)?.type ?? "").filter(Boolean));
    const gateId = `gate:${loop.id}`;
    const p = payloadOf(loop);
    nodes.push({
      id: gateId,
      kind: "gate",
      name: gateName(types),
      eyebrow: `${loop.title} · gate class`,
      stat: open.length
        ? `${open.length} waiting on you`
        : watching.length
          ? `watching ${watching.length} on GitHub`
          : "Clear",
      badge: String(open.length || watching.length),
      rank: num(p.rank) + 0.5,
      ...(p.yOffset ? { yOffset: num(p.yOffset) } : {}),
      activity: open.length ? "waiting" : "idle",
      band: str(p.band) ?? "platform",
      waiting: open.length,
      ...(watching.length ? { watching: watching.length } : {}),
      // What clicking the gate OPENS in the Library: the things a person owes a
      // verdict on. An external wait has no button, so listing it here would offer
      // a row nobody can act on.
      artifactIds: open.map((o) => o.objectId),
    });
    outEdges.push({
      id: `e-gate-${loop.id}`,
      source: loop.id,
      target: gateId,
      label: "produces",
      animated: openAll.length > 0,
    });
    // Only a HUMAN-VERDICT obligation draws a line to the person. An external wait
    // is owed by GitHub, and an arrow saying "needs verdict" would be a lie.
    if (open.length) {
      outEdges.push({ id: `e-you-${loop.id}`, source: gateId, target: "you", label: "needs verdict", shared: true, animated: true });
    }
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
  /** The verdict a person owes: which SHEPHERD task to move, with which
   *  transition. Content itself never moves (decision 8). */
  verdict?: { objectId: string; transition: string; label: string; obligation: string };
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
  /** How the body was rendered - see `renderStored`. Absent with no body. */
  renderMode?: RenderMode;
  /** Why there is no body, when there is none. Always a real condition. */
  bodyAbsentReason?: string;
  /** The doc's `published` FIELD - a field, not a state (decision 8). */
  published: boolean;
  /**
   * The open `external-wait` this row is holding, if any - "we are waiting on the
   * outside world for this". NOT a verdict: there is no button, and it clears
   * itself when the mirror poller observes the condition.
   */
  watching?: string;
  /** The wait's key, for the `wait answer` verb. */
  watchKey?: string;
  /** The object NAMED as its watcher at creation (decision 13). */
  watcher?: string;
  /** The question its watcher answers. */
  watchQuestion?: string;
  /** When an observation last ingested facts for this mirror. The one field on a
   *  Library row that moves without anybody doing anything. */
  observedAt?: string;
}

/** How a stored body was projected to HTML. */
export type RenderMode = "artifact" | "markdown" | "code";

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
  "pull-request": "pr",
  post: "post",
  report: "report",
  playbook: "doc",
};

/**
 * The label the Library shows for a content row.
 *
 * A doc has no state to report (decision 8), so the label comes from whichever
 * is true: the shepherd task currently reviewing it, else the `published` FIELD.
 * A mirror reports the state we actually observed.
 */
function stateLabel(object: GraphObject, shepherd?: GraphObject): string {
  if (object.archetype === "mirror") return humanize(object.status);
  if (shepherd) return humanize(shepherd.status);
  return payloadOf(object).published === true ? "Published" : "Draft";
}

function humanize(s: string): string {
  return s.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * The verdict button's words, from the review's PRESET.
 *
 * Was a table keyed by obligation key, one entry per shepherd type. Since the
 * collapse (decision 16) there is one key on one type, so the label comes from
 * instance data - which is also why "Run it" still reads differently from
 * "Approve": dispatching a run spends money and can act on the world, and the
 * button should say what it does.
 */
function verdictLabel(object: GraphObject | undefined): string {
  const preset = str(payloadOf(object ?? ({} as GraphObject)).preset);
  return (preset && REVIEW_PRESETS[preset]?.label) || "Decide";
}

/**
 * The transition that discharges an open obligation, resolved from the object's
 * EFFECTIVE type spec: the one transition out of the object's current state that
 * closes this key. Nothing is hardcoded - a new type gets its verdict button for
 * free, and a spec with no such transition simply offers none.
 */
function verdictTransition(spec: TypeSpec, status: string, key: string, object?: GraphObject): string | undefined {
  // WHICH yes, when there is more than one. The collapsed review type offers two
  // ways out of its gate - `approve` (a consequence that lands here or through an
  // earned accelerator) and `dispatch` (work a machine does) - and the PRESET is
  // what says which one this instance means (captain decision 16). Instance data
  // decides; the spec is still what makes it legal.
  const preset = object ? str(payloadOf(object).preset) : undefined;
  const wanted = preset ? REVIEW_PRESETS[preset]?.verdict : undefined;
  const candidates = spec.transitions.filter((t) => t.from.includes(status) && (t.closes ?? []).includes(key));
  return (wanted ? candidates.find((t) => t.name === wanted) : undefined)?.name ?? candidates[0]?.name;
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
  // Two indexes, because the two obligation CLASSES mean different things to a
  // row: a human-verdict gives it a button, an external-wait gives it a note.
  const openByObject = new Map<string, GateObligation>();
  const watchByObject = new Map<string, GateObligation>();
  for (const o of obligations) {
    if (o.closedByEvent !== null) continue;
    if (o.class === "external-wait") watchByObject.set(o.objectId, o);
    else openByObject.set(o.objectId, o);
  }

  // A merge review points at its mirror through a `tracks` edge.
  const tracks = new Map<string, string>();
  for (const e of edges) if (e.kind === "tracks") tracks.set(e.srcId, e.dstId);

  const specCache = new Map<string, TypeSpec | undefined>();
  const specOf = async (type: string): Promise<TypeSpec | undefined> => {
    if (!specCache.has(type)) specCache.set(type, (await graph.getEffectiveType(undefined, teamId, type))?.spec);
    return specCache.get(type);
  };

  // A shepherd task `tracks` the content it reviews, so index the relation the
  // other way: content id → the task carrying its verdict.
  const shepherdOf = new Map<string, GraphObject>();
  for (const e of edges) {
    if (e.kind !== "tracks") continue;
    const task = byId.get(e.srcId);
    if (task && SHEPHERD_TYPES[task.type]) shepherdOf.set(e.dstId, task);
  }

  const artifacts: LibraryArtifact[] = [];
  for (const o of objects) {
    const category = CATEGORY_OF_TYPE[o.type];
    if (!category) continue; // loops and shepherd tasks are not Library rows

    const p = payloadOf(o);
    const loopId = producer.get(o.id);
    const source = (loopId && byId.get(loopId)?.title) ?? "unknown loop";
    const shepherd = shepherdOf.get(o.id);
    const open = shepherd ? openByObject.get(shepherd.id) : undefined;

    let verdict: LibraryArtifact["verdict"];
    if (open && shepherd) {
      const spec = await specOf(shepherd.type);
      const transition = spec ? verdictTransition(spec, shepherd.status, open.key, shepherd) : undefined;
      // The verdict runs on the SHEPHERD, not on the content - so the row hands
      // the caller that object id rather than making the client infer it.
      if (transition) {
        verdict = { objectId: shepherd.id, transition, label: verdictLabel(shepherd), obligation: open.key };
      }
    }

    const isMirror = o.archetype === "mirror";
    const externalUrl = str(p.sourceUrl);
    const bodyAvailable = typeof p.source === "string";
    const rendered = bodyAvailable ? renderStored(p.source, str(p.prodPath)) : undefined;
    artifacts.push({
      id: o.id,
      category,
      title: o.title ?? o.id,
      source,
      state: stateLabel(o, shepherd),
      age: relativeAge(o.updatedAt, now),
      icon: ICON_OF_TYPE[o.type] ?? "doc",
      kind: isMirror ? "mirror" : "document",
      ...(isMirror && externalUrl
        ? { sourceUrl: externalUrl, externalLabel: "View on GitHub" }
        : { html: rendered?.html }),
      needsHuman: Boolean(open),
      ...(verdict ? { verdict } : {}),
      bodyAvailable,
      ...(rendered ? { renderMode: rendered.mode } : {}),
      ...(str(p.bodyAbsentReason) ? { bodyAbsentReason: str(p.bodyAbsentReason) } : {}),
      ...(str(p.prodPath) ? { path: str(p.prodPath) } : {}),
      ...(str(p.originalType) ? { originalType: str(p.originalType) } : {}),
      published: p.published === true,
      // A mirror's own external wait, plus when we last looked. Both move with no
      // human involved - this is where the live pipe shows up in the Library.
      ...(watchByObject.has(o.id)
        ? {
            watching: watchByObject.get(o.id)!.label ?? watchByObject.get(o.id)!.key,
            // The wait's KEY and its named WATCHER, so the workspace can offer the
            // same `wait answer` verb an agent uses (captain decisions 13 + 16) -
            // a person looking at the thing is a perfectly good watcher, and
            // routing their answer through the verb keeps the Timeline uniform.
            watchKey: watchByObject.get(o.id)!.key,
            ...(watchByObject.get(o.id)!.watcherObjectId
              ? { watcher: watchByObject.get(o.id)!.watcherObjectId! }
              : {}),
            ...(watchByObject.get(o.id)!.question ? { watchQuestion: watchByObject.get(o.id)!.question! } : {}),
          }
        : {}),
      ...(o.externalObservedAt ? { observedAt: o.externalObservedAt } : {}),
    });
  }

  // Newest first. On a real workspace the archive is long, so the settled tail
  // is capped and the drop is REPORTED - but anything waiting on a human is
  // exempt, because a truncated inbox would be a lie.
  // Recency is `updatedAt`, NOT `statusChangedAt`: content has no status to
  // change (decision 8), so a doc that was just revised - or just published by a
  // shepherd's field write - would otherwise sort as if nothing had happened.
  const byRecency = [...objects]
    .filter((o) => CATEGORY_OF_TYPE[o.type])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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

/** Extensions that are source/data, not prose. Rendering them as Markdown would
 *  mangle them, so they go through a fenced code block instead. */
const CODE_EXTENSIONS: Record<string, string> = {
  json: "json",
  py: "python",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  csv: "csv",
  txt: "",
};

/**
 * Render a stored artifact body to sanitized HTML, and say HOW it was rendered.
 *
 * Real production artifacts are not uniformly v1-format files - many predate the
 * format, and some are data or code the loop keeps beside its prose. So there
 * are three honest paths, and the caller surfaces which one ran rather than
 * pretending everything is a well-formed artifact:
 *
 *   `artifact`  front matter + Markdown, parsed and rendered by the format library
 *   `markdown`  Markdown with no (or unparseable) front matter - rendered as prose
 *   `code`      a data/source file - rendered as one fenced block
 *
 * Every path ends in the same sanitizer, and raw HTML in a body is STRIPPED:
 * this content was written by an agent, not by us.
 */
function renderStored(source: unknown, filePath?: string): { html: string; mode: RenderMode } | undefined {
  if (typeof source !== "string") return undefined;

  const ext = filePath?.split(".").pop()?.toLowerCase();
  if (ext && ext in CODE_EXTENSIONS) {
    const lang = CODE_EXTENSIONS[ext]!;
    // A fence inside the content would end the block early; the longest run of
    // backticks in the body decides the fence length.
    const longest = Math.max(2, ...[...source.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    return { html: renderMarkdown(`${fence}${lang}\n${source}\n${fence}`, { rawHtml: "strip" }), mode: "code" };
  }

  const parsed = safeParseArtifact(source);
  if (parsed.ok) return { html: renderArtifactBody(parsed.value, { rawHtml: "strip" }), mode: "artifact" };
  // No machine head (or one this version cannot read). The document is still a
  // real document - render the prose and let the caller say it had no front
  // matter, rather than replacing the content with an error.
  return { html: renderMarkdown(source, { rawHtml: "strip" }), mode: "markdown" };
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
  kind: "decision" | "artifact" | "observe" | "run" | "clock";
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
      kind: classify(e.entrance, object, e.kind),
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
 *
 * The RUN LIFECYCLE kinds are checked FIRST, ahead of the object-shape branches.
 * A dispatched run's `run-started`/`run-finished` land on the task that dispatched
 * it, and without this a run against a doc-shaped object would read as an artifact
 * event - which is exactly wrong: the whole point of surfacing a run in the
 * Timeline is that a person can see the machine working.
 *
 * THE CLOCK GETS ITS OWN ROW TYPE, straight off the `entrance` column. "Time
 * arrived" is a different kind of cause from a person deciding, an agent producing
 * or a sensor observing, and it used to render as `run` - so a fire, and the run it
 * caused, looked like the same sort of thing. They are not: one is the reason and
 * the other is the consequence, and a person reading the feed should be able to see
 * the cadence firing on its own with nobody watching.
 */
function classify(
  entrance: string,
  object: GraphObject | undefined,
  kind?: string,
): TimelineEntry["kind"] {
  if (kind === RUN_STARTED_EVENT || kind === RUN_FINISHED_EVENT) return "run";
  if (entrance === "clock") return "clock";
  if (entrance === "human") return "decision";
  if (object && (object.archetype === "doc" || object.type === REVIEW_TYPE)) return "artifact";
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
  /** The TASK that owes the verdict - what `recordVerdict` moves. */
  objectId: string;
  key: string;
  class: string;
  label: string;
  openedAt: string;
  title: string;
  type: string;
  source: string;
  /** The content object this task reviews, when it shepherds one. */
  reviews?: string;
  /** The transition that discharges it, if the effective spec declares one. */
  verdict?: { transition: string; label: string };
}

export async function inboxView(teamId = DEMO_TEAM_ID): Promise<{ items: InboxItem[] }> {
  const { byId, edges } = await load(teamId);
  const producer = producerIndex(edges);
  // shepherd id → the content it reviews
  const reviews = new Map<string, string>();
  for (const e of edges) if (e.kind === "tracks") reviews.set(e.srcId, e.dstId);
  const open = await graph.listOpenObligations(undefined, teamId, { class: "human-verdict" });

  const items: InboxItem[] = [];
  for (const o of open) {
    // A PARKED CHAIN is an attention item, not a verdict. It holds a
    // human-verdict obligation (that is what makes parking terminal-until-verdict),
    // but no spec declares a transition that closes it - so listing it here would
    // put a row with no button among rows that all have one. `attentionView` owns
    // it, and acknowledging it there closes this obligation.
    if (o.key === CHAIN_PARK_KEY) continue;
    // Every obligation now sits on a TASK (decision 8) - a shepherd or a loop.
    const task = byId.get(o.objectId);
    if (!task) continue;
    const content = byId.get(reviews.get(task.id) ?? "");
    const spec = (await graph.getEffectiveType(undefined, teamId, task.type))?.spec;
    const transition = spec ? verdictTransition(spec, task.status, o.key, task) : undefined;
    items.push({
      objectId: task.id,
      key: o.key,
      class: o.class,
      label: o.label ?? o.key,
      openedAt: o.openedAt,
      // The human reads the CONTENT, so the row is titled by it.
      title: content?.title ?? task.title ?? task.id,
      type: task.type,
      ...(content ? { reviews: content.id } : {}),
      source: byId.get(producer.get(task.id) ?? "")?.title ?? "unknown loop",
      ...(transition ? { verdict: { transition, label: verdictLabel(task) } } : {}),
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

/** What the verdict's own consequences did, so the UI can say the effect landed
 *  rather than leave the person guessing whether anything happened. */
export interface VerdictEffects {
  claimed: number;
  done: number;
  deadLettered: number;
}

export type RecordVerdictResult = ApplyTransitionResult & { effects?: VerdictEffects };

/**
 * Close a human-verdict gate from the UI. This is a thin, honest wrapper: it
 * supplies `entrance: "human"` and the acting user, and hands everything else to
 * `applyTransition`. Every guard still applies - a transition that is not legal
 * from the object's current state, or that a gate state forbids to a non-human,
 * comes back as a typed refusal rather than a partial write.
 *
 * ── the executor, before and after ──────────────────────────────────────────
 *
 * BEFORE: drain this object's queue. A verdict that enters a terminal state is
 * (correctly) refused while the gate's own `enqueue-review` action is unsettled,
 * so the attested close needs a clear queue to attest to. This is no longer a
 * stand-in - it is `outbox/executor.ts` doing its real job, one object's worth.
 *
 * AFTER: drain again, for the verdict's OWN consequences - the `notify` a person
 * will see and the `update-fields` that flips `published` on the tracked content.
 * The background loop would pick these up within a tick anyway; doing it inline
 * means the response can REPORT the effect, which is the difference between "we
 * recorded your decision" and "here is what it caused".
 */
export async function recordVerdict(input: VerdictInput): Promise<RecordVerdictResult> {
  await drainObjectActions(input.objectId, input.now);
  const result = await applyTransition({
    objectId: input.objectId,
    transition: input.transition,
    actor: { entrance: "human", actorId: input.userId ?? DEMO_USER_ID },
    now: input.now,
  });
  if (!result.ok) return result;
  const effects = await drainObjectActions(input.objectId, input.now);
  return { ...result, effects };
}

/**
 * Drain the outbox, then report what it did.
 *
 * The executor claims by DUE-NESS, not by object (a per-object claim query would
 * be a second scan shape to keep correct), so a verdict's drain may also settle a
 * few unrelated rows that were already due. That is the executor working, not a
 * side effect worth avoiding - the numbers reported back are simply the pass's,
 * and the background loop would have done the same thing a tick later.
 */
async function drainObjectActions(objectId: string, now: string): Promise<VerdictEffects> {
  const pending = await graph.listPendingActions(undefined, { objectId });
  if (!pending.length) return { claimed: 0, done: 0, deadLettered: 0 };
  const r = await drainOutbox({ now, teamId: pending[0]!.teamId, limit: 50, maxPasses: 8 });
  return { claimed: r.claimed, done: r.done, deadLettered: r.deadLettered };
}

// ---- Attention + notifications: the executor's two visible surfaces ----

/**
 * The Attention section's payload. Deliberately a SEPARATE view from the inbox:
 * "a person must decide something" and "a consequence is stuck" are different
 * feelings, and the design's §8 inbox aggregate is only useful if the second one
 * cannot be lost among the first.
 */
export async function attentionView(teamId = DEMO_TEAM_ID): Promise<AttentionView> {
  return attention(teamId);
}

export interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  channel: string;
  createdAt: string;
  age: string;
  read: boolean;
  objectId: string | null;
}

/**
 * What the `notify` action produced - the proof that approving a gate CAUSES
 * something. Read-only; marking read is a separate explicit write.
 */
export async function notificationsView(
  teamId = DEMO_TEAM_ID,
  limit = 50,
): Promise<{ items: NotificationRow[]; unread: number }> {
  const rows = await graph.listNotifications(undefined, teamId, limit);
  const nowMs = rows.length ? Date.parse(rows[0]!.createdAt) : Date.now();
  return {
    items: rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      channel: n.channel,
      createdAt: n.createdAt,
      age: relativeAge(n.createdAt, Math.max(nowMs, Date.parse(n.createdAt))),
      read: n.readAt !== null,
      objectId: n.objectId,
    })),
    unread: await graph.countUnreadNotifications(undefined, teamId),
  };
}

// ---- effect delivery: what our verdicts are doing to the outside world ----

export interface EffectRow {
  id: string;
  kind: string;
  state: string;
  /** `owner/repo/pull/N` - the same string the mirror carries. */
  target: string;
  /** Where the effect landed, when it did: a comment url, a merge sha. */
  resultUrl: string | null;
  detail: string | null;
  /** Typed refusal, for a failed one. */
  reason: string | null;
  attempts: number;
  createdAt: string;
  age: string;
  settledAt: string | null;
  objectId: string | null;
}

/**
 * The effect-delivery feed: every outward work order this workspace produced and
 * what became of it.
 *
 * This is the surface that makes "approve in the platform" honest. Without it a
 * person clicks Approve, sees a notification, and has to go to GitHub to find out
 * whether anything actually happened out there - which is the same gap the outbox
 * executor closed one layer down. `pending` means the agent has not picked it up
 * yet; `claimed` means a machine is working on it right now; `done` carries the
 * URL of the thing that exists in the world because somebody approved it.
 */
export async function effectsView(teamId = DEMO_TEAM_ID, limit = 25): Promise<{ items: EffectRow[]; unsettled: number }> {
  const rows = await graph.listDirectives(undefined, teamId, limit);
  const nowMs = Date.now();
  return {
    items: rows.map((d) => {
      const result = (d.result ?? {}) as Record<string, unknown>;
      return {
        id: d.id,
        kind: d.kind,
        state: d.state,
        target: d.targetExternalId,
        resultUrl: typeof result.url === "string" ? result.url : null,
        detail: typeof result.detail === "string" ? result.detail : d.lastError,
        reason: d.refusalCode,
        attempts: d.attempts,
        createdAt: d.createdAt,
        age: relativeAge(d.createdAt, Math.max(nowMs, Date.parse(d.createdAt))),
        settledAt: d.settledAt,
        objectId: d.objectId,
      };
    }),
    unsettled: await graph.countUnsettledDirectives(undefined, teamId),
  };
}

// ---- the runs bridge: work a person can send to a machine ----

export interface WorkRow {
  /** The review task itself - what a verdict moves. */
  id: string;
  title: string;
  /** This instance's own instruction, verbatim. A person approving a run must be
   *  able to read what it will be told to do. */
  brief: string | null;
  status: string;
  age: string;
  /** The go-ahead a person owes, when this row is sitting in its gate. */
  verdict?: { objectId: string; transition: string; label: string; obligation: string };
  /** The run's own id, once one was dispatched. */
  runId?: string;
  /** Where the run got to: started, or finished with an outcome. */
  runState?: "started" | "success" | "failure";
  /** The run's own one-line account of what it did. */
  summary?: string;
  /** The report DOC it produced, if it produced one - the Library row to open. */
  reportId?: string;
}

export interface WorkView {
  items: WorkRow[];
  /** Rows waiting on a person's go-ahead. */
  awaiting: number;
  /** Runs dispatched and not yet reported back. */
  inFlight: number;
}

/**
 * WORK, as opposed to content.
 *
 * The Library lists what the fleet has MADE; this lists what a person has been asked
 * to let a machine DO. They are deliberately separate surfaces: a dispatch review is not
 * an artifact, it has no body, and giving it a Library row would have meant either
 * inventing a content category for it or letting the artifact list mean two things.
 *
 * Every field is derived from real rows - the task's status, and the run lifecycle
 * events the machine agent reported (`graph/agent/runs.ts`). Nothing here is a flag,
 * so a run that never reported back shows as dispatched-and-silent rather than as
 * whatever a status column was last set to.
 */
export async function workView(teamId = DEMO_TEAM_ID): Promise<WorkView> {
  const { objects, edges, obligations, now } = await load(teamId);
  // WORK is a review whose verdict DISPATCHES a run - a preset, not a type
  // (decision 16). Everything else about this view is unchanged.
  const tasks = objects.filter((o) => o.type === REVIEW_TYPE && str(payloadOf(o).preset) === WORK_PRESET);
  if (!tasks.length) return { items: [], awaiting: 0, inFlight: 0 };

  const openByObject = new Map<string, GateObligation>();
  for (const o of obligations) {
    if (o.closedByEvent === null && o.class !== "external-wait") openByObject.set(o.objectId, o);
  }
  const spec = (await graph.getEffectiveType(undefined, teamId, REVIEW_TYPE))?.spec;
  /** task id → the report doc it produced, so a finished run links to its product. */
  const produced = new Map<string, string>();
  for (const e of edges) if (e.kind === "produces") produced.set(e.srcId, e.dstId);

  const items: WorkRow[] = [];
  for (const task of tasks) {
    const p = payloadOf(task);
    const open = openByObject.get(task.id);
    const transition = open && spec ? verdictTransition(spec, task.status, open.key, task) : undefined;

    // The run's own account of itself, read off the lifecycle events rather than
    // inferred from the task's status - "the task is done" and "the run said what it
    // did" are different facts, and only one of them is the machine's own words.
    const events = await graph.listObjectEvents(undefined, task.id);
    const finished = [...events].reverse().find((e) => e.kind === RUN_FINISHED_EVENT);
    const started = [...events].reverse().find((e) => e.kind === RUN_STARTED_EVENT);
    const runEvent = finished ?? started;
    const runPayload = (runEvent?.payload ?? {}) as Record<string, unknown>;
    const outcome = str((finished?.payload as Record<string, unknown> | undefined)?.outcome);

    items.push({
      id: task.id,
      title: task.title ?? task.id,
      brief: str(p.brief) ?? null,
      status: task.status,
      age: relativeAge(task.updatedAt, now),
      ...(transition && open
        ? {
            verdict: {
              objectId: task.id,
              transition,
              label: verdictLabel(task),
              obligation: open.key,
            },
          }
        : {}),
      ...(str(runPayload.run) ? { runId: str(runPayload.run)! } : {}),
      ...(finished
        ? { runState: outcome === "failure" ? ("failure" as const) : ("success" as const) }
        : started
          ? { runState: "started" as const }
          : {}),
      ...(str((finished?.payload as Record<string, unknown> | undefined)?.summary)
        ? { summary: str((finished!.payload as Record<string, unknown>).summary)! }
        : {}),
      ...(produced.has(task.id) ? { reportId: produced.get(task.id)! } : {}),
    });
  }
  items.sort((a, b) => (a.verdict ? -1 : b.verdict ? 1 : 0));
  return {
    items,
    awaiting: items.filter((i) => i.verdict).length,
    // Dispatched with no outcome reported yet. Includes a run whose agent died - the
    // Attention list is what says so, and this counter never pretends otherwise.
    inFlight: items.filter((i) => i.status === "dispatched" && i.runState !== "success" && i.runState !== "failure")
      .length,
  };
}

/** Workspace-level counters for the shell (sidebar badge, machine line). */
export async function summaryView(teamId = DEMO_TEAM_ID): Promise<{
  loops: number;
  artifacts: number;
  needsYou: number;
  /** Open `external-wait` obligations - what the outside world owes us. Distinct
   *  from `needsYou` by design (§12 item 5), and the counter that moves on its
   *  own as the mirror poller observes. */
  watching: number;
  /** Mirrors this workspace keeps fresh - the poller's scope, derived from the
   *  same table it sweeps rather than from a config number. */
  mirrors: number;
  events: number;
  pendingActions: number;
  attention: number;
  notifications: number;
  unreadNotifications: number;
  /** Outward effects still in flight - queued for an agent or being executed by
   *  one. The counter that says "your decision is on its way out there". */
  effectsInFlight: number;
  /**
   * IS ANYBODY SENSING? Since captain decision 10 the server holds no fetch loop,
   * so a workspace whose machine agent is not running looks exactly like one whose
   * pull requests simply have not changed - and those are very different
   * situations. Computed from `objects.external_observed_at`, so it is a property
   * of real rows rather than a heartbeat somebody has to remember to send.
   */
  sensing: SensingHealth;
  /** Work awaiting a go-ahead, and runs in flight - the runs bridge's own vitals. */
  work: { awaiting: number; inFlight: number };
  /**
   * THE CLOCK'S OWN VITALS: cadences carrying a live cursor, and how many of those
   * cursors are already in the past. `overdue` is the honest "is the scheduler
   * running?" indicator - it ticks faster than any legal cadence, so a standing
   * backlog means the clock is stopped, which a "scheduler: on" light would hide.
   */
  schedules: { armed: number; overdue: number };
}> {
  const { objects, obligations } = await load(teamId);
  const pending = await graph.listPendingActions(undefined, { teamId });
  const att = await attention(teamId);
  const notes = await graph.listNotifications(undefined, teamId, 200);
  const clock = await scheduleCounters(teamId);
  return {
    sensing: await sensingHealth({ now: new Date().toISOString(), teamId }),
    work: await workCounters(teamId),
    schedules: clock,
    loops: objects.filter((o) => o.type === "loop" && o.status !== "planned").length,
    artifacts: objects.filter((o) => CATEGORY_OF_TYPE[o.type]).length,
    // A parked chain is counted by `attention`, not here - see `inboxView`.
    needsYou: obligations.filter(
      (o) => o.closedByEvent === null && o.class === "human-verdict" && o.key !== CHAIN_PARK_KEY,
    ).length,
    watching: obligations.filter((o) => o.closedByEvent === null && o.class === "external-wait").length,
    mirrors: objects.filter((o) => o.archetype === "mirror").length,
    events: await graph.countEvents(undefined, teamId),
    pendingActions: pending.length,
    attention: att.items.length,
    notifications: notes.length,
    unreadNotifications: await graph.countUnreadNotifications(undefined, teamId),
    effectsInFlight: await graph.countUnsettledDirectives(undefined, teamId),
  };
}

/** Just the clock's two counters, for the shell. Reads the schedule columns only -
 *  no per-object event scan, unlike the full `scheduleView`. */
async function scheduleCounters(teamId: string): Promise<{ armed: number; overdue: number }> {
  const rows = await graph.listScheduled(undefined, teamId);
  const nowIso = new Date().toISOString();
  const live = rows.filter((r) => r.nextFire != null);
  return { armed: live.length, overdue: live.filter((r) => r.nextFire! <= nowIso).length };
}

/** Just the two work counters, for the shell. Cheaper than the whole view, which
 *  reads every task's event history. */
async function workCounters(teamId: string): Promise<{ awaiting: number; inFlight: number }> {
  const tasks = await graph.listObjects(undefined, teamId, { type: REVIEW_TYPE });
  if (!tasks.length) return { awaiting: 0, inFlight: 0 };
  const open = await graph.listOpenObligations(undefined, teamId, { class: "human-verdict" });
  const gated = new Set(open.map((o) => o.objectId));
  return {
    awaiting: tasks.filter((t) => gated.has(t.id)).length,
    inFlight: tasks.filter((t) => t.status === "dispatched").length,
  };
}

// ---- Schedule ----

/**
 * ONE SCHEDULED OBJECT and what its clock is doing.
 *
 * The distinction this view exists to make VISIBLE is armed-vs-configured. A
 * cadence is configuration; a cursor (`next_fire`) is what makes it live. This
 * workspace replays real production loops, cadences and all, and none of them fires
 * here - so a view that showed only "every day at 07:00" would be telling a person
 * something that is not happening. `armed: false` says so out loud.
 */
export interface ScheduleRow {
  objectId: string;
  title: string;
  type: string;
  status: string;
  /** The cadence in words (`every 2m`, `0 7 * * * (Asia/Shanghai)`). */
  cadence: string;
  /** True when a cursor exists - i.e. the clock will actually fire this. */
  armed: boolean;
  /** The cursor, and how far off it is. Absent when not armed. */
  nextFire?: string;
  dueIn?: string;
  /** Overdue by this much, when the cursor is already in the past (a scheduler that
   *  is not running is exactly what this makes visible). */
  overdueBy?: string;
  /** The transition the clock enters, when the schedule names one. */
  fireTransition?: string;
  lastFiredAt?: string;
  lastFiredAge?: string;
  /** Fires the clock recorded, and misses it recorded - both from events, so
   *  neither can claim something the log does not show. */
  fires: number;
  misses: number;
  /** The human event the cadence rests on. Absent ⇒ an outward fire would be
   *  refused, which is the fail-closed posture and worth seeing. */
  armedByEvent?: string;
}

export interface ScheduleView {
  items: ScheduleRow[];
  armed: number;
  /** Armed rows whose cursor is already in the past. Zero on a healthy server:
   *  the scheduler ticks faster than any legal cadence, so a standing backlog
   *  means the clock is not running. */
  overdue: number;
}

export async function scheduleView(teamId = DEMO_TEAM_ID): Promise<ScheduleView> {
  const rows = await graph.listScheduled(undefined, teamId);
  const nowMs = Date.now();
  const items: ScheduleRow[] = [];
  for (const row of rows) {
    const events = await graph.listObjectEvents(undefined, row.id);
    const fires = events.filter((e) => e.entrance === "clock" && e.kind === "status-changed").length;
    const misses = events.filter((e) => e.kind === CLOCK_SKIPPED_EVENT).length;
    const nextMs = row.nextFire ? Date.parse(row.nextFire) : NaN;
    items.push({
      objectId: row.id,
      title: row.title ?? row.id,
      type: row.type,
      status: row.status,
      cadence: describeCadence(cadenceOf(row)),
      armed: row.nextFire != null,
      ...(row.nextFire ? { nextFire: row.nextFire } : {}),
      ...(Number.isFinite(nextMs) && nextMs > nowMs ? { dueIn: gap(nextMs - nowMs) } : {}),
      ...(Number.isFinite(nextMs) && nextMs <= nowMs ? { overdueBy: gap(nowMs - nextMs) } : {}),
      ...(str(payloadOf(row).fireTransition) ? { fireTransition: str(payloadOf(row).fireTransition)! } : {}),
      // Ages here are measured against the REAL clock, not the demo's newest-event
      // "now" the Library uses: a fire is something that happened on this server a
      // moment ago, and dating it from a replayed history would be nonsense.
      ...(row.lastFiredAt ? { lastFiredAt: row.lastFiredAt, lastFiredAge: relativeAge(row.lastFiredAt, nowMs) } : {}),
      fires,
      misses,
      ...(row.scheduleArmedByEvent ? { armedByEvent: row.scheduleArmedByEvent } : {}),
    });
  }
  return {
    items,
    armed: items.filter((i) => i.armed).length,
    overdue: items.filter((i) => i.overdueBy !== undefined).length,
  };
}

/** A duration in words. Coarse on purpose: "in 2m" is what a person wants from a
 *  cadence row, and a ticking seconds counter would be a live clock this view is
 *  not (it re-renders on refresh, like every other pane here). */
function gap(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Mark every notification read (an explicit human action from the UI). */
export async function markNotificationsRead(teamId = DEMO_TEAM_ID, now?: string): Promise<number> {
  return graph.markNotificationsRead(undefined, teamId, now ?? new Date().toISOString());
}

export async function objectsForTeam(teamId = DEMO_TEAM_ID): Promise<GraphObject[]> {
  return graph.listObjects(undefined, teamId);
}

export { DEMO_TEAM_ID };
export const _internals = { verdictTransition, classify, relativeAge, gateName, describeDiff, stateLabel };
