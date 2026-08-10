/**
 * Splitting + strict YAML parsing.
 *
 * Deliberately unforgiving, and deliberately DIFFERENT from the v2 loop-product
 * front-matter reader (`packages/server/src/server/frontmatter.ts`), which is a
 * soft convention that never throws. This is the canonical format of a stored
 * artifact: a file that opens a front-matter block and then malforms it is an
 * ERROR, never a document that silently becomes "all body".
 */

import { parseDocument } from "yaml";
import { ArtifactFormatError } from "./errors.js";
import { validateFrontMatter } from "./schema.js";
import { guardShape } from "./shape.js";
import {
  resolveLimits,
  type ArtifactDocument,
  type ArtifactLimits,
  type ParseOptions,
} from "./types.js";

const BOM = "﻿";
/** A delimiter line: exactly `---`, trailing spaces/tabs tolerated. */
const DELIMITER = /^---[ \t]*$/;

export interface ArtifactSplit {
  /** The raw YAML text between the delimiters (no delimiters, no BOM). */
  frontMatterText: string;
  /** The raw body, byte-exact from just after the closing delimiter's newline. */
  body: string;
  /** 1-based document line the front-matter YAML starts on (always 2). */
  frontMatterStartLine: number;
}

/**
 * Split a file into its front-matter text and body WITHOUT parsing the YAML.
 * Exported because an ingress may want to route on the split before paying for
 * a parse; the guarantees (loud on missing/unterminated) are identical.
 */
export function splitArtifact(text: string, options?: ParseOptions): ArtifactSplit {
  const limits = resolveLimits(options);
  const raw = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > limits.maxDocumentBytes) {
    throw new ArtifactFormatError(
      "DOCUMENT_TOO_LARGE",
      `document is ${bytes} bytes, over the ${limits.maxDocumentBytes}-byte ceiling`,
    );
  }

  if (!raw.startsWith("---")) {
    throw new ArtifactFormatError(
      "MISSING_FRONT_MATTER",
      "an artifact file must open with a `---` front-matter delimiter",
      { line: 1 },
    );
  }

  // The code is chosen by WHAT is wrong, never by whether a newline happens to
  // be present: a malformed opening line is a missing block, and
  // `UNTERMINATED_FRONT_MATTER` is reserved for a well-formed `---` that never
  // meets its closing delimiter.
  const firstBreak = raw.indexOf("\n");
  const openingLine = stripCr(firstBreak === -1 ? raw : raw.slice(0, firstBreak));
  if (!DELIMITER.test(openingLine)) {
    throw new ArtifactFormatError("MISSING_FRONT_MATTER", "the opening line must be exactly `---`", {
      line: 1,
    });
  }
  if (firstBreak === -1) {
    throw new ArtifactFormatError(
      "UNTERMINATED_FRONT_MATTER",
      "the front-matter block opened with `---` but never closed",
      { line: 1 },
    );
  }

  // Scan line by line for the FIRST closing delimiter. Only the first one
  // closes the block, which is what makes a `---` later in the body inert
  // rather than a front-matter injection point.
  let cursor = firstBreak + 1;
  let line = 2;
  while (cursor <= raw.length) {
    const nextBreak = raw.indexOf("\n", cursor);
    const lineEnd = nextBreak === -1 ? raw.length : nextBreak;
    const content = stripCr(raw.slice(cursor, lineEnd));
    if (DELIMITER.test(content)) {
      return {
        frontMatterText: raw.slice(firstBreak + 1, cursor),
        body: nextBreak === -1 ? "" : raw.slice(nextBreak + 1),
        frontMatterStartLine: 2,
      };
    }
    if (nextBreak === -1) break;
    cursor = nextBreak + 1;
    line += 1;
  }

  throw new ArtifactFormatError(
    "UNTERMINATED_FRONT_MATTER",
    "the front-matter block opened with `---` but never closed",
    { line },
  );
}

function stripCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

/**
 * Parse an artifact file into its document model.
 *
 * Throws `ArtifactFormatError` on: a missing or unterminated front-matter
 * block, malformed YAML, a non-mapping head, an unsupported `format:`, or any
 * hostile-input ceiling. Every front-matter key other than `format` is
 * preserved untouched — the codec has no field vocabulary.
 */
export function parseArtifact(text: string, options?: ParseOptions): ArtifactDocument {
  const limits = resolveLimits(options);
  const { frontMatterText, body, frontMatterStartLine } = splitArtifact(text, options);

  const fmBytes = Buffer.byteLength(frontMatterText, "utf8");
  if (fmBytes > limits.maxFrontMatterBytes) {
    throw new ArtifactFormatError(
      "FRONT_MATTER_TOO_LARGE",
      `front matter is ${fmBytes} bytes, over the ${limits.maxFrontMatterBytes}-byte ceiling`,
      { line: frontMatterStartLine },
    );
  }

  const value = parseFrontMatterYaml(frontMatterText, frontMatterStartLine, limits);
  guardShape(value, limits);

  return { frontMatter: validateFrontMatter(value), body };
}

function parseFrontMatterYaml(yamlText: string, startLine: number, limits: ArtifactLimits): unknown {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText, {
      version: "1.2",
      // The YAML 1.2 core schema only produces strings/numbers/booleans/null —
      // no timestamps, no binary, and no path to instantiating a host object.
      schema: "core",
      uniqueKeys: true,
      logLevel: "silent",
      prettyErrors: false,
    });
  } catch (err) {
    // Pathological nesting can exhaust the stack inside the parser itself; that
    // is still a malformed-input answer, not a crash we let escape.
    throw yamlError(err, startLine, "front matter is not valid YAML");
  }

  const failure = doc.errors[0] ?? doc.warnings[0];
  if (failure) {
    throw new ArtifactFormatError("INVALID_YAML", `front matter is not valid YAML: ${failure.message}`, {
      line: startLine + (failure.linePos?.[0]?.line ?? 1) - 1,
      cause: failure,
    });
  }

  try {
    // Alias expansion happens HERE, not in the parse above — so this is where
    // the billion-laughs ceiling has to be applied.
    return doc.toJS({ maxAliasCount: limits.maxAliasCount });
  } catch (err) {
    throw yamlError(err, startLine, "front matter could not be materialized");
  }
}

function yamlError(err: unknown, line: number, prefix: string): ArtifactFormatError {
  const message = err instanceof Error ? err.message : String(err);
  return new ArtifactFormatError("INVALID_YAML", `${prefix}: ${message}`, { line, cause: err });
}
