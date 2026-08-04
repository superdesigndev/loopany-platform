/**
 * MIRRORS — the pure vocabulary of the fourth object kind.
 *
 * A mirror is a POINTER to something outside this system: a PR, an issue, a URL,
 * a Search Console property. It exists so that an agent reading a task can see,
 * without guessing, which external items that task depends on and therefore
 * which ones it must go and check.
 *
 * ## The law
 *
 * **A mirror tells you WHERE to look, never WHAT state it is in.**
 *
 * That is not a convention this module asks callers to honor — it is welded into
 * the schema (`db/kernel-schema.ts` `objects_mirror_stateless`): a mirror row has
 * no `payload` and no `body`, so there is physically nowhere for `state: merged`
 * to be written. The columns it does have are its external KIND, its immutable
 * external COORDS, a human note (`title`) and the objects it is attached to. None
 * of those can hold external status without lying about its own name.
 *
 * The reason for the weld rather than a comment: caching external state is the
 * single most tempting one-line commit in a system like this, it is correct for
 * about a minute, and every later reader then trusts a stale answer. Making it
 * impossible costs one CHECK constraint.
 *
 * ## Coords are identity
 *
 * `coords` is the external thing's immutable name (`owner/repo#57`, a URL). It is
 * never updated: a different PR is a different mirror. Two objects that depend on
 * the SAME external thing share ONE mirror — that is why `attachedTo` is a set
 * and why the mirror's key and id are derived from `(team, kind, coords)`.
 *
 * ## Kinds are free-form, mechanically normalized, and self-exposing
 *
 * The kind is any string, normalized on write (lowercase, trimmed, kebab). A
 * KNOWN kind additionally gets its coords shape checked, because a malformed
 * `github-pr` coord is a pointer that resolves nowhere. An UNKNOWN kind is
 * accepted verbatim — the vocabulary is meant to grow from real use, and
 * `loopany mirror kinds` prints what is actually in use so it can be read back.
 *
 * Pure: no I/O, no clock, no database. Unit-tested directly.
 */

/** The one sentence the help, the skill and the refusals all repeat. */
export const MIRROR_LAW = "a mirror tells you WHERE to look, never WHAT state it is in";

/** Coords are an external identity, not prose: bounded, single-line, non-empty. */
export const MIRROR_COORDS_MAX = 512;
/** A kind is a short slug. Long enough for `github-discussion`, short enough that
 *  a typo is visible in a list. */
export const MIRROR_KIND_MAX = 48;

export interface MirrorKindSpec {
  /** The canonical spelling. Teaching only — an unknown kind is still accepted. */
  kind: string;
  /** One line: what this kind points at. */
  what: string;
  /** The coords SHAPE, as a literal example an agent can pattern-match. */
  example: string;
  /** Returns a message when the coords do not match this known shape. */
  check: (coords: string) => string | undefined;
  /** A resolvable link for the UI, when this kind's coords determine one. */
  href: (coords: string) => string | null;
}

const GITHUB_REF = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/;

function httpUrl(coords: string): URL | null {
  try {
    const url = new URL(coords);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function githubSpec(what: string, path: "pull" | "issues"): Omit<MirrorKindSpec, "kind"> {
  return {
    what,
    example: "owner/repo#57",
    check: (coords) => (GITHUB_REF.test(coords) ? undefined : "must be owner/repo#number"),
    href: (coords) => {
      const m = GITHUB_REF.exec(coords);
      return m ? `https://github.com/${m[1]}/${m[2]}/${path}/${m[3]}` : null;
    },
  };
}

/**
 * The canonical kinds. Teaching, never enforcement — the ONLY thing membership
 * buys is a coords-shape check, so naming a kind here is a promise that its
 * coords have one true shape.
 */
export const MIRROR_KINDS: readonly MirrorKindSpec[] = [
  { kind: "github-pr", ...githubSpec("a pull request", "pull") },
  { kind: "github-issue", ...githubSpec("an issue", "issues") },
  {
    kind: "url",
    what: "any addressable page",
    example: "https://example.com/dashboard",
    check: (coords) => (httpUrl(coords) ? undefined : "must be an http(s) URL"),
    href: (coords) => httpUrl(coords)?.toString() ?? null,
  },
  {
    kind: "gsc-property",
    what: "a Google Search Console property",
    example: "sc-domain:example.com",
    check: (coords) =>
      /^sc-domain:[a-z0-9.-]+$/i.test(coords) || httpUrl(coords) ? undefined : "must be sc-domain:<host> or an http(s) URL",
    href: (coords) => `https://search.google.com/search-console?resource_id=${encodeURIComponent(coords)}`,
  },
] as const;

const BY_KIND = new Map(MIRROR_KINDS.map((spec) => [spec.kind, spec]));

export function knownMirrorKind(kind: string): MirrorKindSpec | undefined {
  return BY_KIND.get(kind);
}

/** The canonical spellings, for help text and the `expected:` line of a refusal. */
export const MIRROR_KIND_NAMES: readonly string[] = MIRROR_KINDS.map((spec) => spec.kind);

/**
 * MECHANICAL normalization — lowercase, trim, kebab. Applied on every write, so
 * `GitHub PR`, `github_pr` and `github-pr` are ONE kind rather than three rows in
 * `mirror kinds`. Deliberately lossy and deliberately not a validation: whatever
 * survives is accepted.
 */
export function normalizeMirrorKind(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_/.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface MirrorIssue {
  path: string;
  message: string;
  got?: string;
  expected?: string;
}

export interface NormalizedMirror {
  kind: string;
  coords: string;
  note: string | null;
}

/**
 * Normalize and validate one mirror's fields.
 *
 * Coords are NOT case-folded: a URL path and a repository name are both
 * case-significant, and coords are identity. They are trimmed, bounded, and
 * required to be a single line — an external identity with a newline in it is a
 * paste accident, not a pointer.
 */
export function normalizeMirror(input: { kind?: unknown; coords?: unknown; note?: unknown }): { ok: true; value: NormalizedMirror } | { ok: false; issues: MirrorIssue[] } {
  const issues: MirrorIssue[] = [];

  const rawKind = typeof input.kind === "string" ? input.kind : "";
  const kind = normalizeMirrorKind(rawKind);
  if (!rawKind.trim()) {
    issues.push({ path: "kind", message: "a mirror names the KIND of external thing it points at", expected: MIRROR_KIND_NAMES.join(" | ") });
  } else if (!kind) {
    issues.push({ path: "kind", message: "normalizes to nothing — a kind is lowercase letters, digits and dashes", got: rawKind, expected: "github-pr" });
  } else if (kind.length > MIRROR_KIND_MAX) {
    issues.push({ path: "kind", message: `must be at most ${MIRROR_KIND_MAX} characters`, got: kind });
  }

  const rawCoords = typeof input.coords === "string" ? input.coords : "";
  const coords = rawCoords.trim();
  if (!coords) {
    issues.push({ path: "coords", message: "coords are the external thing's immutable identity and are required", expected: "owner/repo#57" });
  } else if (coords.length > MIRROR_COORDS_MAX) {
    issues.push({ path: "coords", message: `must be at most ${MIRROR_COORDS_MAX} characters`, got: `${coords.slice(0, 40)}…` });
  } else if (/\s/.test(coords)) {
    issues.push({ path: "coords", message: "must be a single line — coords are an identity, not prose", got: JSON.stringify(coords.slice(0, 60)) });
  } else {
    // A KNOWN kind gets its shape checked; an unknown one is a plain string and
    // is accepted as written. That asymmetry is the whole vocabulary policy.
    const spec = knownMirrorKind(kind);
    const bad = spec?.check(coords);
    if (bad) issues.push({ path: "coords", message: `${kind}: ${bad}`, got: coords, expected: spec!.example });
  }

  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    issues.push({ path: "note", message: "must be text or absent" });
  }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;

  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { kind, coords, note } };
}

/**
 * The mirror's creation KEY — `(team, kind, coords)` collapsed into the one
 * per-team unique string `objects_key_idx` already enforces. Two attaches naming
 * the same external thing therefore resolve to ONE mirror by the kernel's
 * existing key-idempotency rule, with no second code path.
 */
export function mirrorKey(kind: string, coords: string): string {
  return `mirror:${kind}:${coords}`;
}

/** The resolvable link, when the coords determine one. Computed SERVER-side and
 *  shipped in the view payload, so the client never re-derives external URLs. */
export function mirrorHref(kind: string, coords: string): string | null {
  const spec = knownMirrorKind(kind);
  if (spec) return spec.href(coords);
  // An unknown kind whose coords happen to be a URL is still a link — that is
  // the common case for a vocabulary word nobody has canonicalized yet.
  return httpUrl(coords)?.toString() ?? null;
}

/** The teaching every mirror refusal carries when the kind is the problem. */
export const MIRROR_KIND_HINT = `kinds are free-form and normalized to kebab-case on write; the canonical ones are ${MIRROR_KIND_NAMES.join(", ")} (a known kind also has its coords shape checked). Run \`loopany mirror kinds\` to see what this team already uses.`;

/** The teaching every attach/detach refusal carries. */
export const MIRROR_ATTACH_HINT =
  "attach names the object that DEPENDS on the external thing: `loopany mirror attach <object-id> --kind github-pr --coords owner/repo#57 --note \"…\"`";
