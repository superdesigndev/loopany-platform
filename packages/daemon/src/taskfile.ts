/**
 * Pure task-README helpers — the daemon-side twin of the server's forgiving
 * front-matter reader (`server/frontmatter.ts`), plus the WRITE operations the
 * server deliberately never does (the file lives on this machine; the file is
 * the task's source of truth).
 *
 * Same paranoia rules as the server parser: only a leading `---` fence counts,
 * the scanned block is bounded, unknown keys are PRESERVED, and every writer is
 * surgical — `patchFrontmatter` touches exactly the keys asked, byte-preserving
 * the body and any keys/comments it doesn't understand.
 */

export const TASK_TYPES = ["goal", "strategy", "experiment", "task", "idea"] as const;
export const TASK_STATUSES = ["idea", "todo", "in-progress", "follow-up", "done", "archived"] as const;
export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/** Front-matter keys that are task WORK-STATE (live in the file, never on the
 *  server envelope). `update <id> k=v` writes these into the README. */
export const WORK_STATE_KEYS = new Set([
  "title",
  "type",
  "status",
  "priority",
  "owner",
  "assignee",
  "parent",
  "refs",
  "follow_up_date",
  "order",
]);

const MAX_BLOCK_BYTES = 8 * 1024;

/** Slug a title: lowercase, alnum runs joined by single hyphens, bounded. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "task"
  );
}

interface FmBlock {
  /** Index of the first char AFTER the opening fence line. */
  start: number;
  /** Index of the first char of the closing fence line. */
  end: number;
  /** The raw lines between the fences (no fence lines). */
  lines: string[];
}

/** Locate the leading front-matter block; null when absent/unclosed (bounded). */
function findBlock(content: string): FmBlock | null {
  const open = /^---[ \t]*\r?\n/.exec(content);
  if (!open) return null;
  const start = open[0].length;
  const region = content.slice(start, start + MAX_BLOCK_BYTES);
  const close = /(^|\n)(---[ \t]*)(\r?\n|$)/.exec(region);
  if (!close) return null;
  const end = start + close.index + (close[1] === "\n" ? 1 : 0);
  return { start, end, lines: content.slice(start, end).split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "")) };
}

/** Read the top-level `key: value` scalars (unknown keys kept) — forgiving, never throws. */
export function readFrontmatter(content: string): Record<string, string> {
  const block = findBlock(content);
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const raw of block.lines) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key)) continue;
    let value = line.slice(colon + 1).trim();
    if (!value) continue;
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Surgically set/replace/delete front-matter keys (`null` deletes). Existing key
 * lines are edited in place (order + unknown keys + comments preserved); new
 * keys append at the block's end. A file with NO front matter gains a fresh
 * block above its body. The body is byte-preserved.
 */
export function patchFrontmatter(content: string, patch: Record<string, string | null>): string {
  const block = findBlock(content);
  if (!block) {
    const fields = Object.entries(patch).filter(([, v]) => v !== null) as Array<[string, string]>;
    if (!fields.length) return content;
    return `---\n${fields.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${content}`;
  }
  const pending = new Map(Object.entries(patch));
  const lines = content.slice(block.start, block.end).split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    const key = colon > 0 && !/^\s/.test(line) ? line.slice(0, colon).trim() : null;
    if (key && pending.has(key)) {
      const v = pending.get(key)!;
      pending.delete(key);
      if (v === null) continue; // delete the line
      kept.push(`${key}: ${v}`);
    } else {
      kept.push(line);
    }
  }
  // Trailing empty artifact of split when the block ends with \n.
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  for (const [k, v] of pending) if (v !== null) kept.push(`${k}: ${v}`);
  return `${content.slice(0, block.start)}${kept.join("\n")}\n${content.slice(block.end)}`;
}

/**
 * Append one dated, attributed line to `## Timeline` (created at EOF when
 * missing). The entry lands at the END of the section — before the next `## `
 * heading if one follows. Append-only by construction.
 */
export function appendTimeline(content: string, line: string, opts: { date?: string; actor?: string } = {}): string {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const entry = `- ${date} | ${line.trim()}${opts.actor ? ` (${opts.actor})` : ""}`;
  const heading = /^## Timeline[ \t]*$/m.exec(content);
  if (!heading) {
    const sep = content.endsWith("\n") ? "" : "\n";
    return `${content}${sep}\n## Timeline\n${entry}\n`;
  }
  const afterHeading = heading.index + heading[0].length;
  const nextHeading = /^## /m.exec(content.slice(afterHeading + 1));
  const sectionEnd = nextHeading ? afterHeading + 1 + nextHeading.index : content.length;
  const before = content.slice(0, sectionEnd).replace(/\n+$/, "\n");
  const after = content.slice(sectionEnd);
  const pad = after && !after.startsWith("\n") ? "\n" : "";
  return `${before}${entry}\n${pad}${after}`;
}

/**
 * The doc WITHOUT its legacy `## Timeline` section — for DISPLAY only (`get`
 * renders the merged events timeline instead; the raw bytes stay authoritative
 * for checkout/push). Same heading anchor as appendTimeline; the section runs
 * to the next `## ` heading or EOF. No section ⇒ content unchanged.
 */
export function stripTimelineSection(content: string): string {
  // Grammar mirrors the server splitter (docSplit.ts): any heading level,
  // case-insensitive, `timeline` as the first word; the section runs to the
  // NEXT heading of any level or EOF. (The server's `doc` field is preferred
  // when present — this is the old-server fallback, so the two must agree.)
  const heading = /^#{1,6}[ \t]+timeline\b.*$/im.exec(content);
  if (!heading) return content;
  const afterHeading = heading.index + heading[0].length;
  const nextHeading = /^#{1,6}[ \t]/m.exec(content.slice(afterHeading + 1));
  const sectionEnd = nextHeading ? afterHeading + 1 + nextHeading.index : content.length;
  return `${content.slice(0, heading.index).replace(/\n+$/, "\n")}${content.slice(sectionEnd)}`;
}

/** Scaffold a fresh task README (frontmatter + the canonical three sections). */
export function scaffoldReadme(fields: {
  slug: string;
  title: string;
  type?: string;
  status?: string;
  priority?: string;
  owner?: string;
  /** Human assignee (an email/handle); the executor assignee lives server-side. */
  assignee?: string;
  parent?: string;
  body?: string;
  date?: string;
}): string {
  const fm: Array<[string, string]> = [
    ["id", fields.slug],
    ["title", fields.title],
    ["type", fields.type ?? "task"],
    ["status", fields.status ?? "idea"],
    ["priority", fields.priority ?? "P2"],
  ];
  if (fields.owner) fm.push(["owner", fields.owner]);
  if (fields.assignee) fm.push(["assignee", fields.assignee]);
  if (fields.parent) fm.push(["parent", fields.parent]);
  const created = fields.date ?? new Date().toISOString().slice(0, 10);
  fm.push(["created", created]);
  // No `## Timeline` section: the record plane is EVENTS (the server emits a
  // "Created." event at create; notes/status changes land as events too). The
  // doc carries only Spec + Current understanding. appendTimeline still creates
  // the section on demand for the legacy file-edit path.
  return [
    "---",
    ...fm.map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    "## Spec",
    fields.body?.trim() || "(what this task is — fill in)",
    "",
    "## Current understanding",
    "",
  ].join("\n");
}

/** Normalized-token overlap in [0,1] for the fuzzy-dup warning on create. */
export function titleSimilarity(a: string, b: string): number {
  const tok = (s: string) => new Set(slugify(s).split("-").filter((t) => t.length > 2));
  const ta = tok(a);
  const tb = tok(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size);
}
