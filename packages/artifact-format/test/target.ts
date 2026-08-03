/**
 * STAGE 2 — the target surface, written down.
 *
 * This file is the executable statement of what `@loopany/artifact-format`
 * becomes: a PURE STRUCTURAL CODEC with zero domain knowledge. It is test
 * support, not source — stage 2 ships tests only, so nothing under `src/`
 * implements this yet and a red suite is the expected state.
 *
 * It lives outside `src/` deliberately: the package tsconfig neither includes
 * it nor typechecks it, so it can describe a surface that does not exist yet
 * without breaking `pnpm typecheck`.
 *
 * How the tests consume it:
 *  - APIs that already exist are imported normally by each test file, so those
 *    tests run for real and PASS where today's behavior already matches the
 *    target. That is the point: the red tests are exactly stage 3's work list.
 *  - APIs that do NOT exist yet go through `api(name)`, which fails with an
 *    explicit "not exported" message instead of a link-time explosion that
 *    would take a whole file down with it.
 */

import * as codec from "../src/index.js";

/** One field-level complaint. Unchanged from v1. */
export interface Issue {
  readonly path: string;
  readonly message: string;
}

/**
 * The front matter is a plain YAML mapping and nothing more. `format` is the
 * ONLY key the library itself knows; every other key is opaque data it carries
 * verbatim. Object kinds and their closed key sets live in the server seam.
 */
export type TargetFrontMatter = { format?: "markdown" | "html" } & Record<string, unknown>;

export interface TargetDocument {
  readonly frontMatter: TargetFrontMatter;
  /** The body EXACTLY as it appeared after the closing delimiter line. Opaque
   *  text to this library — it is never parsed, rendered, or normalized. */
  readonly body: string;
}

export interface TargetLimits {
  maxDocumentBytes: number;
  maxFrontMatterBytes: number;
  maxFrontMatterDepth: number;
  maxFrontMatterNodes: number;
  maxAliasCount: number;
}

export interface TargetParseOptions {
  limits?: Partial<TargetLimits>;
}

export interface TargetSerializeOptions extends TargetParseOptions {
  /**
   * Keys listed here are emitted FIRST, in this order; every remaining key
   * follows in code-unit lexicographic order. Applies to the TOP-LEVEL mapping
   * only — nested mappings are always pure lexicographic, because a caller's
   * top-level presentation intent should not reach down and reorder a nested
   * value that merely shares a key name.
   *
   * Absent from the data: skipped, never emitted as null.
   * Listed twice: first occurrence wins, no duplicate emission.
   * Omitted entirely: pure lexicographic.
   */
  keyOrder?: string[];
}

/** The full runtime export surface after stage 3. Ordered by code unit, which
 *  is what `codec.surface.test.ts` pins. */
export const TARGET_EXPORTS = [
  "ARTIFACT_FORMAT_VERSION",
  "ArtifactFormatError",
  "DEFAULT_LIMITS",
  "SUPPORTED_BODY_FORMATS",
  "bodyFormatOf",
  "checkTimestamp",
  "isArtifactFormatError",
  "parseArtifact",
  "resolveLimits",
  "safeParseArtifact",
  "serializeArtifact",
  "splitArtifact",
  "toResult",
  "updateArtifactFrontMatter",
  "validateFrontMatter",
] as const;

/** Exports v1 had that the codec must NOT have: the domain key order, the
 *  domain field type, and the whole render projection. */
export const REMOVED_EXPORTS = ["CORE_FIELD_ORDER", "renderMarkdown", "renderArtifactBody"] as const;

/** Dependencies the render module dragged in; stage 3 deletes them. */
export const REMOVED_DEPENDENCIES = ["marked", "sanitize-html"] as const;

interface TargetApi {
  /**
   * The RFC 3339 checker, surviving as a helper the library applies to NOTHING.
   * Callers decide which keys are timestamps; this only answers whether one
   * value is a well-formed instant.
   *
   * Returns an `Issue` describing the problem, or `null` when the value is a
   * valid RFC 3339 date-time WITH an explicit offset. Issue-shaped rather than
   * boolean so it composes straight into a seam's issue accumulation.
   */
  checkTimestamp(value: unknown, path: string): Issue | null;
}

/**
 * Reach a target API by name. A missing export fails the ONE test that used it
 * with a message naming the gap, rather than throwing at module link time and
 * taking every sibling test down with it.
 */
export function api<K extends keyof TargetApi>(name: K): TargetApi[K] {
  const value = (codec as unknown as Record<string, unknown>)[name];
  if (typeof value !== "function") {
    throw new Error(
      `STAGE 3 NOT IMPLEMENTED: \`${name}\` is not exported by @loopany/artifact-format (got ${typeof value})`,
    );
  }
  return value as TargetApi[K];
}

/** The whole runtime namespace, for the export-surface test. */
export const surface = codec as unknown as Record<string, unknown>;
