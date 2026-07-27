/**
 * Hand-rolled subset front-matter parser for loop products — ZERO deps (repo
 * precedent: `parseUnifiedDiff` in `runDiff.ts` deliberately avoided a diff lib;
 * this deliberately avoids a YAML lib). A markdown product MAY open with a fenced
 * `---` block of simple top-level `key: value` scalars; this reads that block and
 * nothing else.
 *
 * The convention is SOFT — prompt + UI incentive, never a sync/storage gate. So
 * this parser is forgiving by construction: it only attempts when the content
 * opens with a `---` fence, bounds the scanned block (a few KB), skips any line it
 * can't read as a top-level scalar, and returns null/partial on ANY malformation —
 * it NEVER throws. A file that isn't fronted, or whose block is broken, is simply
 * untyped (meta null), which is exactly how old blobs behave.
 *
 * Pure string work (no bytes interpreted, no execution) so the server's zero-exec
 * invariant holds; the ingress points decode a non-binary blob to utf8 and hand
 * the text here.
 */

/** The indexed subset of a product's front matter — every field OPTIONAL.
 *  Presence of `date` marks a dated product; its absence marks a living doc.
 *  `type` is an open, per-loop classification label; `title` a display title. */
export interface ArtifactMeta {
  type?: string;
  title?: string;
  date?: string;
  /** Review-queue convention (F7): `status: needs-review` flags a product for a
   *  human's eyes; anything else (or absence) keeps it out of the queue. Open
   *  string like `type` — the QUEUE query matches the one value, the parser
   *  stays vocabulary-free. */
  status?: string;
  /** Optional review deadline (YYYY-MM-DD) — surfaces ⏰ ordering in the queue. */
  due?: string;
}

// ---- task-node front matter (the loop's own README) ----

/** Task-node vocabularies. TS-side only (SQLite stores plain text) — widening is
 *  a type change, never a migration. The WRITE surfaces (CLI + validateTaskPatch)
 *  enforce these; this parser merely drops values outside them. */
export const TASK_TYPES = ["goal", "strategy", "experiment", "task", "idea"] as const;
export const TASK_STATUSES = ["idea", "todo", "in-progress", "follow-up", "done", "archived"] as const;
export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** The indexed subset of a task README's front matter — every field OPTIONAL.
 *  `id` is the task's slug (and its folder name); `parent` references another
 *  task's slug (the tree lives here, not in folder nesting). Work-state lives
 *  ONLY in the file; this is a derived index, parsed at taskFileContent ingress
 *  (store.updateLoop / createLoop) — never authoritative on its own. */
export interface TaskMeta {
  id?: string;
  title?: string;
  type?: TaskType;
  status?: TaskStatus;
  priority?: TaskPriority;
  owner?: string;
  /** The HUMAN assignee (an email/handle). `owner:`
   *  is read as a legacy alias when `assignee:` is absent. The EXECUTOR assignee
   *  lives in the envelope (machineId+agent), never in the file. */
  assignee?: string;
  parent?: string;
  refs?: string[];
  follow_up_date?: string;
  order?: number;
}

/** Don't scan past this many bytes for the closing fence — a real front-matter
 *  block is a handful of short lines; anything larger is not front matter and we
 *  refuse to walk a whole multi-MB file looking for a `---`. */
const MAX_BLOCK_BYTES = 8 * 1024;
/** A scalar value longer than this is clipped — the meta row is an index, not a
 *  content store (the body already lives in the blob). */
const MAX_VALUE_LEN = 500;
/** A key must be a short identifier-ish token; anything else isn't a scalar line. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Strip one layer of matching surrounding quotes (single or double). */
function unquote(v: string): string {
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the top-level `key: value` scalars from a leading `---` front-matter
 * block. Returns the full scalar map (unknown keys KEPT — the convention tolerates
 * them), or null when there's no opening fence / no closing fence within the
 * bound / no scalar lines at all. Never throws.
 */
export function parseFrontMatter(content: string): Record<string, string> | null {
  if (typeof content !== "string") return null;
  // Tolerate a leading BOM, but the very first meaningful chars must be the fence.
  let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  // Only attempt when the content OPENS with a `---` fence line (nothing before it).
  const openMatch = /^---[ \t]*\r?\n/.exec(text);
  if (!openMatch) return null;

  // Bound the region we scan for the closing fence.
  const region = text.slice(openMatch[0].length, openMatch[0].length + MAX_BLOCK_BYTES);
  const lines = region.split("\n");

  const out: Record<string, string> = {};
  let closed = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    // Closing fence — a line that is exactly `---` (trailing spaces tolerated).
    if (/^---[ \t]*$/.test(line)) {
      closed = true;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue; // blank / comment → skip
    const colon = line.indexOf(":");
    if (colon <= 0) continue; // not a `key: value` line (list item, prose, …) → skip
    // Top-level only: an indented line is nested structure, not a scalar we index.
    if (/^\s/.test(line)) continue;
    const key = line.slice(0, colon).trim();
    if (!KEY_RE.test(key)) continue; // not a simple scalar key → skip
    let value = line.slice(colon + 1).trim();
    if (!value) continue; // `key:` with no scalar (a nested block follows) → skip
    value = unquote(value).slice(0, MAX_VALUE_LEN);
    if (!value) continue; // empty after unquoting
    if (!(key in out)) out[key] = value; // first wins (a dup key is malformed-ish)
  }

  if (!closed) return null; // no closing fence within the bound → not front matter
  return Object.keys(out).length ? out : null;
}

/**
 * The indexed subset — `{type?, title?, date?}` — for a non-binary product's text,
 * or null when the file has no usable front matter. This is what the blob row
 * stores; unknown scalar fields are dropped here (kept by the parser, ignored by
 * storage + UI). `date` is stored RAW (validity is the consumer's concern — the
 * calendar decides whether it's a real day).
 */
export function artifactMeta(content: string): ArtifactMeta | null {
  const fm = parseFrontMatter(content);
  if (!fm) return null;
  const meta: ArtifactMeta = {};
  if (fm.type) meta.type = fm.type;
  if (fm.title) meta.title = fm.title;
  if (fm.date) meta.date = fm.date;
  if (fm.status) meta.status = fm.status;
  if (fm.due) meta.due = fm.due;
  return Object.keys(meta).length ? meta : null;
}

/** Case-guarded enum pick: returns the canonical member when `raw` matches one
 *  (exact, trimmed), else undefined — a mistyped value degrades to "unset",
 *  never to an error (the convention is forgiving at READ; strict at WRITE). */
function pickEnum<T extends string>(raw: string | undefined, members: readonly T[]): T | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  return members.includes(v as T) ? (v as T) : undefined;
}

/**
 * The indexed task subset of a README's front matter, or null when the file has
 * no usable front matter / none of the task keys. Same forgiving contract as
 * `artifactMeta`: never throws; invalid enum values are dropped; `order` must
 * parse as a finite number; `refs` splits a comma-separated scalar (or a YAML
 * flow list `[a, b]`) into trimmed slugs. Dates are stored RAW — validity is the
 * consumer's concern.
 */
export function taskMeta(content: string): TaskMeta | null {
  const fm = parseFrontMatter(content);
  if (!fm) return null;
  const meta: TaskMeta = {};
  if (fm.id) meta.id = fm.id;
  if (fm.title) meta.title = fm.title;
  const type = pickEnum(fm.type, TASK_TYPES);
  if (type) meta.type = type;
  // "review" is the retired spelling of "follow-up" (tracker-speak implied a human
  // approval gate; the real semantics are "shipped — check the outcome when
  // follow_up_date arrives"). Old files keep working; the index is canonical.
  const status = pickEnum(fm.status === "review" ? "follow-up" : fm.status, TASK_STATUSES);
  if (status) meta.status = status;
  const priority = pickEnum(fm.priority, TASK_PRIORITIES);
  if (priority) meta.priority = priority;
  if (fm.owner) meta.owner = fm.owner;
  const assignee = fm.assignee || fm.owner; // owner: = legacy alias for the human assignee
  if (assignee) meta.assignee = assignee;
  if (fm.parent) meta.parent = fm.parent;
  if (fm.refs) {
    const refs = fm.refs
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (refs.length) meta.refs = refs;
  }
  if (fm.follow_up_date) meta.follow_up_date = fm.follow_up_date;
  if (fm.order !== undefined) {
    const order = Number(fm.order);
    if (Number.isFinite(order)) meta.order = order;
  }
  return Object.keys(meta).length ? meta : null;
}

/**
 * Surgical front-matter patch: set/replace the given keys (null = remove the
 * line), byte-preserving everything else. No front matter yet ⇒ a block is
 * created at the top. This is the SERVER-side work-state write (a run or a
 * cross-machine owner edit has no local file to patch); the daemon has its own
 * equivalent for local file edits.
 */
export function patchFrontMatterContent(content: string, patch: Record<string, string | null>): string {
  const open = /^---[ \t]*\r?\n/.exec(content);
  const close = open ? /\r?\n---[ \t]*(\r?\n|$)/.exec(content.slice(open[0].length)) : null;
  if (!open || !close) {
    const fields = Object.entries(patch).filter(([, v]) => v !== null) as Array<[string, string]>;
    if (!fields.length) return content;
    return `---\n${fields.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${content}`;
  }
  const start = open[0].length;
  const end = start + close.index;
  const pending = new Map(Object.entries(patch));
  const kept: string[] = [];
  for (const line of content.slice(start, end).split("\n")) {
    const colon = line.indexOf(":");
    const key = colon > 0 && !/^\s/.test(line) ? line.slice(0, colon).trim() : null;
    if (key && pending.has(key)) {
      const v = pending.get(key)!;
      pending.delete(key);
      if (v === null) continue;
      kept.push(`${key}: ${v}`);
    } else {
      kept.push(line);
    }
  }
  for (const [k, v] of pending) if (v !== null) kept.push(`${k}: ${v}`);
  return `${content.slice(0, start)}${kept.join("\n")}${content.slice(end)}`;
}
