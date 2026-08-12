/**
 * Text rendering for the human/agent CLI. The compact one-line event stream
 * inherits the rewrite `renderRecentRuns` discipline (§7): time / kind / actor /
 * note clipped to ~100 chars, but the sessionId is NEVER truncated — it is the
 * key to the agent's own `find … <sessionId>.jsonl` deep-dive (context ladder
 * rung ⑤).
 */
import {
  type LoopRow,
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
    return [
      `task ${t.id}  (v${t.version})`,
      `title: ${t.title}`,
      `status: ${t.status}`,
      `assignee: ${t.assignee ?? "—"}`,
      `owner: ${t.owner ?? "—"}`,
      `priority: ${t.priority ?? "—"}`,
      `type: ${t.type ?? "—"}`,
      `parent: ${t.parent ?? "—"}`,
      `tracks: ${t.tracks ?? "—"}`,
      `refs: ${t.refs.length > 0 ? t.refs.join(", ") : "—"}`,
      `followUpAt: ${t.followUpAt ? formatLocalTime(t.followUpAt) : "—"}`,
      `workdir: ${t.workdir ?? "—"}`,
      ...(t.goal != null ? [`goal (finish line): ${t.goal}`] : []),
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
  // A task's live schedule + run pair + products + children belong in `show` -
  // this IS the Task Detail projection (kernel-product-visibility): the latest
  // key doc/mirror is findable here, never by reading raw events.
  if (obj.archetype === "task") {
    const trigs = snapshot.triggers.filter((t) => t.taskId === obj.id);
    for (const t of trigs) parts.push(renderTriggerLine(t));
    const detail = taskDetailView(snapshot, obj.id, events ?? undefined);
    if (detail) {
      if (detail.activeRun) {
        parts.push(renderRunLine(detail.activeRun));
        const trace = renderSessionTrace(detail.activeRun);
        if (trace) parts.push(trace);
      } else if (detail.lastRun) {
        const note = detail.lastRun.note ? `  ·  ${clip(detail.lastRun.note)}` : "";
        parts.push(`last run ${detail.lastRun.id}: ${detail.lastRun.state}${note}`);
        const trace = renderSessionTrace(detail.lastRun);
        if (trace) parts.push(trace);
      }
      if (detail.products.length > 0) {
        parts.push("products:");
        for (const { product, producedBy } of detail.products) {
          const label =
            product.archetype === "doc"
              ? `doc ${product.id}  ${clip(product.title ?? product.key, 60)}`
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
        parts.push("children:");
        for (const c of detail.children) parts.push(`  ${c.id}  [${c.status}]  ${clip(c.title, 60)}`);
      }
    }
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
  const next = t.nextFireAt ? ` next=${formatLocalTime(t.nextFireAt)}` : "";
  return `trigger ${t.kind}: ${t.spec} [${state}]${next}`;
}

export function renderRunLine(r: RunRecord): string {
  return `run ${r.id}: ${r.cause} ${r.state} @${formatLocalTime(r.scheduledAt)} -> ${r.assignee ?? "—"}`;
}

/** The host agent's own session, with a COPYABLE trace command (axi practice:
 *  a full never-clipped id plus the exact deep-dive invocation, so "what did
 *  that session actually do" is one paste away). Only rendered when the run
 *  carries an agentSessionId (claude runs report it at finish; replay shims and
 *  non-claude agents have none). */
export function renderSessionTrace(r: RunRecord): string | null {
  if (!r.agentSessionId) return null;
  return `  session ${r.agentSessionId}  ·  trace: find ~/.claude/projects -name '${r.agentSessionId}.jsonl'`;
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
    bits.push(`⏰ ${formatLocalTime(task.followUpAt)}${due ? " (due)" : ""}`);
  }
  const active = snapshot.runs.find(
    (r) => r.taskId === task.id && (r.state === "pending" || r.state === "claimed" || r.state === "running"),
  );
  if (active) bits.push(`▶ ${active.state}`);
  if (task.tracks) bits.push(`◇${task.tracks}`);
  const tail = bits.length > 0 ? `  ·  ${bits.join("  ·  ")}` : "";
  return `${indent}${task.id}  [${task.status}] @${task.assignee ?? "—"}${tail}`;
}

/** A filtered/flat list with breadcrumbs to the root (§10). Carries the same
 *  dispatch-relevant fields as the tree row — a filtered worklist is what a
 *  pull-mode consumer reads, so assignee/follow-up state must survive here too. */
export function renderFlatList(list: readonly TaskObject[], snapshot: Snapshot): string {
  if (list.length === 0) return "(no matches)";
  return list
    .map((t) => {
      const due = t.followUpAt ? `  ·  ⏰ ${formatLocalTime(t.followUpAt)}` : "";
      return `${t.id}  [${t.status}] @${t.assignee ?? "—"}${crumbs(t, snapshot)}${due}`;
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

/** One loop per line: id, cadence, next fire, then the STATE column - blocked
 *  (with the config note), an in-flight run, the last result, or quiet. Machine
 *  availability is a server-side fact and rides the server surfaces, not this
 *  local projection. */
export function renderLoops(rows: readonly LoopRow[]): string {
  if (rows.length === 0) return "(no loops - a loop is a task with a cron)";
  return rows
    .map((r) => {
      const head = `${r.task.id}  ⟳ ${r.trigger.spec}  next=${r.trigger.enabled ? (r.trigger.nextFireAt ? formatLocalTime(r.trigger.nextFireAt) : "—") : `paused(${r.trigger.disabledBy ?? "?"})`}`;
      const state = r.blockedNote
        ? `⚠ ${clip(r.blockedNote)}`
        : r.activeRun
          ? `▶ ${r.activeRun.state} run ${r.activeRun.id}`
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
    .map((i) => `${formatLocalTime(i.at)}  [${i.kind}]  ${i.objectId}  ·  ${i.actor}\n      ${i.summary}`)
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
