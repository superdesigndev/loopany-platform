/**
 * The artifact document model.
 *
 * An artifact file is ONE YAML front-matter block followed by a body. This
 * library is a PURE STRUCTURAL CODEC: it knows that the head is a YAML mapping
 * and that the body is opaque text, and it knows nothing else. Object kinds
 * (task/doc/loop), their closed front-matter key sets, and every other domain
 * rule live in the server-side seam — never here.
 */

export const ARTIFACT_FORMAT_VERSION = 1;

/** The body formats the head may declare. This is an ENUM and nothing more:
 *  the codec attaches no rendering semantics to either value, and which object
 *  kinds may use which format is server-side policy. */
export const SUPPORTED_BODY_FORMATS = ["markdown", "html"] as const;
export type ArtifactBodyFormat = (typeof SUPPORTED_BODY_FORMATS)[number];

/**
 * The front matter is a plain YAML mapping. `format` is the ONLY key the codec
 * itself recognizes; every other key is opaque data carried verbatim through
 * parse and serialize.
 *
 * Pass-through is the CORRECT behavior at this level, not a fallback — an
 * unknown key is not a key the codec failed to understand, it is a key that is
 * none of the codec's business. Rejection happens at the server seam, against
 * the object kind's declared key set.
 */
export type ArtifactFrontMatter = { format?: ArtifactBodyFormat } & { [key: string]: unknown };

export interface ArtifactDocument {
  readonly frontMatter: ArtifactFrontMatter;
  /**
   * The body EXACTLY as it appeared after the closing delimiter line — the
   * customary blank line following `---` is part of the body and is preserved.
   * Opaque text: never parsed, rendered, or normalized by this library.
   */
  readonly body: string;
}

/** Hostile-input ceilings. Every one of these is a LOUD failure, never a clip. */
export interface ArtifactLimits {
  /** Whole file, in UTF-8 bytes. */
  maxDocumentBytes: number;
  /** The YAML block between the delimiters, in UTF-8 bytes. */
  maxFrontMatterBytes: number;
  /** Nesting depth of the front-matter value, counted from the root mapping:
   *  the root is 1, its values are 2, and so on. */
  maxFrontMatterDepth: number;
  /** Total collection entries + scalars in the front matter. */
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

export interface SerializeOptions extends ParseOptions {
  /**
   * Presentation only: keys listed here are emitted FIRST, in this order, and
   * every remaining key follows in code-unit lexicographic order. Omit it for
   * pure lexicographic order.
   *
   * There is no privileged key order baked into the codec — a caller that wants
   * `kind` before `state` says so here, and a caller that does not care gets a
   * stable order anyway.
   *
   * - Applies to the TOP-LEVEL mapping only. Nested mappings are always pure
   *   lexicographic, so a caller's intent for the head cannot reach down and
   *   reorder a nested value that merely shares a key name.
   * - A listed key the data does not have is skipped, never invented.
   * - A key listed twice keeps its first position.
   * - `[]` behaves exactly like omitting the option.
   */
  keyOrder?: string[];
}

/** The effective ceilings for one call: `DEFAULT_LIMITS` under any override. */
export function resolveLimits(options: ParseOptions | undefined): ArtifactLimits {
  return { ...DEFAULT_LIMITS, ...options?.limits };
}
