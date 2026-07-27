/**
 * Task-file → three-plane splitter: front matter → fields (already derived into
 * `taskMeta` at ingress), `## Timeline` → seeded events, remainder → the doc
 * column. Pure and total — never throws, and nothing is silently dropped:
 *
 *  - Front-matter keys the derived index FULLY represents are subtracted (their
 *    information lives in `taskMeta`); everything else — unknown keys, invalid
 *    enum values, clipped scalars — is carried back into the doc verbatim as a
 *    reduced front-matter block.
 *  - Timeline lines become one event each: a parseable dated line yields
 *    `{at, actor?, text}`; an unparseable line is preserved raw as the event
 *    text, so the stream still holds every byte the section did.
 *  - The invariant: bytes(doc) + seeded events + derived fields ⊇ the original
 *    file's information. A file with no structure at all is one big doc.
 */
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES, parseFrontMatter, taskMeta } from "./frontmatter.js";

export interface SeededEvent {
  /** ISO timestamp when the line carried a parseable date (midnight UTC). */
  at?: string;
  /** Attribution when the line carried a `(someone)` marker after the date. */
  actor?: string;
  text: string;
}

export interface DocSplit {
  /** The doc column: the file minus derived front matter and the Timeline section. */
  doc: string;
  /** Seeded events, in file order (typically newest-first as authored). */
  events: SeededEvent[];
  /** Front-matter keys carried INTO the doc (not representable in the index). */
  carriedKeys: string[];
  /** Front-matter keys SUBTRACTED because the derived field index fully holds
   *  them — their information lives in the fields plane, not the doc. */
  representedKeys: string[];
}

/** Keys whose information the derived `taskMeta` index fully holds — subtractable
 *  ONLY when the parsed meta actually captured the value (an invalid enum or a
 *  clipped scalar is NOT represented and must be carried). */
const ENUM_KEYS: Record<string, readonly string[]> = {
  type: TASK_TYPES,
  status: TASK_STATUSES,
  priority: TASK_PRIORITIES,
};

const SCALAR_KEYS = new Set(["id", "title", "owner", "assignee", "parent", "follow_up_date", "refs", "order"]);

/** Matches the front-matter region (opening fence at byte 0 through the closing
 *  fence line), mirroring `parseFrontMatter`'s bounds. */
function frontMatterSpan(content: string): { end: number } | null {
  const open = /^---[ \t]*\r?\n/.exec(content);
  if (!open) return null;
  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(content.slice(open[0].length));
  if (!close) return null;
  return { end: open[0].length + close.index + close[0].length };
}

/** Timeline line shapes seen in real task files:
 *    - 2026-07-01: text          - **2026-07-01** — text
 *    - [2026-07-01] text         - 2026-07-01 (alice@x.dev): text
 *  A leading `- `/`* ` bullet is optional (bare dated paragraphs count too). */
// `|` included: it's the separator the daemon's own appendTimeline writes
// (`- 2026-07-01 | text`) — without it every daemon-authored line would seed
// with a "| " prefix glued to the text.
const TIMELINE_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|\[)?(\d{4}-\d{2}-\d{2})(?:\*\*|\])?\s*(?:\(([^)]+)\))?\s*(?:[:—–|-]\s*)?(.*)$/;

function parseTimelineLine(line: string): SeededEvent {
  const m = TIMELINE_LINE.exec(line);
  if (m && m[3]?.trim()) {
    return { at: `${m[1]}T00:00:00.000Z`, ...(m[2]?.trim() ? { actor: m[2].trim() } : {}), text: m[3].trim() };
  }
  // Unparseable (prose, continuation, undated bullet) — preserve the raw line.
  return { text: line.trim() };
}

export function splitTaskDoc(content: string): DocSplit {
  if (typeof content !== "string" || !content.trim()) return { doc: content ?? "", events: [], carriedKeys: [], representedKeys: [] };

  // ---- front matter: subtract represented keys, carry the remainder ----
  const fm = parseFrontMatter(content);
  const meta = taskMeta(content) ?? {};
  const span = fm ? frontMatterSpan(content) : null;
  let body = span ? content.slice(span.end) : content;
  const carried: Array<[string, string]> = [];
  if (fm) {
    for (const [key, value] of Object.entries(fm)) {
      const inEnum = ENUM_KEYS[key];
      if (inEnum) {
        // Represented iff the enum coercion accepted it (incl. the retired
        // `status: review` spelling, which the index maps to `follow-up`).
        const captured = key === "status" ? meta.status !== undefined && (value === "review" || value === meta.status) : (meta as Record<string, unknown>)[key] === value;
        if (!captured) carried.push([key, value]);
        continue;
      }
      if (SCALAR_KEYS.has(key)) {
        const held =
          key === "refs"
            ? meta.refs !== undefined
            : key === "order"
              ? meta.order !== undefined
              : key === "owner"
                ? meta.owner === value
                : (meta as Record<string, unknown>)[key] === value;
        if (!held) carried.push([key, value]);
        continue;
      }
      // Unknown key — the index has no home for it; carry it verbatim.
      carried.push([key, value]);
    }
  }

  // ---- Timeline section → events ----
  const events: SeededEvent[] = [];
  const lines = body.split("\n");
  const kept: string[] = [];
  let inTimeline = false;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      if (/^timeline\b/i.test(heading[2]!.trim())) {
        inTimeline = true;
        continue; // the heading itself is structure, fully replaced by the stream
      }
      inTimeline = false;
      kept.push(line);
      continue;
    }
    if (inTimeline) {
      if (!line.trim()) continue;
      const ev = parseTimelineLine(line);
      // An undated line after an entry is that entry's CONTINUATION (real files
      // wrap long entries across lines) — merge, don't fragment the record.
      if (!ev.at && events.length) {
        const last = events[events.length - 1]!;
        last.text = `${last.text}\n${ev.text}`;
      } else {
        events.push(ev);
      }
      continue;
    }
    kept.push(line);
  }
  body = kept.join("\n");

  // Re-emit only the carried front-matter keys at the top of the doc — from the
  // ORIGINAL lines, not the parsed values (the parser clips long scalars at its
  // index budget; a carried key must keep every byte).
  const fmRegion = span ? content.slice(0, span.end).split("\n") : [];
  const rawFmLine = (key: string): string | undefined => fmRegion.find((l) => l.startsWith(`${key}:`));
  const carriedBlock = carried.length ? `---\n${carried.map(([k, v]) => rawFmLine(k) ?? `${k}: ${v}`).join("\n")}\n---\n` : "";
  const doc = `${carriedBlock}${body.replace(/^\n+/, carriedBlock ? "\n" : "")}`;

  return { doc, events, carriedKeys: carried.map(([k]) => k), representedKeys: fm ? Object.keys(fm).filter((k) => !carried.some(([c]) => c === k)) : [] };
}
