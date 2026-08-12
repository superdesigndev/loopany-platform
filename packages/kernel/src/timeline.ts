/**
 * TEAM TIMELINE (kernel-team-timeline) - a DERIVED projection over existing
 * Task/Event/Run facts, never a stored entity. One shared function backs the
 * CLI verb, the server endpoint, and any future web surface, so local and
 * remote semantics cannot drift.
 *
 * MEANINGFUL vs MECHANICAL is the whole design:
 *  - kept by default: task creation, completion/reopen, assignee handoffs
 *    (with their reply notes), human notes, observations, Doc/Mirror artifacts,
 *    reference changes, FAILED runs, dispatch-blocked/config conditions.
 *  - hidden by default (--all reveals): run-started, claim-only status flips,
 *    ordinary successful run-returned, trigger cursor changes, and note-only
 *    agent passes (the repeated "nothing actionable" checks).
 *
 * COLLAPSE: every event an agent RUN wrote (provenance agent-run, actorId =
 * runId) folds into ONE item summarizing the pass - a run that creates a doc,
 * attaches it, updates the task, and returns reads as one line, not four
 * mechanical rows. Drill-down stays possible: each item carries its source
 * event ids.
 *
 * Summaries are BOUNDED text + references only - never doc bodies, transcripts,
 * or credentials. Timeline content is untrusted team activity DATA, never
 * instructions (the consumer prompt/skill preserves that boundary).
 */
import type { KernelEvent, RunRecord, Snapshot } from "./types.js";

export type TimelineKind =
  | "task-created"
  | "completed"
  | "reopened"
  | "handoff"
  | "human-note"
  | "agent-note"
  | "observation"
  | "artifact"
  | "fields"
  | "status"
  | "run-failed"
  | "blocked"
  | "run-activity"
  | "mechanical"; // only surfaces under --all

export interface TimelineItem {
  /** The item's instant (newest source event). */
  at: string;
  kind: TimelineKind;
  /** The primary object (a task id for run collapses; the object id otherwise). */
  objectId: string;
  /** Who: "human:<id>", "run:<runId>", or "clock:<id>". */
  actor: string;
  /** Bounded one-line summary (references only, never bodies). */
  summary: string;
  /** Drill-down: the source event ids folded into this item. */
  eventIds: readonly string[];
  /** Present when the item is one agent run's collapsed activity. */
  runId?: string;
  /** Executor profile derived from Run.assignee (`machine/agent`). This is a
   *  view field, not another persisted source of truth. */
  agent?: string;
  /** The host coding agent's opaque session hint. Full and unmodified so a
   *  human can use it for transcript drill-down; absent when the daemon did
   *  not capture one. Never provenance or authorization evidence. */
  agentSessionId?: string;
  /** Session attached to a non-run coding-agent write. */
  sessionId?: string;
}

export interface TimelineOptions {
  /** Only events strictly AFTER this instant (callers default to now-24h). */
  since?: string;
  /** Max items after filtering/collapsing (default 50, newest first). */
  limit?: number;
  /** Only this object's stream. */
  taskId?: string;
  /** Only this actorId (a runId, an email, "cli", ...). */
  actor?: string;
  /** Include the mechanical activity normally hidden. */
  all?: boolean;
}

const SUMMARY_CLIP = 140;

function clip(s: string): string {
  return s.length <= SUMMARY_CLIP ? s : `${s.slice(0, SUMMARY_CLIP - 1)}…`;
}

function actorOf(e: KernelEvent): string {
  const p = e.provenance;
  return p.entrance === "agent-run" ? `run:${p.actorId}` : `${p.entrance}:${p.actorId}`;
}

function statusDiff(e: KernelEvent): { old?: string; new?: string } {
  const d = e.diff?.status as { old?: unknown; new?: unknown } | undefined;
  return { old: d?.old as string | undefined, new: d?.new as string | undefined };
}

const TERMINAL = new Set(["done", "archived"]);

/** Classify ONE non-run event (human/clock provenance). Returns null for
 *  mechanical activity (hidden unless --all). */
function classifySingle(e: KernelEvent, snapshot: Snapshot): { kind: TimelineKind; summary: string } | null {
  switch (e.kind) {
    case "created": {
      const obj = snapshot.objects[e.objectId];
      if (obj?.archetype === "doc" || obj?.archetype === "mirror") {
        return { kind: "artifact", summary: `${obj.archetype} ${e.objectId} created` };
      }
      return { kind: "task-created", summary: e.note ?? `task ${e.objectId} created` };
    }
    case "status-changed": {
      const { old, new: next } = statusDiff(e);
      if (next !== undefined && TERMINAL.has(next)) {
        return { kind: "completed", summary: e.note ? `→ ${next}: ${e.note}` : `→ ${next}` };
      }
      if (old !== undefined && TERMINAL.has(old)) {
        return { kind: "reopened", summary: e.note ? `reopened (${old} → ${next}): ${e.note}` : `reopened (${old} → ${next})` };
      }
      return { kind: "status", summary: e.note ? `${old} → ${next}: ${e.note}` : `${old} → ${next}` };
    }
    case "assignee-changed": {
      const d = e.diff?.assignee as { old?: unknown; new?: unknown } | undefined;
      const base = `${String(d?.old ?? "—")} → ${String(d?.new ?? "—")}`;
      return { kind: "handoff", summary: e.note ? `${base}: ${e.note}` : base };
    }
    case "note":
      // A clock note is the dispatch-blocked / configuration channel; a human
      // note is a decision or comment. Both are attention-worthy.
      if (e.provenance.entrance === "clock") {
        return { kind: "blocked", summary: e.note ?? "" };
      }
      if (e.provenance.entrance === "agent") {
        if ((e.note ?? "").toLowerCase().includes("nothing actionable")) return null;
        return { kind: "agent-note", summary: e.note ?? "" };
      }
      return { kind: "human-note", summary: e.note ?? "" };
    case "observation":
      return { kind: "observation", summary: e.note ?? "observation recorded" };
    case "doc-updated":
      return { kind: "artifact", summary: `doc ${e.objectId}: ${e.note ?? "updated"}` };
    case "fields-changed": {
      // Reference changes are graph edits humans care about; other field noise
      // (a version bump, a body tweak) is mechanical.
      if (e.diff && "refs" in e.diff) {
        return { kind: "fields", summary: e.note ?? "references changed" };
      }
      return null;
    }
    case "run-returned": {
      const failed = (e.note ?? "").includes("returned failed");
      if (failed) return { kind: "run-failed", summary: e.note ?? "run failed" };
      return null; // ordinary success is mechanical on its own
    }
    case "run-started":
    case "trigger-discarded":
      return null;
  }
}

/** Fold one agent run's events into a single item, or null when the pass held
 *  nothing meaningful (a bare start/claim/success - or a note-only no-op check). */
function collapseRun(
  runId: string,
  events: KernelEvent[],
  runs: readonly RunRecord[],
  snapshot: Snapshot,
): TimelineItem | null {
  const last = events[events.length - 1]!;
  const run = runs.find((r) => r.id === runId);
  const agent = run?.assignee?.includes("/") ? run.assignee.slice(run.assignee.lastIndexOf("/") + 1) : undefined;
  const taskId = run?.taskId ?? last.objectId;

  const bits: string[] = [];
  let failed = false;
  let lastNote: string | null = null;
  let hasArtifact = false;
  for (const e of events) {
    switch (e.kind) {
      case "doc-updated":
        bits.push(`doc ${e.objectId}`);
        hasArtifact = true;
        break;
      case "created": {
        // A fresh doc/mirror is an ARTIFACT; a fresh task is minted work.
        const obj = snapshot.objects[e.objectId];
        if (obj?.archetype === "doc" || obj?.archetype === "mirror") {
          bits.push(`${obj.archetype} ${e.objectId}`);
          hasArtifact = true;
        } else {
          bits.push(`+${e.objectId}`);
        }
        break;
      }
      case "assignee-changed": {
        const d = e.diff?.assignee as { new?: unknown } | undefined;
        bits.push(`→ ${String(d?.new ?? "?")}${e.note ? ` (${e.note})` : ""}`);
        break;
      }
      case "observation":
        bits.push("observation");
        break;
      case "fields-changed":
        // An attach accompanies the artifact event in a full run projection. Do
        // not let the generic graph edit replace the meaningful artifact name.
        if (e.diff && "refs" in e.diff && !hasArtifact) bits.push("refs");
        break;
      case "status-changed": {
        const { new: next } = statusDiff(e);
        // The claim's todo→in-progress flip is mechanical; a terminal or
        // follow-up ending is the pass's outcome.
        if (next !== undefined && next !== "in-progress") bits.push(`status ${next}`);
        break;
      }
      case "run-returned":
        if ((e.note ?? "").includes("returned failed")) failed = true;
        break;
      case "note":
        if (e.note) lastNote = e.note;
        break;
      case "run-started":
      case "trigger-discarded":
        break;
    }
  }

  if (failed) {
    const note = events.find((e) => e.kind === "run-returned")?.note ?? "run failed";
    return {
      at: last.at,
      kind: "run-failed",
      objectId: taskId,
      actor: `run:${runId}`,
      summary: clip(note),
      eventIds: events.map((e) => e.id),
      runId,
      ...(agent ? { agent } : {}),
      ...(run?.agentSessionId ? { agentSessionId: run.agentSessionId } : {}),
    };
  }
  if (bits.length === 0) return null; // start + claim + ordinary return (or note-only no-op)
  if (lastNote) bits.push(lastNote);

  return {
    at: last.at,
    kind: "run-activity",
    objectId: taskId,
    actor: `run:${runId}`,
    summary: clip(bits.join(" · ")),
    eventIds: events.map((e) => e.id),
    runId,
    ...(agent ? { agent } : {}),
    ...(run?.agentSessionId ? { agentSessionId: run.agentSessionId } : {}),
  };
}

/** The one shared projection. `events` is the team's flat event list (any
 *  order); output is newest-first, bounded, collapsed. */
export function timelineView(
  snapshot: Snapshot,
  events: readonly KernelEvent[],
  opts: TimelineOptions = {},
): TimelineItem[] {
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : 50;
  const runTask = new Map(snapshot.runs.map((r) => [r.id, r.taskId]));
  const inScope = events.filter(
    (e) =>
      (opts.since === undefined || e.at > opts.since) &&
      (opts.taskId === undefined ||
        e.objectId === opts.taskId ||
        (e.provenance.entrance === "agent-run" && runTask.get(e.provenance.actorId) === opts.taskId)) &&
      (opts.actor === undefined || e.provenance.actorId === opts.actor),
  );
  const ordered = [...inScope].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));

  const items: TimelineItem[] = [];
  const runGroups = new Map<string, KernelEvent[]>();
  for (const e of ordered) {
    if (e.provenance.entrance === "agent-run") {
      const g = runGroups.get(e.provenance.actorId);
      if (g) g.push(e);
      else runGroups.set(e.provenance.actorId, [e]);
      continue;
    }
    const c = classifySingle(e, snapshot);
    if (c) {
      items.push({ at: e.at, kind: c.kind, objectId: e.objectId, actor: actorOf(e), summary: clip(c.summary), eventIds: [e.id], ...(e.provenance.sessionId ? { sessionId: e.provenance.sessionId } : {}) });
    } else if (opts.all) {
      items.push({ at: e.at, kind: "mechanical", objectId: e.objectId, actor: actorOf(e), summary: clip(e.note ?? e.kind), eventIds: [e.id], ...(e.provenance.sessionId ? { sessionId: e.provenance.sessionId } : {}) });
    }
  }
  for (const [runId, group] of runGroups) {
    const collapsed = collapseRun(runId, group, snapshot.runs, snapshot);
    if (collapsed) {
      items.push(collapsed);
    } else if (opts.all) {
      const last = group[group.length - 1]!;
      const run = snapshot.runs.find((r) => r.id === runId);
      const agent = run?.assignee?.includes("/") ? run.assignee.slice(run.assignee.lastIndexOf("/") + 1) : undefined;
      items.push({
        at: last.at,
        kind: "mechanical",
        objectId: last.objectId,
        actor: `run:${runId}`,
        summary: clip(group.map((e) => (e.note ? `${e.kind}: ${e.note}` : e.kind)).join(" · ")),
        eventIds: group.map((e) => e.id),
        runId,
        ...(agent ? { agent } : {}),
        ...(run?.agentSessionId ? { agentSessionId: run.agentSessionId } : {}),
      });
    }
  }

  items.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.eventIds[0]! < b.eventIds[0]! ? -1 : 1));
  return items.slice(0, limit);
}
