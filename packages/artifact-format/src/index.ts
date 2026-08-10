/**
 * @loopany/artifact-format — the artifact file format codec.
 *
 * An artifact file is one YAML front-matter block (a plain mapping) plus an
 * opaque body. Parse and serialize are deterministic inverses.
 *
 * A PURE STRUCTURAL CODEC: no I/O, no server internals, no globals, and no
 * domain knowledge. Object kinds and their front-matter key sets live in the
 * server seam; this library only knows YAML mappings and bytes.
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
  DEFAULT_LIMITS,
  SUPPORTED_BODY_FORMATS,
  resolveLimits,
  type ArtifactBodyFormat,
  type ArtifactDocument,
  type ArtifactFrontMatter,
  type ArtifactLimits,
  type ParseOptions,
  type SerializeOptions,
} from "./types.js";

export { bodyFormatOf, checkTimestamp, validateFrontMatter } from "./schema.js";
export { parseArtifact, splitArtifact, type ArtifactSplit } from "./parse.js";
export { serializeArtifact, updateArtifactFrontMatter } from "./serialize.js";

import { toResult, type ArtifactResult } from "./errors.js";
import { parseArtifact } from "./parse.js";
import type { ArtifactDocument, ParseOptions } from "./types.js";

/** `parseArtifact` as a result instead of a throw — for batch ingress paths
 *  where one malformed file must not abort the batch. */
export function safeParseArtifact(text: string, options?: ParseOptions): ArtifactResult<ArtifactDocument> {
  return toResult(() => parseArtifact(text, options));
}
