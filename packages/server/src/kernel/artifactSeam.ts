import { safeParseArtifact, serializeArtifact, type ArtifactDocument } from "../../../artifact-format/src/index.js";
import type { ObjectKind } from "./types.js";
import { refusal, type ApiRefusal } from "./refusals.js";

/**
 * The closed top-level key set per kind.
 *
 * `key` is on the LOOP set even though API spec §1.16 writes the create key set
 * as `title, cron, payload`: the same paragraph also promises "the same
 * key-idempotency rule as tasks", and that rule is unreachable without a `key`
 * to be idempotent on. Admitting it also makes `loop show --file` round-trip —
 * `serializeKindArtifact` emits `key:` for every kind, so a keyed loop would
 * otherwise serialize a file its own parser refuses.
 */
export const KIND_KEYS = {
  task: ["title", "key", "follow_up", "watcher", "needs_human", "payload"],
  doc: ["title", "key", "format", "payload"],
  loop: ["title", "key", "cron", "payload"],
} as const satisfies Record<ObjectKind, readonly string[]>;

/** The doc body formats the kernel serves (spec §1.9). Closed, two values. */
export const DOC_FORMATS = ["markdown", "html"] as const;

export interface ArtifactProjection {
  title: string | null;
  key: string | null;
  body: string;
  payload: Record<string, unknown> | null;
  followUpAt?: string | null;
  watcher?: string | null;
  pendingQuestion?: string | null;
  format?: "markdown" | "html";
  cron?: string | null;
}

export type ArtifactSeamResult = { ok: true; value: ArtifactProjection; document: ArtifactDocument } | { ok: false; error: ApiRefusal };

export function normalizeArtifactBytes(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

export function parseKindArtifact(kind: ObjectKind, raw: string, now: Date): ArtifactSeamResult {
  const parsed = safeParseArtifact(normalizeArtifactBytes(raw));
  if (!parsed.ok) {
    const code = parsed.error.code === "DOCUMENT_TOO_LARGE" || parsed.error.code.startsWith("FRONT_MATTER_TOO_")
      ? "TOO_LARGE"
      : parsed.error.code;
    // The codec validates `format:` against its own enum before the seam sees the
    // head, so re-render that one refusal with the kernel's teaching: which values
    // are legal HERE, and the composition rule for a rich body (spec §3.6).
    if (code === "UNSUPPORTED_FORMAT") return { ok: false, error: unsupportedFormat(kind, formatValueFrom(raw)) };
    return { ok: false, error: refusal(code as never, parsed.error.message, parsed.error.issues.map((i) => ({ ...i })), "fix the artifact file and retry") };
  }
  const head = parsed.value.frontMatter as Record<string, unknown>;
  const allowed = KIND_KEYS[kind];
  for (const key of Object.keys(head)) {
    if ((allowed as readonly string[]).includes(key)) continue;
    const expected = suggestion(key, allowed);
    const special = key === "cron" && kind !== "loop"
      ? { message: "a cadence belongs to a loop, not a task", hint: "tasks have no cadence. A standing schedule is a loop; a resurface date is follow_up:" }
      : key === "kind"
        ? { message: "kind is chosen by the verb, never by front matter", hint: "POST /api/tasks makes a task; POST /api/docs makes a doc; POST /api/loops makes a loop" }
        : key === "format"
          // `format` is doc-only by KEY SET, not by value check: a task or loop body
          // is always Markdown because it feeds diffs and verdicts (design §7).
          ? { message: "format is a doc-only body format key", hint: `a ${kind} body is always Markdown — it feeds diffs and verdicts. For a rich exhibit create a doc with format: html, then cite that doc id from the ${kind}.` }
          : undefined;
    return { ok: false, error: refusal(
      "UNKNOWN_KEY", `unknown key "${key}" in a ${kind} artifact`,
      [{ path: key, message: special?.message ?? "unknown key", got: key, ...(expected ? { expected } : {}) }],
      special?.hint ?? `${kind} front matter accepts: ${allowed.join(", ")}. Custom data goes under payload:`,
    ) };
  }

  const issues: { path: string; message: string; got?: string; expected?: string }[] = [];
  const stringOrNull = (key: string) => {
    const value = head[key];
    if (value === undefined || value === null || typeof value === "string") return value as string | null | undefined;
    issues.push({ path: key, message: "must be a string or null", got: JSON.stringify(value) });
    return undefined;
  };
  const title = stringOrNull("title") ?? titleFromBody(parsed.value.body);
  const key = stringOrNull("key") ?? null;
  const watcher = stringOrNull("watcher");
  if (watcher && !watcher.startsWith("loop-")) issues.push({ path: "watcher", message: "must be a loop id", got: watcher, expected: "loop-<id>" });
  const question = stringOrNull("needs_human");
  if (typeof question === "string" && !question.trim()) issues.push({ path: "needs_human", message: "must be non-empty text or null", got: question });
  const cron = stringOrNull("cron");
  let followUpAt: string | null | undefined;
  if (Object.hasOwn(head, "follow_up")) {
    const value = stringOrNull("follow_up");
    if (value === null) followUpAt = null;
    else if (value !== undefined) {
      const date = parseDate(value, now);
      if (!date) return { ok: false, error: refusal("BAD_DATE", "follow_up is not a date this server accepts", [{ path: "follow_up", message: "unrecognized date", got: value, expected: "2026-08-11T09:00:00Z  |  +3d  |  +12h" }], "relative forms are computed on the server clock") };
      followUpAt = date;
    }
  }
  let payload: Record<string, unknown> | null = null;
  if (head.payload !== undefined && head.payload !== null) {
    if (typeof head.payload !== "object" || Array.isArray(head.payload)) issues.push({ path: "payload", message: "must be a mapping" });
    else payload = head.payload as Record<string, unknown>;
  }
  // Belt and braces: the codec's enum is the first gate, this is the kernel's own.
  // If the codec ever widens its enum, the kernel still serves two values only.
  if (head.format !== undefined && head.format !== null && !DOC_FORMATS.includes(head.format as never)) {
    return { ok: false, error: unsupportedFormat(kind, String(head.format)) };
  }
  if (issues.length) return { ok: false, error: refusal("SCHEMA_VIOLATION", "artifact front matter has invalid values", issues, "fix every listed field and retry") };
  return { ok: true, document: parsed.value, value: {
    title: title ?? null, key, body: parsed.value.body, payload,
    ...(kind === "task" ? { followUpAt: followUpAt ?? null, watcher: watcher ?? null, pendingQuestion: question ?? null } : {}),
    ...(kind === "doc" ? { format: (head.format as "markdown" | "html" | undefined) ?? "markdown" } : {}),
    ...(kind === "loop" ? { cron: cron ?? null } : {}),
  } };
}

export function parseDate(value: string, now: Date): string | undefined {
  const relative = /^\+(\d+)(h|d)$/.exec(value);
  if (relative) return new Date(now.getTime() + Number(relative[1]) * (relative[2] === "d" ? 86_400_000 : 3_600_000)).toISOString();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function serializeKindArtifact(kind: ObjectKind, object: ArtifactProjection): string {
  const frontMatter: Record<string, unknown> = { title: object.title, key: object.key };
  if (kind === "task") Object.assign(frontMatter, { follow_up: object.followUpAt, watcher: object.watcher, needs_human: object.pendingQuestion });
  if (kind === "doc") frontMatter.format = object.format ?? "markdown";
  if (kind === "loop") frontMatter.cron = object.cron;
  frontMatter.payload = object.payload ?? {};
  for (const key of Object.keys(frontMatter)) if (frontMatter[key] == null) delete frontMatter[key];
  return serializeArtifact({ frontMatter, body: object.body }, { keyOrder: [...KIND_KEYS[kind]] });
}

function unsupportedFormat(kind: ObjectKind, got: string | undefined): ApiRefusal {
  return refusal(
    "UNSUPPORTED_FORMAT",
    got ? `unsupported format ${JSON.stringify(got)}` : `format names a body format this kernel does not serve`,
    [{ path: "format", message: `must be one of ${DOC_FORMATS.join(", ")}`, ...(got ? { got } : {}), expected: "markdown" }],
    kind === "doc"
      ? "markdown is the default — omit format: entirely unless the body is HTML, which is always sandbox-rendered and excluded from body diffs"
      : `a ${kind} body is always Markdown; create the rich body as a doc with format: html and cite that doc id`,
  );
}

/** The offending `format:` value, read back out of the raw head for teaching.
 *  The codec refuses before it hands us a parsed mapping, so there is nothing
 *  else to read it from — and a refusal that cannot echo what you wrote is half
 *  a refusal (design §8: "you wrote / expected"). */
function formatValueFrom(raw: string): string | undefined {
  const head = normalizeArtifactBytes(raw).split("\n---", 1)[0] ?? "";
  return /^format:\s*(.+?)\s*$/m.exec(head)?.[1]?.replace(/^["']|["']$/g, "");
}

function titleFromBody(body: string): string | null {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || null;
}

function suggestion(got: string, allowed: readonly string[]): string | undefined {
  const ranked = allowed.map((key) => ({ key, distance: levenshtein(got.toLowerCase(), key.toLowerCase()) })).sort((a, b) => a.distance - b.distance);
  return ranked[0] && ranked[0].distance <= 2 && ranked[0].distance !== ranked[1]?.distance ? ranked[0].key : undefined;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const old = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = old; }
  }
  return row[b.length]!;
}
