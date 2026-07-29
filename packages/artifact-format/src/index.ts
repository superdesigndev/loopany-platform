/**
 * @loopany/artifact-format — the v1 artifact file format.
 *
 * An artifact file is one YAML front-matter block (the machine head) plus a
 * Markdown body (the content). Parse and serialize are inverse and
 * deterministic; rendering to HTML is a sanitized projection, never storage.
 *
 * Pure library: no I/O, no server internals, no globals.
 */

export {
  ArtifactFormatError,
  isArtifactFormatError,
  toResult,
  type ArtifactErrorCode,
  type ArtifactFormatErrorOptions,
  type ArtifactIssue,
  type ArtifactResult,
} from "./errors.js";

export {
  ARTIFACT_FORMAT_VERSION,
  CORE_FIELD_ORDER,
  DEFAULT_LIMITS,
  SUPPORTED_BODY_FORMATS,
  resolveLimits,
  type ArtifactBodyFormat,
  type ArtifactCoreFields,
  type ArtifactDocument,
  type ArtifactFrontMatter,
  type ArtifactLimits,
  type ParseOptions,
  type SerializeOptions,
} from "./types.js";

export { bodyFormatOf, validateFrontMatter } from "./schema.js";
export { parseArtifact, splitArtifact, type ArtifactSplit } from "./parse.js";
export { serializeArtifact, updateArtifactFrontMatter } from "./serialize.js";
export { renderArtifactBody, renderMarkdown, type RenderOptions } from "./render.js";

import { toResult, type ArtifactResult } from "./errors.js";
import { parseArtifact } from "./parse.js";
import type { ArtifactDocument, ParseOptions } from "./types.js";

/** `parseArtifact` as a result instead of a throw — for batch ingress paths
 *  where one malformed file must not abort the batch. */
export function safeParseArtifact(text: string, options?: ParseOptions): ArtifactResult<ArtifactDocument> {
  return toResult(() => parseArtifact(text, options));
}
