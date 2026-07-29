/**
 * Core-schema validation. Validates ONLY the fields in `ArtifactCoreFields` and
 * passes every other key through untouched — the whole point is that a per-type
 * registry can add fields without this module learning about them.
 */

import { ArtifactFormatError, type ArtifactIssue } from "./errors.js";
import {
  SUPPORTED_BODY_FORMATS,
  type ArtifactBodyFormat,
  type ArtifactFrontMatter,
} from "./types.js";

/** RFC 3339 date-time with a REQUIRED offset — an instant with no zone is
 *  ambiguous, and ambiguity in a timestamp the engine schedules on is a bug. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  path: string,
  issues: ArtifactIssue[],
  { required = false }: { required?: boolean } = {},
): string | undefined {
  if (value === undefined) {
    if (required) issues.push({ path, message: "is required" });
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push({ path, message: `must be a string, got ${describe(value)}` });
    return undefined;
  }
  if (value.trim() === "") {
    issues.push({ path, message: "must not be empty" });
    return undefined;
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "a mapping" : typeof value;
}

function checkTimestamp(value: unknown, path: string, issues: ArtifactIssue[]): void {
  const str = requireString(value, path, issues);
  if (str === undefined) return;
  if (!RFC3339.test(str) || Number.isNaN(Date.parse(str))) {
    issues.push({
      path,
      message: "must be an RFC 3339 date-time with an explicit offset (e.g. 2026-07-29T09:15:00Z)",
    });
  }
}

function checkAttachments(value: unknown, issues: ArtifactIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path: "attachments", message: `must be a list of strings, got ${describe(value)}` });
    return;
  }
  value.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      issues.push({ path: `attachments[${i}]`, message: "must be a non-empty string" });
    }
  });
}

/**
 * Validate a parsed front-matter mapping against the core schema.
 *
 * An unknown `format:` throws `UNSUPPORTED_FORMAT` on its own (it means the
 * caller is holding a document this library cannot render, which is a different
 * conversation from a malformed field). Everything else is accumulated so one
 * error reports every problem at once.
 *
 * Returns the SAME data, typed — no coercion, no defaulting, no key dropping.
 */
export function validateFrontMatter(value: unknown): ArtifactFrontMatter {
  if (!isPlainObject(value)) {
    throw new ArtifactFormatError(
      "FRONT_MATTER_NOT_MAPPING",
      `front matter must be a YAML mapping, got ${describe(value)}`,
    );
  }

  if (value["format"] !== undefined) {
    const format = value["format"];
    if (typeof format !== "string" || !(SUPPORTED_BODY_FORMATS as readonly string[]).includes(format)) {
      throw new ArtifactFormatError(
        "UNSUPPORTED_FORMAT",
        `unsupported body format ${JSON.stringify(format)}; this version supports only ${SUPPORTED_BODY_FORMATS.map(
          (f) => JSON.stringify(f),
        ).join(", ")}`,
        { issues: [{ path: "format", message: "unsupported body format" }] },
      );
    }
  }

  const issues: ArtifactIssue[] = [];

  requireString(value["type"], "type", issues, { required: true });
  requireString(value["status"], "status", issues);
  requireString(value["title"], "title", issues);
  requireString(value["source"], "source", issues);
  requireString(value["sourceUrl"], "sourceUrl", issues);
  const externalId = requireString(value["externalId"], "externalId", issues);
  checkTimestamp(value["createdAt"], "createdAt", issues);
  checkTimestamp(value["updatedAt"], "updatedAt", issues);
  checkAttachments(value["attachments"], issues);

  // An external id is only an identity in the context of a source (design §7:
  // a mirror is keyed by source + external id), so one without the other is a
  // half key and never valid.
  if (externalId !== undefined && value["source"] === undefined) {
    issues.push({ path: "externalId", message: "requires `source` (a mirror is keyed by source + externalId)" });
  }

  if (issues.length > 0) {
    throw new ArtifactFormatError(
      "SCHEMA_VIOLATION",
      `front matter failed the core schema: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
      { issues },
    );
  }

  return value as ArtifactFrontMatter;
}

/** Narrowing helper for callers switching on the body format. */
export function bodyFormatOf(frontMatter: ArtifactFrontMatter): ArtifactBodyFormat {
  return frontMatter.format ?? "markdown";
}
