/**
 * gateway/toon.ts — a pure, dependency-free TOON serializer (the axi-conformance
 * spine, batch 1). Every `/api/machine/cli` verb renders its result through these
 * helpers into the response `text` field the daemon prints. Batch 1 rode the
 * structured JSON fields ALONGSIDE (superset body); batch 7 retired that — the
 * `/api/machine/cli` boundary (`finalizeCli`) now STRIPS to `{text, exitCode, loops,
 * runs}`, so `text` is the sole render channel (the legacy endpoints keep the full
 * structured bodies, they don't pass through `finalizeCli`).
 *
 * TOON (token-oriented object notation, https://axi.md/) is the axi default output:
 * braces/commas/quotes omitted where unambiguous. The shapes this module produces
 * mirror the gh-axi reference tool observed live:
 *
 *   detail block   →  topKey:\n  key: value            (`gh-axi pr view`)
 *   typed list     →  name[N]{f1,f2}:\n  v1,v2          (`gh-axi pr list`)
 *   count aggregate → count: N [(showing first M)]      (P4)
 *   empty state    →  count: 0\n  name: []              (P5)
 *   help[]         →  help[N]:\n  Run `…`               (P9)
 *   structured err →  error: "…"\n  code: SLUG          (P6, to stdout)
 *   truncation     →  … (truncated, N chars total — use --full to see complete body)
 *
 * Every function is pure (no I/O, no clock) so the whole surface is unit-testable in
 * isolation (`toon.test.ts`).
 */

export type Scalar = string | number | boolean | null | undefined;

/** The axi placeholder for an absent value — a bare em-dash, mirroring gh-axi. */
export const ABSENT = "—";

/** A double-quoted string is needed when the bare token would be ambiguous inside a
 *  `key: value` line or a comma-delimited row: an empty string, or one carrying
 *  whitespace, a comma, a colon, or a double-quote. This matches gh-axi's observable
 *  behavior (every value it leaves bare is a single delimiter-free token; anything
 *  with a space/comma/colon it quotes). */
export function needsQuote(s: string): boolean {
  return s === "" || /[\s,:"]/.test(s);
}

/** Always wrap a string in double quotes, escaping backslashes, quotes, and newlines
 *  so the value survives on a single line (`\n` rendered as two chars, like gh-axi's
 *  body field). Used for error messages (always quoted, per gh-axi) and by `scalar`
 *  when quoting is required. */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

/** Render one scalar the TOON way: a finite number / boolean bare, null|undefined as
 *  the em-dash placeholder, a string bare unless it needs quoting. */
export function scalar(v: Scalar): string {
  if (v === null || v === undefined) return ABSENT;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : ABSENT;
  if (typeof v === "boolean") return v ? "true" : "false";
  return needsQuote(v) ? quote(v) : v;
}

/** A single top-level `key: value` line (value scalar-rendered). */
export function kvLine(key: string, v: Scalar): string {
  return `${key}: ${scalar(v)}`;
}

/**
 * A detail block: a top key, then each field indented two spaces as `key: value`.
 * The value may be a pre-rendered raw string (pass a `{ raw }`) so composite values
 * (e.g. a size hint or an already-quoted body) render verbatim.
 *
 *   topKey:
 *     name: "Docs Sweep"
 *     cron: "0 6 * * 1"
 */
export function detailBlock(topKey: string, rows: Array<[string, Scalar | { raw: string }]>): string {
  const lines = [`${topKey}:`];
  for (const [k, v] of rows) {
    const rendered = v !== null && typeof v === "object" && "raw" in v ? v.raw : scalar(v);
    lines.push(`  ${k}: ${rendered}`);
  }
  return lines.join("\n");
}

/** The `count:` aggregate line (P4). `total` → `count: N of TOTAL total` (a windowed
 *  survey); `showing` → `count: N (showing first SHOWING)`; else `count: N`. */
export function countLine(count: number, opts: { total?: number; showing?: number } = {}): string {
  if (opts.total !== undefined) return `count: ${count} of ${opts.total} total`;
  if (opts.showing !== undefined) return `count: ${count} (showing first ${opts.showing})`;
  return `count: ${count}`;
}

/**
 * A typed list block: the header row `name[N]{f1,f2}:` then each record as an
 * indented comma row (cells scalar-rendered, quoted only when needed). Does NOT emit
 * the `count:` line — compose it with `countLine` so the caller controls the
 * aggregate flavor.
 *
 *   loops[2]{id,name,cron,enabled}:
 *     loop-abc,"Docs Sweep","0 6 * * 1",on
 */
export function listBlock(name: string, fields: string[], rows: Scalar[][]): string {
  const lines = [`${name}[${rows.length}]{${fields.join(",")}}:`];
  for (const row of rows) lines.push(`  ${row.map(scalar).join(",")}`);
  return lines.join("\n");
}

/** A definitive empty collection (P5): the bare `name: []` line. Pair with
 *  `countLine(0)` for the full `count: 0` + `name: []` empty state. */
export function emptyList(name: string): string {
  return `${name}: []`;
}

/**
 * An inline array value on one line: `key[N]: a<sep>b<sep>c` (each item
 * scalar-rendered). Used for short lists that read better inline than as a block —
 * `applied[2]: cron, goal` (sep `, `) or `nextRuns[3]: "…" · "…"` (sep ` · `).
 */
export function inlineArray(key: string, items: Scalar[], sep = ", "): string {
  return `${key}[${items.length}]: ${items.map(scalar).join(sep)}`;
}

/**
 * A contextual-disclosure help block (P9): `help[N]:` then each command template
 * indented two spaces, verbatim (they carry backticks + `<placeholders>`).
 */
export function helpBlock(lines: string[]): string {
  return [`help[${lines.length}]:`, ...lines.map((l) => `  ${l}`)].join("\n");
}

/**
 * A structured error (P6): the message (always quoted) plus a bare machine-readable
 * slug, both to stdout. Slugs: VALIDATION_ERROR, FORBIDDEN, NOT_FOUND, CONFLICT,
 * UNAUTHORIZED, RATE_LIMITED, ERROR.
 *
 *   error: "status must be new|resolved|nothing-new (got \"wibble\")"
 *   code: VALIDATION_ERROR
 */
export function errorBlock(message: string, code: string): string {
  return `error: ${quote(message)}\ncode: ${code}`;
}

/** The axi error-code slug for an HTTP status (P6). */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return "ERROR";
  }
}

/**
 * Content truncation with a size hint (P3). A string within `cap` passes through
 * unchanged; a longer one is clipped to `cap` chars and gets the hint appended INSIDE
 * the value (so a caller can quote the whole thing as one field, like gh-axi's body).
 * `tail` is the escape-hatch phrasing — the full `use --full to see complete body`
 * for a detail body, or a terse `use --full` for a dense list cell.
 */
export function truncate(
  text: string,
  cap: number,
  tail = "use --full to see complete body",
): { value: string; truncated: boolean } {
  if (text.length <= cap) return { value: text, truncated: false };
  return {
    value: `${text.slice(0, cap)} (truncated, ${text.length} chars total — ${tail})`,
    truncated: true,
  };
}

/** Join document sections with a single newline, dropping empty/blank sections so a
 *  missing optional block (e.g. no rejections) leaves no stray blank line. */
export function doc(...sections: Array<string | null | undefined | false>): string {
  return sections.filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
}
