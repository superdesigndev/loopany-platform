/**
 * Typed, loud failures. Every rejection this library performs surfaces as an
 * `ArtifactFormatError` carrying a machine-readable `code` — callers switch on
 * the code, never on message text. There is no lenient path: a file that is not
 * a valid artifact is never silently reinterpreted as "all body, no head".
 */

export type ArtifactErrorCode =
  /** The text does not open with a `---` front-matter delimiter. */
  | "MISSING_FRONT_MATTER"
  /** It opened a front-matter block but never closed it. */
  | "UNTERMINATED_FRONT_MATTER"
  /** The front-matter block is not well-formed YAML (or uses an unresolved tag). */
  | "INVALID_YAML"
  /** The front matter parsed, but to something other than a mapping. */
  | "FRONT_MATTER_NOT_MAPPING"
  /** A hostile-input guard tripped: see `ArtifactLimits`. */
  | "DOCUMENT_TOO_LARGE"
  | "FRONT_MATTER_TOO_LARGE"
  | "FRONT_MATTER_TOO_DEEP"
  | "FRONT_MATTER_TOO_MANY_NODES"
  /** `format:` names a body format this version does not implement. */
  | "UNSUPPORTED_FORMAT"
  /** The core schema rejected one or more fields; see `issues`. */
  | "SCHEMA_VIOLATION";

/** One field-level complaint. `path` is a dotted front-matter path (`source`,
 *  `attachments[1]`), never a body offset — the body is never validated. */
export interface ArtifactIssue {
  readonly path: string;
  readonly message: string;
}

export interface ArtifactFormatErrorOptions {
  /** Field-level detail for `SCHEMA_VIOLATION`. */
  readonly issues?: readonly ArtifactIssue[];
  /** 1-based line within the WHOLE document, when the failure has a location. */
  readonly line?: number;
  readonly cause?: unknown;
}

export class ArtifactFormatError extends Error {
  readonly code: ArtifactErrorCode;
  readonly issues: readonly ArtifactIssue[];
  readonly line: number | undefined;

  constructor(code: ArtifactErrorCode, message: string, options: ArtifactFormatErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArtifactFormatError";
    this.code = code;
    this.issues = options.issues ?? [];
    this.line = options.line;
  }
}

export function isArtifactFormatError(value: unknown): value is ArtifactFormatError {
  return value instanceof ArtifactFormatError;
}

/** Non-throwing wrapper shape for callers (a server ingress) that must not let
 *  one bad file take down a batch. */
export type ArtifactResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ArtifactFormatError };

/** Run `fn`, converting an `ArtifactFormatError` into a result. Any OTHER throw
 *  is a bug in this library and is deliberately left to propagate. */
export function toResult<T>(fn: () => T): ArtifactResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (isArtifactFormatError(err)) return { ok: false, error: err };
    throw err;
  }
}
