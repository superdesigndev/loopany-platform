/**
 * THE REWRITE CLI's RENDER LAYER — pure, no I/O, no clock of its own.
 *
 * The CLI is a thin shell (CLI spec §2.3): it attaches the credential, posts the
 * bytes, renders the response as TOON, and maps the status to an exit code. All
 * teaching PROSE is authored server-side and printed verbatim; what lives here is
 * the SHAPE — the axi grammar of §3, so an agent can read any response without
 * parsing sentences.
 *
 * Everything is a pure function of (response body, flags) so the golden outputs
 * are unit-testable without a server, a network, or a filesystem.
 */

/** The axi absent-value placeholder. Deliberately an em-dash: it is the one
 *  place in this repo where that character is the contract (see gateway/toon.ts). */
export const ABSENT = "—";

/** The sentinel a pre-rendered value carries (see `raw`). A NUL can never appear
 *  in real content, so it is unambiguous — but it must never reach stdout, which is
 *  why every consumer strips it rather than assuming its own position is safe. */
const RAW_MARKER = "\u0000";

/** §3.1's quoting rule: bare unless empty, or carrying whitespace/comma/colon/quote. */
export function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return ABSENT;
  // A pre-rendered value (see `raw`) reaching a QUOTED position — a typed-list
  // cell, an inline array — keeps its text but loses its escape hatch:
  // `detailBlock` can print it bare because `key: value` has no separator to
  // break, and a comma-separated row does. Emitting the sentinel itself would put
  // a literal NUL byte on stdout, which is never right.
  const text = typeof value === "string" ? stripRaw(value) : JSON.stringify(value);
  const flat = text.replace(/\n/g, "\\n");
  return /[\s,:"]/.test(flat) ? JSON.stringify(flat) : flat;
}

export function detailBlock(topKey: string, rows: [string, unknown][]): string {
  return `${topKey}:\n${rows.map(([key, value]) => `  ${key}: ${typeof value === "string" && value.startsWith(RAW_MARKER) ? value.slice(1) : cell(value)}`).join("\n")}\n`;
}

/** A pre-rendered value: printed as-is, escaping the quoting rule. Used where the
 *  spec shows a raw annotation next to a value (`2026-08-05T09:00:00Z (due, 4h ago)`). */
export function raw(text: string): string {
  return `${RAW_MARKER}${text}`;
}

/** Drop the sentinel, keeping the text. */
function stripRaw(value: string): string {
  return value.startsWith(RAW_MARKER) ? value.slice(1) : value;
}

export function typedList(name: string, fields: string[], rows: unknown[][]): string {
  if (!rows.length) return `${name}: []\n`;
  return `${name}[${rows.length}]{${fields.join(",")}}:\n${rows.map((row) => `  ${row.map(cell).join(",")}`).join("\n")}\n`;
}

export function inlineArray(name: string, values: unknown[]): string {
  return values.length ? `${name}[${values.length}]: ${values.map(cell).join(", ")}\n` : `${name}[0]: ${ABSENT}\n`;
}

export function helpBlock(lines: string[]): string {
  return `help[${lines.length}]:\n${lines.map((line) => `  ${line}`).join("\n")}\n`;
}

export function countLine(shown: number, total?: number): string {
  return total !== undefined && total > shown ? `count: ${shown} of ${total} total\n` : `count: ${shown}\n`;
}

// ---------------------------------------------------------------- the error envelope

/** §3.3. One kernel-specific slug rides on 403 alongside FORBIDDEN because it
 *  names a guard an agent recovers from differently; everything else is derived
 *  from the HTTP status, so no prose is parsed. (`NOT_YOUR_LOOP` retired with
 *  the loop kind — a catalogue entry the server can no longer produce teaches a
 *  refusal nobody receives.) */
const KERNEL_SLUGS = new Set(["NOT_HUMAN"]);

export function slugFor(code: string | undefined, status: number): string {
  if (code && KERNEL_SLUGS.has(code)) return code;
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 400 && status < 500) return "VALIDATION_ERROR";
  return "ERROR";
}

/**
 * §4. A pure function of the HTTP status — an agent branches retry-vs-rewrite
 * without reading a word: 0 accepted, 1 transport (retry with backoff), 2 refused
 * with teaching (rewrite and retry once), 3 not found (re-enumerate, never retry
 * the same id).
 *
 * 401 and 429 are exit 1, not 2: neither is a mistake in the command, and
 * rewriting the command cannot fix either. (Adjudicated against the API spec's
 * blanket "all 4xx exit 2", which is being corrected spec-side.)
 */
export function exitForStatus(status: number): number {
  if (status >= 200 && status < 300) return 0;
  if (status === 404) return 3;
  if (status === 401 || status === 429 || status >= 500) return 1;
  return 2;
}

function verbatim(value: unknown): string {
  if (value === null || value === undefined || value === "") return ABSENT;
  return typeof value === "string" ? value.replace(/\n/g, "\\n") : JSON.stringify(value);
}

export interface Envelope {
  message: string;
  code: string;
  wrote?: unknown;
  expected?: unknown;
  allowed?: string[];
  /** Extra teaching lines the spec shows between `expected:` and `help[]`
   *  (`question:`, `asked:`, `entrance:`, `closed:`). */
  facts?: [string, unknown][];
  help: string[];
}

/** §3.4: parts 1-2 and the `help[]` tail are mandatory on every refusal. */
export function errorEnvelope(e: Envelope): string {
  // `wrote:`/`expected:` carry their values VERBATIM — that pair is the literal
  // rendering of the design's "you wrote / expected", and an agent diffs them
  // rather than parsing them. Only the `error:` sentence is quoted.
  let text = `error: ${JSON.stringify(e.message)}\ncode: ${e.code}\n`;
  if (e.wrote !== undefined) text += `wrote:    ${verbatim(e.wrote)}\n`;
  if (e.expected !== undefined) text += `expected: ${verbatim(e.expected)}\n`;
  if (e.allowed?.length) text += inlineArray("allowed", e.allowed);
  for (const [key, value] of e.facts ?? []) text += `${key}: ${cell(value)}\n`;
  return text + helpBlock(e.help.length ? e.help : ["read the refusal and retry with the legal form"]);
}

// -------------------------------------------------------------------- field labels

/** Wire (camelCase) → the printed name. The CLI prints the FILE's vocabulary,
 *  because that is the form an agent writes back. */
const LABELS: Record<string, string> = {
  followUpAt: "follow_up", pendingQuestion: "question", createdByRun: "created_by_run",
  createdByLoop: "created_by_loop", createdAt: "created", updatedAt: "updated",
  closedAt: "closed", nextFire: "next_fire", alreadyQueued: "already_queued",
};

export function label(field: string): string {
  return LABELS[field] ?? field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ------------------------------------------------------------------------- bodies

export const BODY_LIMIT = 600;

/** §3.1's truncation shape. The `--full` escape is named in the hint itself, so
 *  an agent that needs the rest never has to guess how to ask for it. */
export function bodyValue(body: string, full: boolean): string {
  if (full || body.length <= BODY_LIMIT) return body;
  return `${body.slice(0, BODY_LIMIT)}… (truncated, ${body.length} chars total — use --full to see complete body)`;
}

/** A `{old,new}` diff rendered as the `changed[N]` block. A body change is
 *  SUMMARIZED, not printed: the full diff renders on the object's page, and a run
 *  does not need to read back what it just wrote. */
export function changedBlock(diff: Record<string, { old?: unknown; new?: unknown }> | undefined): string {
  const entries = Object.entries(diff ?? {});
  if (!entries.length) return `changed[0]: ${ABSENT}\n`;
  const rows = entries.map(([field, change]) => {
    if (field === "body") return `  body: ${lineDelta(String(change.old ?? ""), String(change.new ?? ""))}`;
    return `  ${label(field)}: ${cell(change.old)} → ${cell(change.new)}`;
  });
  return `changed[${entries.length}]:\n${rows.join("\n")}\n`;
}

function lineDelta(before: string, after: string): string {
  const old = before ? before.split("\n") : [];
  const now = after ? after.split("\n") : [];
  const kept = new Set(old);
  const added = now.filter((line) => !kept.has(line)).length;
  const present = new Set(now);
  const removed = old.filter((line) => !present.has(line)).length;
  return `+${added} lines, -${removed} lines`;
}

/** `event: ev-… ` — or the explicit statement that an empty diff wrote none.
 *  Silence here would read as "an event I did not print", which is the one thing
 *  an audit surface must never do. */
export function eventLine(id: unknown): string {
  return id ? `event: ${cell(id)}\n` : `event: ${ABSENT} (no event written for an empty diff)\n`;
}

/** `next_fire` is the cadence CURSOR, so an absent one is never printed bare:
 *  the reason it is absent (paused, no cadence at all) is the whole answer to
 *  "why is this loop not running?". The kernel home's loops roster is its one
 *  remaining surface — the loop kind's own render retired with it. */
export function nextFireCell(row: { nextFire?: unknown; status?: unknown }): unknown {
  if (row.nextFire) return row.nextFire;
  if (row.status === "retired") return raw(`${ABSENT} (retired — terminal)`);
  if (row.status === "paused") return raw(`${ABSENT} (paused)`);
  return raw(`${ABSENT} (no cadence — runs on demand only)`);
}

/** Elapsed time as the inbox's only prioritization signal (there is no priority
 *  field). Coarse on purpose: `19h`, `4d`. */
export function waiting(since: string | null | undefined, now: number): string {
  if (!since) return ABSENT;
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return ABSENT;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The derived answer printed next to a raw date, so the agent never has to do a
 *  clock comparison it is unreliable at (the same reasoning that makes `+3d` the
 *  preferred write form). */
export function dueAnnotation(followUpAt: string | null | undefined, now: number): string {
  if (!followUpAt) return "";
  const ms = Date.parse(followUpAt);
  if (!Number.isFinite(ms)) return "";
  return ms <= now ? ` (due, ${waiting(followUpAt, now)} ago)` : ` (in ${waiting(new Date(now - (ms - now)).toISOString(), now)})`;
}
