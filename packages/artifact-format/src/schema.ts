/**
 * STRUCTURAL validation — the only validation this library performs.
 *
 * Two rules, and deliberately no more: the front matter is a YAML mapping, and
 * if it declares a `format` that format is one the codec knows. There is no
 * required key, no field vocabulary, and no cross-field rule; those belong to
 * the server seam, which validates against an object kind's declared key set.
 *
 * The RFC 3339 checker lives here too, as a helper this module applies to NO
 * key. Callers decide which of their own keys are timestamps.
 */

import { ArtifactFormatError, type ArtifactIssue } from "./errors.js";
import {
  SUPPORTED_BODY_FORMATS,
  type ArtifactBodyFormat,
  type ArtifactFrontMatter,
} from "./types.js";

/** RFC 3339 date-time with a REQUIRED offset — an instant with no zone is
 *  ambiguous, and ambiguity in a timestamp the engine schedules on is a bug. */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const TIMESTAMP_MESSAGE =
  "must be an RFC 3339 date-time with an explicit offset (e.g. 2026-07-29T09:15:00Z)";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human-readable value kind, for error messages. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "a mapping" : typeof value;
}

/**
 * Is `value` a well-formed RFC 3339 instant?
 *
 * Returns `null` when it is, or an `ArtifactIssue` naming the caller's own
 * `path` when it is not. Issue-shaped rather than boolean so it drops straight
 * into a seam's issue accumulation:
 *
 *   const issues = TIMESTAMP_KEYS
 *     .map((key) => checkTimestamp(frontMatter[key], key))
 *     .filter((issue) => issue !== null);
 *
 * The codec applies this to NOTHING at all — a front matter whose `createdAt`
 * reads `yesterday` parses fine here, and is the seam's problem, not ours.
 */
export function checkTimestamp(value: unknown, path: string): ArtifactIssue | null {
  if (typeof value !== "string") {
    return { path, message: `${TIMESTAMP_MESSAGE}; got ${describeValue(value)}` };
  }
  const match = RFC3339.exec(value);
  if (match === null || Number.isNaN(Date.parse(value)) || !isRealCalendarDate(match)) {
    return { path, message: TIMESTAMP_MESSAGE };
  }
  return null;
}

/**
 * Does the written calendar date actually exist?
 *
 * `Date.parse` does NOT answer this: V8 rolls `2026-02-30` forward to March 2
 * and reports a perfectly valid instant, so a day that never happened would
 * read back as a well-formed one — and a caller re-deriving the date from that
 * instant would get a different day than the file says. The written year, month
 * and day must survive the round trip through the calendar unchanged.
 *
 * `setUTCFullYear` rather than `Date.UTC`, which maps years 0-99 onto 1900+n
 * and would reject a legitimate `0026-…` timestamp.
 */
function isRealCalendarDate(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

/**
 * Validate the STRUCTURE of a front-matter value and return it, typed. No
 * coercion, no defaulting, no key dropping — the same data comes back out.
 */
export function validateFrontMatter(value: unknown): ArtifactFrontMatter {
  if (!isPlainObject(value)) {
    throw new ArtifactFormatError(
      "FRONT_MATTER_NOT_MAPPING",
      `front matter must be a YAML mapping, got ${describeValue(value)}`,
    );
  }

  const format = value["format"];
  if (format !== undefined && !(SUPPORTED_BODY_FORMATS as readonly string[]).includes(format as string)) {
    throw new ArtifactFormatError(
      "UNSUPPORTED_FORMAT",
      `unsupported body format ${JSON.stringify(format)}; this version supports only ${SUPPORTED_BODY_FORMATS.map(
        (f) => JSON.stringify(f),
      ).join(", ")}`,
      { issues: [{ path: "format", message: "unsupported body format" }] },
    );
  }

  return value as ArtifactFrontMatter;
}

/** The declared body format, or `markdown` when the head does not say. */
export function bodyFormatOf(frontMatter: ArtifactFrontMatter): ArtifactBodyFormat {
  return frontMatter.format ?? "markdown";
}
