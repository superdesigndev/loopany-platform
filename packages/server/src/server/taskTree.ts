/**
 * Pure task-tree assembly over `loops` rows + their derived `taskMeta` index.
 * Shared by the machine gateway (device-token `loopany list/get/search`) and the
 * web `listTasks` server fn, so the CLI and the Tasks page can never drift.
 *
 * Everything here is pure, bounded, in-memory work over PROJECTED rows (a
 * machine/team has tens of tasks, not thousands) — no store access, no I/O.
 * Hand-edited files are untrusted-ish: a `parent:` cycle or an orphaned parent
 * must degrade (render as roots), never hang or throw.
 */
import type { Loop, TaskMeta } from "../db/schema.js";

/** One task, projected for tree/list rendering (never carries taskFileContent —
 *  list output stays bounded; the full node is `get`'s job). */
export interface TaskRow {
  /** The loop row's opaque id (stable, unique). */
  loopId: string;
  /** The task's slug (taskMeta.id) — the human/agent-facing handle; null for a
   *  legacy loop whose README has no task front matter. */
  slug: string | null;
  /** Display title: front-matter title → loop name → loop id. */
  title: string;
  type: TaskMeta["type"] | null;
  status: TaskMeta["status"] | null;
  priority: TaskMeta["priority"] | null;
  owner: string | null;
  /** The HUMAN assignee (`assignee:` front matter; `owner:` = legacy alias). */
  assignee: string | null;
  /** Parent SLUG reference (the tree lives in front matter, not folders). */
  parent: string | null;
  follow_up_date: string | null;
  /** External references (URLs/tickets/paths) from `refs:` front matter —
   *  R11: how a task ATTACHES material without owning a folder. */
  refs: string[] | null;
  order: number | null;
  /** Schedule; null ⇒ inert task. */
  cron: string | null;
  enabled: boolean;
  machineId: string;
  /** Owning team — lets the Tasks page offer a team/device filter without a
   *  second round trip. Null only for a loop created before teams existed. */
  teamId: string | null;
  /** Machine-local README path — lets the owner CLI (same machine) edit the
   *  file (`update`/`mv` write work-state into front matter). */
  taskFile: string | null;
}

export interface TaskTreeNode extends TaskRow {
  children: TaskTreeNode[];
  /** Set when `depth` cut this node's subtree: how many DIRECT children were hidden. */
  childrenTruncated?: number;
}

export interface FlatTaskRow extends TaskRow {
  /** Ancestor titles root→parent (breadcrumb context for scattered matches). */
  breadcrumb: string[];
}

/** Project a loops row to its task-tree shape.
 *
 *  The `status` field carries the completedAt OVERLAY: a finished goal loop
 *  (`loopany finish` stamped `completedAt`) projects as `done` even when its
 *  README front matter lags. This unifies the two completion representations at
 *  the READ layer — the server cannot write `status: done` into the README (the
 *  file lives on the machine; sync is one-way up), so unifying at the write
 *  layer would mean a second writer on the file. Derived here, the row and the
 *  file cannot disagree in any consumer (web tree, CLI list/get, filters). */
export function toTaskRow(loop: Loop): TaskRow {
  const m = loop.taskMeta ?? null;
  return {
    loopId: loop.id,
    slug: m?.id ?? null,
    title: m?.title ?? loop.name ?? loop.id,
    type: m?.type ?? null,
    status: loop.completedAt != null ? "done" : (m?.status ?? null),
    priority: m?.priority ?? null,
    owner: m?.owner ?? null,
    assignee: m?.assignee ?? m?.owner ?? null,
    parent: m?.parent ?? null,
    follow_up_date: m?.follow_up_date ?? null,
    refs: m?.refs ?? null,
    order: m?.order ?? null,
    cron: loop.cron ?? null,
    enabled: loop.enabled,
    machineId: loop.machineId,
    teamId: loop.teamId ?? null,
    taskFile: loop.taskFile ?? null,
  };
}

/** Resolve a row by slug or loop id within a projected set. Returns all matches
 *  (slug collisions are possible across hand-edited files — the caller decides
 *  whether >1 is a 409). Loop-id match is exact and unique by construction. */
export function resolveRows(rows: TaskRow[], idOrSlug: string): TaskRow[] {
  const byLoopId = rows.filter((r) => r.loopId === idOrSlug);
  if (byLoopId.length) return byLoopId;
  return rows.filter((r) => r.slug === idOrSlug);
}

/** Band-aware sibling sort: priority band (P0 first, unset last) then `order`
 *  (unset last), then title — mirrors worknode's `mv` band semantics. */
function bySiblingOrder(a: TaskRow, b: TaskRow): number {
  const pa = a.priority ?? "P9";
  const pb = b.priority ?? "P9";
  if (pa !== pb) return pa < pb ? -1 : 1;
  const oa = a.order ?? Number.MAX_SAFE_INTEGER;
  const ob = b.order ?? Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  return a.title.localeCompare(b.title);
}

/** Parent lookup is by SLUG; a row with no slug can never be a parent. */
function childrenIndex(rows: TaskRow[]): Map<string, TaskRow[]> {
  const bySlug = new Map<string, TaskRow>();
  for (const r of rows) if (r.slug && !bySlug.has(r.slug)) bySlug.set(r.slug, r);
  const kids = new Map<string, TaskRow[]>();
  for (const r of rows) {
    if (!r.parent) continue;
    const parent = bySlug.get(r.parent);
    if (!parent || parent === r) continue; // orphan / self-parent → treated as root
    const list = kids.get(parent.slug!) ?? [];
    list.push(r);
    kids.set(parent.slug!, list);
  }
  return kids;
}

/**
 * Roots = rows whose `parent` is absent, unresolvable (orphan), or part of a
 * cycle. Cycle detection: walk each row's ancestor chain with a visited set —
 * any row that never reaches a true root is in (or under) a cycle; the cycle's
 * members all surface as roots so nothing silently disappears.
 */
function rootsOf(rows: TaskRow[]): TaskRow[] {
  const bySlug = new Map<string, TaskRow>();
  for (const r of rows) if (r.slug && !bySlug.has(r.slug)) bySlug.set(r.slug, r);
  const roots: TaskRow[] = [];
  for (const r of rows) {
    const parent = r.parent ? bySlug.get(r.parent) : undefined;
    if (!parent || parent === r) {
      roots.push(r);
      continue;
    }
    // Ancestor walk with cycle guard: if we re-visit, r sits in a cycle → root.
    const seen = new Set<string>([r.loopId]);
    let cur: TaskRow | undefined = parent;
    let cyclic = false;
    while (cur) {
      if (seen.has(cur.loopId)) {
        cyclic = true;
        break;
      }
      seen.add(cur.loopId);
      cur = cur.parent ? bySlug.get(cur.parent) : undefined;
    }
    if (cyclic) roots.push(r);
  }
  return roots;
}

/**
 * Assemble the nested tree. `rootId` (slug or loop id) scopes to one subtree
 * (the node itself is the single root); `depth` bounds LEVELS below each root
 * (depth 2 = children + grandchildren), stamping `childrenTruncated` where cut.
 */
export function buildTaskTree(rows: TaskRow[], opts: { rootId?: string; depth?: number } = {}): TaskTreeNode[] {
  const depth = Number.isFinite(opts.depth) && opts.depth! > 0 ? Math.floor(opts.depth!) : 2;
  const kids = childrenIndex(rows);
  const build = (row: TaskRow, levelsLeft: number, onPath: Set<string>): TaskTreeNode => {
    const node: TaskTreeNode = { ...row, children: [] };
    const direct = (row.slug ? kids.get(row.slug) ?? [] : []).filter((c) => !onPath.has(c.loopId));
    if (!direct.length) return node;
    if (levelsLeft <= 0) {
      node.childrenTruncated = direct.length;
      return node;
    }
    const nextPath = new Set(onPath);
    nextPath.add(row.loopId);
    node.children = direct
      .slice()
      .sort(bySiblingOrder)
      .map((c) => build(c, levelsLeft - 1, nextPath));
    return node;
  };

  const roots = opts.rootId ? resolveRows(rows, opts.rootId) : rootsOf(rows);
  return roots
    .slice()
    .sort(bySiblingOrder)
    .map((r) => build(r, depth, new Set()));
}

export interface TaskFilters {
  status?: string;
  priority?: string;
  /** Review nodes whose follow_up_date has arrived (`list --due`). */
  due?: boolean;
  /** Only tasks with a schedule (`list --recurring`). */
  recurring?: boolean;
  /** Human assignee match (`list --assignee <email>`; `owner:` is a legacy alias). */
  assignee?: string;
  /** Scope (slug or loop id): the node itself + every descendant. */
  parentId?: string;
}

/** `now` is injectable for tests; defaults to today (date-only compare, so a
 *  follow_up_date of today already counts as due). */
export function filterTasks(rows: TaskRow[], f: TaskFilters, now: Date = new Date()): FlatTaskRow[] {
  let scope = rows;
  if (f.parentId) {
    const roots = resolveRows(rows, f.parentId);
    const kids = childrenIndex(rows);
    const keep = new Set<string>();
    const walk = (r: TaskRow): void => {
      if (keep.has(r.loopId)) return;
      keep.add(r.loopId);
      if (r.slug) for (const c of kids.get(r.slug) ?? []) walk(c);
    };
    for (const r of roots) walk(r);
    scope = rows.filter((r) => keep.has(r.loopId));
  }
  const today = now.toISOString().slice(0, 10);
  const out = scope.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.priority && r.priority !== f.priority) return false;
    if (f.recurring && !r.cron) return false;
    if (f.assignee && r.assignee !== f.assignee) return false;
    if (f.due && !(r.status === "follow-up" && r.follow_up_date != null && r.follow_up_date <= today)) return false;
    return true;
  });

  // Breadcrumbs: ancestor titles root→parent, cycle-guarded (a cycle yields the
  // partial chain walked so far — context, not correctness-critical).
  const bySlug = new Map<string, TaskRow>();
  for (const r of rows) if (r.slug && !bySlug.has(r.slug)) bySlug.set(r.slug, r);
  const withCrumbs = out.map((r): FlatTaskRow => {
    const crumb: string[] = [];
    const seen = new Set<string>([r.loopId]);
    let cur = r.parent ? bySlug.get(r.parent) : undefined;
    while (cur && !seen.has(cur.loopId) && crumb.length < 12) {
      seen.add(cur.loopId);
      crumb.unshift(cur.title);
      cur = cur.parent ? bySlug.get(cur.parent) : undefined;
    }
    return { ...r, breadcrumb: crumb };
  });
  return withCrumbs.sort(bySiblingOrder);
}

/** Immediate children of one node, sibling-sorted (for `get`'s children rows). */
export function childrenOf(rows: TaskRow[], node: TaskRow): TaskRow[] {
  if (!node.slug) return [];
  return (childrenIndex(rows).get(node.slug) ?? []).slice().sort(bySiblingOrder);
}
