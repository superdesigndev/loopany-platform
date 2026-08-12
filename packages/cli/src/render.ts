/**
 * Text rendering for the human/agent CLI. The compact one-line event stream
 * inherits the rewrite `renderRecentRuns` discipline (§7): time / kind / actor /
 * note clipped to ~100 chars, but the sessionId is NEVER truncated — it is the
 * key to the agent's own `find … <sessionId>.jsonl` deep-dive (context ladder
 * rung ⑤).
 */
import {
  cronText,
  type LoopRow,
  slugify,
  taskDetailView,
  type TimelineItem,
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
import { formatLocalTime } from "./time.js";

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
    const lines = [`task ${t.id}  [${t.status}]  v${t.version}`, t.title];
    const routing = [
      ...(t.owner ? [`  owner: ${t.owner}`] : []),
      ...(t.assignee ? [`  assignee: ${t.assignee}`] : []),
      ...(t.workdir ? [`  workdir: ${t.workdir}`] : []),
    ];
    if (routing.length > 0) lines.push("", "routing:", ...routing);
    const metadata = [
      ...(t.priority ? [`  priority: ${t.priority}`] : []),
      ...(t.type ? [`  type: ${t.type}`] : []),
      ...(t.parent ? [`  parent: ${t.parent}`] : []),
      ...(t.followUpAt ? [`  follow-up: ${formatLocalTime(t.followUpAt)}`] : []),
      ...(t.goal != null ? [`  goal: ${t.goal}`] : []),
    ];
    if (metadata.length > 0) lines.push("", "details:", ...metadata);
    return lines;
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

/** The `show <id>` view: fields, body, then a Task's recent meaningful activity
 *  by default. `--log` replaces that projection with the raw event stream. */
export function renderShow(
  obj: KernelObject,
  snapshot: Snapshot,
  events: readonly KernelEvent[] | null,
  recent: readonly TimelineItem[] | null = null,
  expanded = false,
): string {
  const parts: string[] = [fieldLines(obj).join("\n")];
  // A task's live schedule + run pair + products + children belong in `show` -
  // this IS the Task Detail projection (kernel-product-visibility): the latest
  // key doc/mirror is findable here, never by reading raw events.
  if (obj.archetype === "task") {
    const trigs = snapshot.triggers.filter((t) => t.taskId === obj.id);
    const detail = taskDetailView(snapshot, obj.id, events ?? undefined);
    if (detail) {
      const loopLines: string[] = [];
      for (const t of trigs) loopLines.push(`  ${renderTriggerLine(t)}`);
      if (detail.activeRun) {
        loopLines.push(`  ${renderRunLine(detail.activeRun)}`);
        const trace = renderSessionTrace(detail.activeRun);
        if (trace) loopLines.push(trace);
      } else if (detail.lastRun) {
        const note = detail.lastRun.note ? `  ·  ${clip(detail.lastRun.note)}` : "";
        loopLines.push(`  last run ${detail.lastRun.id}: ${detail.lastRun.state}${note}`);
        const trace = renderSessionTrace(detail.lastRun);
        if (trace) loopLines.push(trace);
      }
      if (loopLines.length > 0) parts.push("", "loop:", ...loopLines);
      if (detail.products.length > 0) {
        const maxProducts = 5;
        let products = detail.products;
        if (!expanded && products.length > maxProducts) {
          const tracked = products.find(({ product }) => product.id === obj.tracks);
          const others = products.filter(({ product }) => product.id !== obj.tracks);
          products = tracked ? [tracked, ...others.slice(-(maxProducts - 1))] : others.slice(-maxProducts);
        }
        parts.push(
          "",
          !expanded && products.length < detail.products.length
            ? `products (latest ${products.length} of ${detail.products.length}; --all for all):`
            : "products:",
        );
        for (const { product, producedBy } of products) {
          const label =
            product.archetype === "doc"
              ? `doc ${product.id}${product.title && product.title !== product.id && product.title !== product.key ? `  ${clip(product.title, 60)}` : ""}`
              : `mirror ${product.id}  [${product.kind}] ${product.coords}`;
          const shepherd = obj.tracks === product.id ? "  (tracked)" : "";
          // Same axi-concise rule as the log lines: the kernel claim session
          // (`spawn-<runId>`) is derivable from the producing run - drop it.
          const bySession =
            producedBy?.sessionId && producedBy.sessionId !== `spawn-${producedBy.runId ?? ""}`
              ? ` session=${producedBy.sessionId}`
              : "";
          const by = producedBy ? `  ·  by ${producedBy.actor}${bySession}` : "";
          parts.push(`  ${label}${shepherd}${by}`);
        }
      }
      if (detail.children.length > 0) {
        parts.push("", "children:");
        for (const c of detail.children) parts.push(`  ${c.id}  [${c.status}]  ${clip(c.title, 60)}`);
      }
      const productIds = new Set(detail.products.map(({ product }) => product.id));
      const related = obj.refs
        .filter((id) => !productIds.has(id) && id !== obj.tracks)
        .map((id) => snapshot.objects[id])
        .filter((ref): ref is TaskObject => ref?.archetype === "task");
      if (related.length > 0) {
        parts.push("", "related:");
        for (const task of related) parts.push(`  task ${task.id}  [${task.status}]  ${clip(task.title, 60)}`);
      }
    }
  }
  const body = objectBody(obj);
  if (body) parts.push("\n" + body);
  if (events) {
    parts.push("\nlog:");
    parts.push(events.length > 0 ? events.map(renderEventLine).join("\n") : "  (no events)");
  } else if (obj.archetype === "task" && recent) {
    parts.push("\nrecent:");
    parts.push(recent.length > 0 ? renderTimeline(recent) : "  (no meaningful activity)");
  }
  return parts.join("\n");
}

export function renderTriggerLine(t: Trigger): string {
  const state = t.enabled ? "enabled" : `disabled (${t.disabledBy ?? "?"})`;
  const next = t.nextFireAt ? ` next=${formatLocalTime(t.nextFireAt)}` : "";
  return `trigger ${t.kind}: ${t.spec} [${state}]${next}`;
}

export function renderRunLine(r: RunRecord): string {
  return `run ${r.id}: ${r.cause} ${r.state} @${formatLocalTime(r.scheduledAt)} -> ${r.assignee ?? "—"}`;
}

/** The host agent's own session, with a COPYABLE trace command when its local
 * transcript convention is known (axi practice:
 *  a full never-clipped id plus the exact deep-dive invocation, so "what did
 *  that session actually do" is one paste away). Only rendered when the run
 *  carries an agentSessionId (claude runs report it at finish; replay shims and
 *  non-claude agents have none). */
export function renderSessionTrace(r: RunRecord): string | null {
  if (!r.agentSessionId) return null;
  const agent = r.assignee?.split("/").at(-1);
  if (agent === "claude" || agent === "claude-code") {
    return `  session ${r.agentSessionId}  ·  trace: find ~/.claude/projects -name '${r.agentSessionId}.jsonl'`;
  }
  return `  session ${r.agentSessionId}`;
}

/** ONE compact event line: 时间 / 类型 / actor / note (§7). The actor is the
 *  attributable identity `entrance:actorId` (§3) — the entrance alone collapses
 *  every human event to "human" and every agent event to "agent-run", losing the
 *  userId|runId|triggerId that actually attributes the action. sessionId is
 *  appended in FULL (never clipped) — but ONLY when it says something the actor
 *  column doesn't: the kernel's own claim session is always `spawn-<runId>`, so
 *  for an agent-run event it is derivable noise and axi-concise drops it. A
 *  session that DIFFERS from that shape (a human-attributed write from inside a
 *  session, a foreign host) still renders. */
export function renderEventLine(e: KernelEvent): string {
  const actor = `${e.provenance.entrance}:${e.provenance.actorId}`;
  const bits = [formatLocalTime(e.at), e.kind, actor];
  if (e.note) bits.push(clip(e.note));
  else if (e.diff) bits.push(clip(summarizeDiff(e.diff)));
  let line = `  ${bits.join("  ·  ")}`;
  const sid = e.provenance.sessionId;
  if (sid && !(e.provenance.entrance === "agent-run" && sid === `spawn-${e.provenance.actorId}`)) {
    line += `  ·  session=${sid}`;
  }
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

/** Statuses the default tree COLLAPSES (not hides — the aggregate tail and the
 *  collapse summary lines still count every one; axi: no silent truncation). */
const COLLAPSED_STATUSES = new Set(["done", "archived"]);

// The no-filter tree renders at most TWO levels (§10: "深度 2 + 截断提示") —
// structurally: roots render their children as rows, a child's own children
// never render and surface as its inline `+N deeper (show <id>)` suffix. The
// cutoff is a cheap render-side guard; treeView itself stays the full source
// of truth (kernel + web share it).

/** A subtree is collapsible when EVERY node in it is done/archived — a done
 *  parent with a live descendant stays visible so the live work never hides. */
function subtreeCollapsed(node: TreeNode): boolean {
  return COLLAPSED_STATUSES.has(node.task.status) && node.children.every(subtreeCollapsed);
}

function subtreeSize(node: TreeNode): number {
  let n = 1;
  for (const c of node.children) n += subtreeSize(c);
  return n;
}

function countDescendants(node: TreeNode): number {
  return subtreeSize(node) - 1;
}

/**
 * The default `list` view is a DECISION SURFACE (axi): live work renders as
 * rows; fully-done subtrees collapse into one `… N done` summary per sibling
 * group (`--all` expands). Children connect with `├─`/`└─` guides; root
 * subtrees separate with a blank line. The tail counts ALWAYS cover the full
 * tree, collapsed and depth-cut nodes included.
 */
export function renderTree(nodes: readonly TreeNode[], snapshot: Snapshot, now: string, expanded = false): string {
  // Full counts first, independent of what renders — the tail line must never
  // under-report what exists (axi: no silent truncation).
  let total = 0;
  const byStatus = new Map<string, number>();
  const countAll = (n: TreeNode): void => {
    total += 1;
    byStatus.set(n.task.status, (byStatus.get(n.task.status) ?? 0) + 1);
    for (const c of n.children) countAll(c);
  };
  for (const n of nodes) countAll(n);
  if (total === 0) return "(no tasks)";

  const collapsed = (n: TreeNode): boolean => !expanded && subtreeCollapsed(n);
  const blocks: string[] = [];
  let hiddenRootTasks = 0;
  for (const root of nodes) {
    if (collapsed(root)) {
      hiddenRootTasks += subtreeSize(root);
      continue;
    }
    const lines = [nodeLine(root, snapshot, now, false)];
    const visible = root.children.filter((c) => !collapsed(c));
    const hiddenHere = root.children.filter(collapsed).reduce((s, c) => s + subtreeSize(c), 0);
    visible.forEach((c, i) => {
      const conn = i === visible.length - 1 && hiddenHere === 0 ? "└─ " : "├─ ";
      lines.push(conn + nodeLine(c, snapshot, now, true));
    });
    if (hiddenHere > 0) lines.push(`└─ … ${hiddenHere} done  (\`list --all\` shows them)`);
    blocks.push(lines.join("\n"));
  }
  if (hiddenRootTasks > 0) blocks.push(`… ${hiddenRootTasks} done  (\`list --all\` shows them)`);

  // Pre-computed aggregate tail (axi): one orientation line, statuses in a
  // stable order so agents can pattern-match it.
  const order = ["todo", "in-progress", "follow-up", "review", "idea", "done", "archived"];
  const counts = order
    .filter((s) => byStatus.has(s))
    .map((s) => `${byStatus.get(s)} ${s}`)
    .join(" · ");
  blocks.push(`— ${total} task${total === 1 ? "" : "s"}: ${counts}`);
  return blocks.join("\n\n");
}

/** A node's row plus its inline depth-cut suffix. Under MAX_TREE_DEPTH only a
 *  depth-1 node can have hidden descendants (roots always render their
 *  children as rows), so `isChild` gates the `+N deeper (show <id>)` suffix —
 *  the inline replacement for the old orphan "… N more" truncation line. */
function nodeLine(node: TreeNode, snapshot: Snapshot, now: string, isChild: boolean): string {
  const row = renderTaskRow(node.task, snapshot, now);
  const deeper = countDescendants(node);
  return isChild && deeper > 0 ? `${row}  ·  +${deeper} deeper (show ${node.task.id})` : row;
}

/** One task row, every dispatch-relevant fact visible (tree-v2 taskLine lineage,
 *  sim seo-scale rounds 1-2), NO icons — plain-text tags only (2026-08-12):
 *  explicit `@—` for unassigned (claimability is a load-bearing state, never
 *  render it as absence), a `[loop]` tag + humanized cadence + relative next
 *  fire for a cron task, the follow-up DATE (with `(due)` once matured), an
 *  active-run marker `run <state>` so a task mid-handoff is never mistaken for
 *  claimable, and the clipped TITLE (skipped when it adds nothing over the id).
 *  A stale todo shows `waiting <age>` (≥1h) so stuck work is visible at a scan. */
function renderTaskRow(task: TaskObject, snapshot: Snapshot, now: string): string {
  const bits: string[] = [];
  const cron = snapshot.triggers.find((t) => t.taskId === task.id && t.kind === "cron");
  if (cron) {
    if (!cron.enabled) bits.push(`paused(${cron.disabledBy ?? "?"})`);
    else {
      bits.push(cronText(cron.spec));
      if (cron.nextFireAt) bits.push(`next ${untilText(Date.parse(now), cron.nextFireAt)}`);
    }
  }
  if (task.followUpAt) {
    const due = Date.parse(task.followUpAt) <= Date.parse(now);
    bits.push(`follow-up ${formatLocalTime(task.followUpAt)}${due ? " (due)" : ""}`);
  }
  const active = snapshot.runs.find(
    (r) => r.taskId === task.id && (r.state === "pending" || r.state === "claimed" || r.state === "running"),
  );
  if (active) bits.push(`run ${active.state}`);
  else if (task.status === "todo") {
    // Stale-work signal: age since last touch, shown once it exceeds an hour
    // (a fresh task's "waiting 0m" would be pure noise).
    const ms = Date.parse(now) - Date.parse(task.updatedAt);
    if (ms >= 3_600_000) bits.push(`waiting ${age(ms)}`);
  }
  if (task.tracks) bits.push(`tracks ${task.tracks}`);
  const tail = bits.length > 0 ? `  ·  ${bits.join("  ·  ")}` : "";
  // The title is the human-readable column; skip it only when the id IS the
  // slugified title (it would repeat the id verbatim).
  const title = slugify(task.title) === task.id ? "" : `  ${clip(task.title, 60)}`;
  return `${task.id}  [${task.status}]${cron ? " [loop]" : ""} @${task.assignee ?? "—"}${title}${tail}`;
}

/** Compact time-until-future, deterministic under --now: "due"/"in 50m"/"in 2h"/"in 3d". */
function untilText(nowMs: number, t: string): string {
  const s = Math.round((Date.parse(t) - nowMs) / 1000);
  if (s <= 0) return "due";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/** A filtered/flat list with breadcrumbs to the root (§10). SAME row renderer
 *  as the tree — a filtered worklist is what a pull-mode consumer reads, so
 *  assignee/loop/follow-up/title must survive here too (no second row grammar
 *  to drift). */
export function renderFlatList(list: readonly TaskObject[], snapshot: Snapshot, now: string): string {
  if (list.length === 0) return "(no matches)";
  return list.map((t) => `${renderTaskRow(t, snapshot, now)}${crumbs(t, snapshot)}`).join("\n");
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

/** Humanize an age in ms as the largest sensible unit (2d / 5h / 12m). */
function age(ms: number): string {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The human decision surface: each item leads with id/reason/title, then a
 *  CONTEXT line - where the work came from (parent), the product to inspect
 *  before deciding (tracks), and how long it has been waiting (vs updatedAt,
 *  which the assigning update stamped). `now` keeps the age deterministic
 *  under --now/LOOPANY_NOW. */
export function renderInbox(
  items: readonly InboxItem[],
  now?: string,
  /** The derived default hand-back agent per task id (handbackTargetFor) -
   *  turns the inbox into a copy-paste decision surface: the human answers
   *  without knowing any machine/profile address by heart. Null/absent =
   *  underivable, the hint asks them to pick an agent explicitly. */
  handbackTargets?: Readonly<Record<string, string | null>>,
): string {
  if (items.length === 0) return "(inbox empty)";
  const nowMs = now !== undefined ? Date.parse(now) : Date.now();
  return items
    .map((i) => {
      const head = `${i.task.id}  [${i.reason}]  ${clip(i.task.title, 60)}  ← ${i.task.assignee ?? "—"}`;
      const bits = [
        ...(i.task.parent ? [`from ${i.task.parent}`] : []),
        ...(i.task.tracks ? [`inspect ${i.task.tracks}`] : []),
        `waiting ${age(nowMs - Date.parse(i.task.updatedAt))}`,
      ];
      const target = handbackTargets?.[i.task.id];
      const hint =
        target != null
          ? `hand back: update ${i.task.id} assignee=${target} status=todo --note "<your reply>"`
          : target === null
            ? `hand back: update ${i.task.id} assignee=<agent> status=todo --note "<your reply>"  (no prior agent - pick one)`
            : null;
      return `${head}\n      ${bits.join(" · ")}${hint ? `\n      ${hint}` : ""}`;
    })
    .join("\n");
}

// ---- loops (the Loops projection - kernel-product-visibility) ----

/** One loop per line: id, humanized cadence (raw spec in parens when they
 *  differ - this is the edit surface, the literal cron matters here), next
 *  fire, then the STATE column - blocked (with the config note), an in-flight
 *  run, the last result, or quiet. No icons - plain-text tags (2026-08-12).
 *  Machine availability is a server-side fact and rides the server surfaces,
 *  not this local projection. */
export function renderLoops(rows: readonly LoopRow[]): string {
  if (rows.length === 0) return "(no loops - a loop is a task with a cron)";
  return rows
    .map((r) => {
      const human = cronText(r.trigger.spec);
      const cadence = human === r.trigger.spec ? r.trigger.spec : `${human} (${r.trigger.spec})`;
      const head = `${r.task.id}  ${cadence}  next=${r.trigger.enabled ? (r.trigger.nextFireAt ? formatLocalTime(r.trigger.nextFireAt) : "—") : `paused(${r.trigger.disabledBy ?? "?"})`}`;
      const state = r.blockedNote
        ? `blocked: ${clip(r.blockedNote)}`
        : r.activeRun
          ? `run ${r.activeRun.id}: ${r.activeRun.state}`
          : r.lastRun
            ? `last: ${r.lastRun.state}${r.lastRun.note ? ` · ${clip(r.lastRun.note, 80)}` : ""}`
            : "quiet";
      const machine = r.machinePresence ? `  ·  machine ${r.machinePresence}` : "";
      return `${head}${machine}\n      ${state}`;
    })
    .join("\n");
}

// ---- timeline ----

/** One line per item: `<at>  <kind>  <objectId>  ·  <actor>` then the bounded
 *  summary. References only - drill down via `show <id> --log`. */
export function renderTimeline(items: readonly TimelineItem[]): string {
  if (items.length === 0) return "(no meaningful activity in range — try --since or --all)";
  return items
    .map((i) => {
      const agent = i.agent ? `  ·  agent ${i.agent}` : "";
      const session = i.agentSessionId ? `  ·  session ${i.agentSessionId}` : "";
      return `${formatLocalTime(i.at)}  [${i.kind}]  ${i.objectId}  ·  ${i.actor}${agent}${session}\n      ${i.summary}`;
    })
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
