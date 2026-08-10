/**
 * Text rendering for the human/agent CLI. The compact one-line event stream
 * inherits the rewrite `renderRecentRuns` discipline (§7): time / kind / actor /
 * note clipped to ~100 chars, but the sessionId is NEVER truncated — it is the
 * key to the agent's own `find … <sessionId>.jsonl` deep-dive (context ladder
 * rung ⑤).
 */
import {
  type InboxItem,
  type KernelEvent,
  type KernelObject,
  type RunRecord,
  type Snapshot,
  type TaskObject,
  type TreeNode,
  type Trigger,
} from "@loopany/kernel";
import type { DriverError } from "./driver.js";

const NOTE_CLIP = 100;

export function clip(s: string, max = NOTE_CLIP): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// ---- errors + notices ----

/** A refusal / conflict as `error:/code:/hint:` text (exit 1). */
export function renderError(err: DriverError): string {
  const lines = [`error: ${err.message}`, `code: ${err.code}`];
  if (err.issues && err.issues.length > 0) for (const i of err.issues) lines.push(`  - ${i}`);
  if (err.hint) lines.push(`hint: ${err.hint}`);
  return lines.join("\n");
}

/** Notices print LOUDLY on their own lines (the re-armed cron echo). */
export function renderNotices(notices: readonly string[]): string {
  return notices.map((n) => `» ${n}`).join("\n");
}

// ---- objects ----

function fieldLines(obj: KernelObject): string[] {
  if (obj.archetype === "task") {
    const t = obj;
    return [
      `task ${t.id}  (v${t.version})`,
      `title: ${t.title}`,
      `status: ${t.status}`,
      `assignee: ${t.assignee ?? "—"}`,
      `priority: ${t.priority ?? "—"}`,
      `type: ${t.type ?? "—"}`,
      `parent: ${t.parent ?? "—"}`,
      `tracks: ${t.tracks ?? "—"}`,
      `refs: ${t.refs.length > 0 ? t.refs.join(", ") : "—"}`,
      `followUpAt: ${t.followUpAt ?? "—"}`,
    ];
  }
  if (obj.archetype === "doc") {
    return [`doc ${obj.id}  (v${obj.version})`, `key: ${obj.key}`, `title: ${obj.title ?? "—"}`];
  }
  return [`mirror ${obj.id}  (v${obj.version})`, `kind: ${obj.kind}`, `coords: ${obj.coords}`];
}

function objectBody(obj: KernelObject): string | null {
  if (obj.archetype === "task" || obj.archetype === "doc") return obj.body.length > 0 ? obj.body : null;
  return null;
}

/** The `show <id>` view: fields, then the body, then (with --log) the compact
 *  one-line event stream. */
export function renderShow(
  obj: KernelObject,
  snapshot: Snapshot,
  events: readonly KernelEvent[] | null,
): string {
  const parts: string[] = [fieldLines(obj).join("\n")];
  // A task's live schedule + active run belong in `show` (they are the task's
  // FUTURE and HANDOFF — §3).
  if (obj.archetype === "task") {
    const trigs = snapshot.triggers.filter((t) => t.taskId === obj.id);
    for (const t of trigs) parts.push(renderTriggerLine(t));
    const active = snapshot.runs.find(
      (r) => r.taskId === obj.id && (r.state === "pending" || r.state === "claimed" || r.state === "running"),
    );
    if (active) parts.push(renderRunLine(active));
  }
  const body = objectBody(obj);
  if (body) parts.push("\n" + body);
  if (events) {
    parts.push("\nlog:");
    parts.push(events.length > 0 ? events.map(renderEventLine).join("\n") : "  (no events)");
  }
  return parts.join("\n");
}

export function renderTriggerLine(t: Trigger): string {
  const state = t.enabled ? "enabled" : `disabled (${t.disabledBy ?? "?"})`;
  const next = t.nextFireAt ? ` next=${t.nextFireAt}` : "";
  return `trigger ${t.kind}: ${t.spec} [${state}]${next}`;
}

export function renderRunLine(r: RunRecord): string {
  return `run ${r.id}: ${r.cause} ${r.state} @${r.scheduledAt} -> ${r.assignee ?? "—"}`;
}

/** ONE compact event line: 时间 / 类型 / actor / note (§7). The actor is the
 *  attributable identity `entrance:actorId` (§3) — the entrance alone collapses
 *  every human event to "human" and every agent event to "agent-run", losing the
 *  userId|runId|triggerId that actually attributes the action. sessionId is
 *  appended in FULL (never clipped). */
export function renderEventLine(e: KernelEvent): string {
  const actor = `${e.provenance.entrance}:${e.provenance.actorId}`;
  const bits = [e.at, e.kind, actor];
  if (e.note) bits.push(clip(e.note));
  else if (e.diff) bits.push(clip(summarizeDiff(e.diff)));
  let line = `  ${bits.join("  ·  ")}`;
  if (e.provenance.sessionId) line += `  ·  session=${e.provenance.sessionId}`;
  return line;
}

function summarizeDiff(diff: NonNullable<KernelEvent["diff"]>): string {
  return Object.entries(diff)
    .map(([k, { old, new: n }]) => `${k}: ${fmtVal(old)}→${fmtVal(n)}`)
    .join(", ");
}

function fmtVal(v: unknown): string {
  if (v === null) return "∅";
  if (Array.isArray(v)) return `[${v.join(",")}]`;
  return String(v);
}

// ---- tree / list ----

/** The no-filter tree renders at most TWO levels (§10: "深度 2 + 截断提示").
 *  A node whose own children are cut off gets a "… N more" truncation notice on
 *  its own indented line, so a deep tree never silently loses nodes and the
 *  reader knows to `list --parent`/`show` to drill in. The cutoff is a cheap
 *  render-side guard; treeView itself stays the full source of truth (kernel +
 *  web share it). */
const MAX_TREE_DEPTH = 1; // depth 0 (roots) + depth 1 (their children) = two levels

export function renderTree(nodes: readonly TreeNode[], snapshot: Snapshot, now: string): string {
  const out: string[] = [];
  let total = 0;
  const byStatus = new Map<string, number>();
  const walk = (node: TreeNode, depth: number): void => {
    out.push(renderTreeRow(node.task, snapshot, now, depth));
    total += 1;
    byStatus.set(node.task.status, (byStatus.get(node.task.status) ?? 0) + 1);
    if (depth >= MAX_TREE_DEPTH) {
      const hidden = countDescendants(node);
      if (hidden > 0) {
        // Hidden nodes still count in the totals — the tail line must never
        // under-report what exists (axi: no silent truncation).
        tally(node, byStatus, (n) => (total += n));
        out.push(`${"  ".repeat(depth + 1)}… ${hidden} more (deeper; drill in with \`show ${node.task.id}\`)`);
      }
      return;
    }
    for (const c of node.children) walk(c, depth + 1);
  };
  for (const n of nodes) walk(n, 0);
  if (out.length === 0) return "(no tasks)";
  // Pre-computed aggregate tail (axi): one orientation line, statuses in a
  // stable order so agents can pattern-match it.
  const order = ["todo", "in-progress", "follow-up", "review", "idea", "done", "archived"];
  const counts = order
    .filter((s) => byStatus.has(s))
    .map((s) => `${byStatus.get(s)} ${s}`)
    .join(" · ");
  out.push(`— ${total} task${total === 1 ? "" : "s"}: ${counts}`);
  return out.join("\n");
}

function countDescendants(node: TreeNode): number {
  let n = 0;
  for (const c of node.children) n += 1 + countDescendants(c);
  return n;
}

/** Fold a truncated node's hidden descendants into the aggregate counts. */
function tally(node: TreeNode, byStatus: Map<string, number>, addTotal: (n: number) => void): void {
  for (const c of node.children) {
    byStatus.set(c.task.status, (byStatus.get(c.task.status) ?? 0) + 1);
    addTotal(1);
    tally(c, byStatus, addTotal);
  }
}

/** One task row, every dispatch-relevant fact visible (tree-v2 taskLine lineage,
 *  sim seo-scale rounds 1-2): explicit `@—` for unassigned (claimability is a
 *  load-bearing state, never render it as absence), the cron SPEC not just a
 *  marker, the follow-up DATE (with `(due)` once matured), and an active-run
 *  marker `▶ <state>` so a task mid-handoff is never mistaken for claimable. */
function renderTreeRow(task: TaskObject, snapshot: Snapshot, now: string, depth: number): string {
  const indent = "  ".repeat(depth);
  const bits: string[] = [];
  const cron = snapshot.triggers.find((t) => t.taskId === task.id && t.kind === "cron");
  if (cron) bits.push(`⟳ ${cron.spec}${cron.enabled ? "" : " (paused)"}`);
  if (task.followUpAt) {
    const due = Date.parse(task.followUpAt) <= Date.parse(now);
    bits.push(`⏰ ${task.followUpAt}${due ? " (due)" : ""}`);
  }
  const active = snapshot.runs.find(
    (r) => r.taskId === task.id && (r.state === "pending" || r.state === "claimed" || r.state === "running"),
  );
  if (active) bits.push(`▶ ${active.state}`);
  if (task.tracks) bits.push(`◇${task.tracks}`);
  const tail = bits.length > 0 ? `  ·  ${bits.join("  ·  ")}` : "";
  return `${indent}${task.id}  [${task.status}] @${task.assignee ?? "—"}  ${clip(task.title, 60)}${tail}`;
}

/** A filtered/flat list with breadcrumbs to the root (§10). Carries the same
 *  dispatch-relevant fields as the tree row — a filtered worklist is what a
 *  pull-mode consumer reads, so assignee/follow-up state must survive here too. */
export function renderFlatList(list: readonly TaskObject[], snapshot: Snapshot): string {
  if (list.length === 0) return "(no matches)";
  return list
    .map((t) => {
      const due = t.followUpAt ? `  ·  ⏰ ${t.followUpAt}` : "";
      return `${t.id}  [${t.status}] @${t.assignee ?? "—"}${crumbs(t, snapshot)}  ${clip(t.title, 60)}${due}`;
    })
    .join("\n");
}

function crumbs(task: TaskObject, snapshot: Snapshot): string {
  const path: string[] = [];
  let cursor = task.parent;
  const seen = new Set<string>([task.id]);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const p = snapshot.objects[cursor];
    if (!p || p.archetype !== "task") break;
    path.unshift(p.id);
    cursor = p.parent;
  }
  return path.length > 0 ? `  (${path.join(" › ")})` : "";
}

// ---- inbox ----

export function renderInbox(items: readonly InboxItem[]): string {
  if (items.length === 0) return "(inbox empty)";
  return items
    .map((i) => `${i.task.id}  [${i.reason}]  ${clip(i.task.title, 60)}  ← ${i.task.assignee ?? "—"}`)
    .join("\n");
}

// ---- search ----

export function renderSearchHits(hits: readonly KernelObject[]): string {
  if (hits.length === 0) return "(no matches)";
  return hits
    .map((o) => {
      const label =
        o.archetype === "task"
          ? `${o.id}  [task/${o.status}]  ${clip(o.title, 60)}`
          : o.archetype === "doc"
            ? `${o.id}  [doc]  ${clip(o.title ?? o.key, 60)}`
            : `${o.id}  [mirror/${o.kind}]  ${o.coords}`;
      return label;
    })
    .join("\n");
}
