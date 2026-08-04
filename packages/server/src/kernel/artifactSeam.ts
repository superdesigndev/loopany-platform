import { safeParseArtifact, serializeArtifact, type ArtifactDocument } from "../../../artifact-format/src/index.js";
import type { ArtifactKind } from "./types.js";
import { MIRROR_KIND_HINT, normalizeMirror, type MirrorIssue, type NormalizedMirror } from "./mirrors.js";
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
 *
 * `mirrors` is on ALL THREE sets and is the one key here that is not a field of
 * the object: it is a CONSTRUCTOR argument, consumed at create and never stored
 * on the row. See `MIRRORS_KEY` below for why it is create-only and why
 * `show --file` never emits it.
 *
 * There is no `mirror` entry, and there cannot be: a mirror is not authored as a
 * file (`types.ts` ARTIFACT_KINDS), which is also what keeps it from growing a
 * body somebody could cache external state in.
 */
export const KIND_KEYS = {
  task: ["title", "key", "follow_up", "watcher", "needs_human", "payload", "mirrors"],
  doc: ["title", "key", "format", "payload", "mirrors"],
  loop: ["title", "key", "cron", "workdir", "payload", "mirrors"],
} as const satisfies Record<ArtifactKind, readonly string[]>;

/**
 * `mirrors:` — the INLINE creation path for the case where the external item
 * PREDATES the object ("watch this PR I already opened").
 *
 * It is deliberately CREATE-ONLY. A mirror is its own object, and the
 * association lives on the mirror side, so `mirrors:` is not a field of the task
 * that a later file could rewrite — treating it as one would mean a whole-file
 * update silently detaching every mirror the file happened not to mention.
 * Consequently:
 *
 *   - `serializeKindArtifact` never emits it, so `show --file` → `create`
 *     round-trips exactly (a mirror is read with `mirror list --attached-to`);
 *   - the update/replace path REFUSES it by name, pointing at `mirror attach`.
 */
export const MIRRORS_KEY = "mirrors";

export const MIRRORS_UPDATE_HINT =
  "a mirror is its own object and the attachment lives on the mirror, so a file cannot rewrite the set — attach one with `loopany mirror attach <object-id> --kind <k> --coords <c>`, detach with `loopany mirror detach <mirror-id> --from <object-id>`";

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
  workdir?: string | null;
  /** The `mirrors:` block, normalized. Never a column — the create path attaches
   *  each one as its own object and then forgets this array. */
  mirrors?: NormalizedMirror[];
}

export type ArtifactSeamResult = { ok: true; value: ArtifactProjection; document: ArtifactDocument } | { ok: false; error: ApiRefusal };

export function normalizeArtifactBytes(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

export function parseKindArtifact(kind: ArtifactKind, raw: string, now: Date): ArtifactSeamResult {
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
      : key === "workdir"
        ? { message: `a bound working directory belongs to a loop, not a ${kind}`, hint: `only a loop binds a directory — its runs execute there. A ${kind} carries no execution site.` }
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
  // A workdir is a MACHINE-LOCAL absolute path. Refuse a relative or ~-form one
  // here rather than at the daemon: the claiming machine is not known at write
  // time, so "relative to what?" has no answer the server could ever give.
  const workdir = stringOrNull("workdir");
  if (typeof workdir === "string") {
    if (!workdir.trim()) issues.push({ path: "workdir", message: "must be a non-empty absolute path or null", got: workdir });
    else if (!workdir.startsWith("/")) {
      issues.push({ path: "workdir", message: "must be an absolute path", got: workdir, expected: "/Users/you/Workspace/your-repo" });
    }
  }
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
  const mirrors = parseMirrorsBlock(head[MIRRORS_KEY]);
  if (!mirrors.ok) return { ok: false, error: refusal("SCHEMA_VIOLATION", "the mirrors: block does not describe usable pointers", mirrors.issues, MIRROR_KIND_HINT) };

  if (issues.length) return { ok: false, error: refusal("SCHEMA_VIOLATION", "artifact front matter has invalid values", issues, "fix every listed field and retry") };
  return { ok: true, document: parsed.value, value: {
    title: title ?? null, key, body: parsed.value.body, payload, mirrors: mirrors.value,
    ...(kind === "task" ? { followUpAt: followUpAt ?? null, watcher: watcher ?? null, pendingQuestion: question ?? null } : {}),
    ...(kind === "doc" ? { format: (head.format as "markdown" | "html" | undefined) ?? "markdown" } : {}),
    ...(kind === "loop" ? { cron: cron ?? null, workdir: workdir ?? null } : {}),
  } };
}

/** How many pointers one artifact may declare inline. A bound rather than a
 *  policy: an object with fifty external dependencies is not describing work. */
export const MIRRORS_INLINE_CAP = 20;

/**
 * The `mirrors:` block: a LIST of mappings, each `{kind, coords, note?}`.
 *
 * ```yaml
 * mirrors:
 *   - kind: github-pr
 *     coords: superdesigndev/loopany-platform#57
 *     note: seed article PR
 * ```
 *
 * Every entry goes through the SAME `normalizeMirror` the one-liner uses, so a
 * kind is kebab-cased and a known kind's coords are shape-checked identically
 * whichever door it came in by.
 */
function parseMirrorsBlock(value: unknown): { ok: true; value: NormalizedMirror[] } | { ok: false; issues: MirrorIssue[] } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, issues: [{ path: MIRRORS_KEY, message: "must be a list of {kind, coords, note?} mappings", got: typeof value, expected: "- kind: github-pr\n    coords: owner/repo#57" }] };
  }
  if (value.length > MIRRORS_INLINE_CAP) {
    return { ok: false, issues: [{ path: MIRRORS_KEY, message: `at most ${MIRRORS_INLINE_CAP} inline mirrors`, got: String(value.length) }] };
  }
  const out: NormalizedMirror[] = [];
  const issues: MirrorIssue[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ path: `${MIRRORS_KEY}[${index}]`, message: "must be a mapping with kind and coords", got: JSON.stringify(entry) });
      return;
    }
    const normalized = normalizeMirror(entry as Record<string, unknown>);
    if (!normalized.ok) {
      for (const issue of normalized.issues) issues.push({ ...issue, path: `${MIRRORS_KEY}[${index}].${issue.path}` });
      return;
    }
    // One external thing is one mirror, so naming it twice in one file is a
    // mistake worth pointing at rather than a silently deduplicated write.
    const identity = `${normalized.value.kind} ${normalized.value.coords}`;
    if (seen.has(identity)) {
      issues.push({ path: `${MIRRORS_KEY}[${index}].coords`, message: "listed twice — one external thing is one mirror", got: normalized.value.coords });
      return;
    }
    seen.add(identity);
    out.push(normalized.value);
  });
  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}

export function parseDate(value: string, now: Date): string | undefined {
  const relative = /^\+(\d+)(h|d)$/.exec(value);
  if (relative) return new Date(now.getTime() + Number(relative[1]) * (relative[2] === "d" ? 86_400_000 : 3_600_000)).toISOString();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * The canonical file for an object.
 *
 * NOTE `mirrors:` is never emitted, and that is the round-trip rule doing its
 * job rather than an omission: a mirror is a separate object, so it is not part
 * of this object's state, and a `show --file` that printed one would produce a
 * file whose re-upload would try to create it again. Read them with
 * `loopany mirror list --attached-to <id>`.
 */
export function serializeKindArtifact(kind: ArtifactKind, object: ArtifactProjection): string {
  const frontMatter: Record<string, unknown> = { title: object.title, key: object.key };
  if (kind === "task") Object.assign(frontMatter, { follow_up: object.followUpAt, watcher: object.watcher, needs_human: object.pendingQuestion });
  if (kind === "doc") frontMatter.format = object.format ?? "markdown";
  if (kind === "loop") Object.assign(frontMatter, { cron: object.cron, workdir: object.workdir });
  // NOT `?? {}`: an absent payload must serialize as an ABSENT key, or the file
  // this very function emits no longer round-trips. `{}` re-parses to an empty
  // mapping, which `expressedDiffs` reads as different from a null payload — so
  // `show --file` → `create` reported a spurious `differs: payload`, and the
  // task/doc `--file` update path wrote a junk `null → {}` diff event.
  frontMatter.payload = object.payload;
  for (const key of Object.keys(frontMatter)) if (frontMatter[key] == null) delete frontMatter[key];
  return serializeArtifact({ frontMatter, body: object.body }, { keyOrder: [...KIND_KEYS[kind]] });
}

function unsupportedFormat(kind: ArtifactKind, got: string | undefined): ApiRefusal {
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
