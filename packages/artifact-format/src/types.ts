/**
 * The v1 artifact document model.
 *
 * An artifact file is ONE YAML front-matter block followed by a Markdown body.
 * Front matter is the MACHINE HEAD: only fields the system acts on live there.
 * Anything that exists purely for a human reader belongs in the body.
 */

export const ARTIFACT_FORMAT_VERSION = 1;

/** The only body format v1 implements. An explicit `format:` naming anything
 *  else is a loud error — never a silent fallback to Markdown. */
export const SUPPORTED_BODY_FORMATS = ["markdown"] as const;
export type ArtifactBodyFormat = (typeof SUPPORTED_BODY_FORMATS)[number];

/**
 * The CORE schema — the fields this library knows and validates. Everything
 * else in the front matter is an unknown field: preserved verbatim through
 * parse/serialize so the per-type registry can add its own fields later
 * WITHOUT this library changing.
 */
export interface ArtifactCoreFields {
  /** Registry type key. Required — an artifact with no type is not addressable. */
  type: string;
  /** Current state in the type's state machine. Open vocabulary here; the
   *  registry (not this library) decides which values a type admits. */
  status?: string;
  /** Display title. Machine-acted (listing, search) hence head, not body. */
  title?: string;
  /** Body format. Absent means `markdown`. */
  format?: ArtifactBodyFormat;
  /** External system this artifact mirrors, e.g. `github`. */
  source?: string;
  /** Identity within `source`, e.g. `org/repo/issues/1291`. Requires `source`. */
  externalId?: string;
  /** Canonical URL of the external fact. */
  sourceUrl?: string;
  /** RFC 3339 instants WITH an explicit offset (`2026-07-29T09:15:00Z`). */
  createdAt?: string;
  updatedAt?: string;
  /** Related file references. Legal DATA in v1 with no rendering semantics —
   *  nothing in this library resolves, fetches, or embeds them. */
  attachments?: string[];
}

/** Core fields plus any number of preserved unknown fields. */
export type ArtifactFrontMatter = ArtifactCoreFields & { [key: string]: unknown };

export interface ArtifactDocument {
  readonly frontMatter: ArtifactFrontMatter;
  /**
   * The body EXACTLY as it appeared after the closing delimiter line — the
   * customary blank line following `---` is part of the body and is preserved.
   * Always Markdown (CommonMark + GFM tables) in v1.
   */
  readonly body: string;
}

/**
 * Canonical front-matter key order: core fields in this declared order first,
 * every unknown key after them in lexicographic order. Serialization is a pure
 * function of the data, so two documents with equal data serialize to equal
 * bytes regardless of how their objects were built.
 */
export const CORE_FIELD_ORDER = [
  "type",
  "status",
  "title",
  "format",
  "source",
  "externalId",
  "sourceUrl",
  "createdAt",
  "updatedAt",
  "attachments",
] as const satisfies readonly (keyof ArtifactCoreFields)[];

/** Hostile-input ceilings. Every one of these is a LOUD failure, never a clip. */
export interface ArtifactLimits {
  /** Whole file, in UTF-8 bytes. */
  maxDocumentBytes: number;
  /** The YAML block between the delimiters, in UTF-8 bytes. */
  maxFrontMatterBytes: number;
  /** Nesting depth of the parsed front-matter value. */
  maxFrontMatterDepth: number;
  /** Total collection entries + scalars in the parsed front matter. */
  maxFrontMatterNodes: number;
  /** YAML alias expansions before the parser gives up (billion-laughs guard). */
  maxAliasCount: number;
}

export const DEFAULT_LIMITS: ArtifactLimits = {
  maxDocumentBytes: 4 * 1024 * 1024,
  maxFrontMatterBytes: 64 * 1024,
  maxFrontMatterDepth: 16,
  maxFrontMatterNodes: 5_000,
  maxAliasCount: 100,
};

export interface ParseOptions {
  /** Partial override of `DEFAULT_LIMITS`. */
  limits?: Partial<ArtifactLimits>;
}
