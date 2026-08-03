/**
 * Deterministic serialization.
 *
 * `serializeArtifact` is a PURE FUNCTION OF THE DATA: two documents whose front
 * matter is deeply equal and whose bodies are identical produce identical
 * bytes, regardless of the key insertion order of the objects they were built
 * from, and regardless of the host's locale. That is what makes the format
 * diffable and content-addressable.
 *
 * Round-trip contract:
 *   parseArtifact(serializeArtifact(doc))  deep-equals  doc
 *   serializeArtifact(parseArtifact(text)) is stable under repetition
 */

import { stringify } from "yaml";
import { ArtifactFormatError, type ArtifactIssue } from "./errors.js";
import { validateFrontMatter } from "./schema.js";
import {
  resolveLimits,
  type ArtifactDocument,
  type ArtifactFrontMatter,
  type ArtifactLimits,
  type SerializeOptions,
} from "./types.js";

/** Code-unit comparison, NOT `localeCompare` — determinism must not depend on
 *  the host's locale or ICU build. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Keys named in `keyOrder` first, in that order, then everything else in
 * code-unit lexicographic order. A listed key the data does not have is
 * skipped rather than invented; a key listed twice keeps its first position.
 */
function orderKeys(keys: string[], keyOrder: string[] | undefined): string[] {
  const lexicographic = keys.slice().sort(byCodeUnit);
  if (keyOrder === undefined || keyOrder.length === 0) return lexicographic;

  const present = new Set(keys);
  const claimed = new Set<string>();
  const leading: string[] = [];
  for (const key of keyOrder) {
    if (!present.has(key) || claimed.has(key)) continue;
    leading.push(key);
    claimed.add(key);
  }
  return [...leading, ...lexicographic.filter((key) => !claimed.has(key))];
}

/** A mapping we can represent: a YAML-shaped bag of keys, not a host object
 *  (`Date`, `Map`, `Set`, a class instance) whose state YAML cannot carry. */
function isPlainMapping(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function describeHostObject(value: object): string {
  const name = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)?.constructor
    ?.name;
  return typeof name === "string" && name.length > 0 ? name : "non-plain object";
}

interface CanonicalContext {
  readonly limits: ArtifactLimits;
  /** Top-level key order; applies at depth 1 only. */
  readonly keyOrder: string[] | undefined;
  readonly issues: ArtifactIssue[];
}

/**
 * Deep canonical form: mappings get ordered keys at every depth (YAML mappings
 * are unordered, so ordering is presentation and we pick one), lists keep their
 * order (a list IS ordered data), and `undefined` values are dropped — a caller
 * spreading `{...fm, state: undefined}` means "no state", not "null state".
 *
 * An unrepresentable value is RECORDED and the walk continues, so one pass
 * reports every offending path instead of marching the caller through them one
 * round trip at a time. The placeholder left behind is never emitted: the
 * caller throws on a non-empty issue list before the tree reaches the writer.
 *
 * The accumulator has a NULL prototype, so a key that names an inherited
 * accessor (`__proto__` above all) becomes an ordinary own property and
 * survives the round trip like any other key, instead of silently vanishing
 * into `Object.prototype`'s setter.
 *
 * Depth is indexed exactly as the parse-side walk (`guardShape`) indexes it —
 * the root mapping is depth 1 — and reads the SAME `maxFrontMatterDepth`, so
 * whatever parses can always be written back.
 */
function canonicalize(value: unknown, ctx: CanonicalContext, path: string, depth: number): unknown {
  if (depth > ctx.limits.maxFrontMatterDepth) {
    throw new ArtifactFormatError(
      "FRONT_MATTER_TOO_DEEP",
      `front matter nests deeper than ${ctx.limits.maxFrontMatterDepth} levels`,
    );
  }

  if (Array.isArray(value)) {
    return value.map((entry, i) => canonicalize(entry, ctx, `${path}[${i}]`, depth + 1));
  }

  if (typeof value === "object" && value !== null) {
    if (!isPlainMapping(value)) return reject(ctx, path, describeHostObject(value));
    const source = value as Record<string, unknown>;
    const out = Object.create(null) as Record<string, unknown>;
    // `keyOrder` is the caller's intent for the HEAD; it must not reach down
    // and reorder a nested value that merely shares a key name.
    for (const key of orderKeys(Object.keys(source), depth === 1 ? ctx.keyOrder : undefined)) {
      const child = source[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child, ctx, path === "" ? key : `${path}.${key}`, depth + 1);
    }
    return out;
  }

  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return reject(ctx, path, typeof value);
  }

  return value;
}

function reject(ctx: CanonicalContext, path: string, kind: string): null {
  ctx.issues.push({ path: path === "" ? "<front matter>" : path, message: `unrepresentable ${kind} value` });
  return null;
}

/**
 * The canonical tree for a front matter, or a single error naming EVERY
 * unrepresentable value in it.
 */
function canonicalFrontMatter(
  frontMatter: ArtifactFrontMatter,
  limits: ArtifactLimits,
  keyOrder?: string[],
): unknown {
  const issues: ArtifactIssue[] = [];
  const canonical = canonicalize(frontMatter, { limits, keyOrder, issues }, "", 1);
  if (issues.length > 0) {
    throw new ArtifactFormatError(
      "SCHEMA_VIOLATION",
      `front matter holds unrepresentable values: ${issues
        .map((i) => `${i.path} ${i.message}`)
        .join("; ")}`,
      { issues },
    );
  }
  return canonical;
}

export function serializeArtifact(doc: ArtifactDocument, options?: SerializeOptions): string {
  // ONE canonical tree: the bytes emitted are structurally the same value that
  // was validated, and it can never be rebuilt differently between the two.
  const canonical = canonicalFrontMatter(doc.frontMatter, resolveLimits(options), options?.keyOrder);

  // Serializing never emits a file this library would refuse to read back.
  validateFrontMatter(canonical);

  const head = stringify(canonical, {
    version: "1.2",
    schema: "core",
    // No folding: a long value stays on one line so a byte diff tracks a data
    // change, not a re-wrap.
    lineWidth: 0,
    // Keep our own ordering (`canonicalize` already ordered).
    sortMapEntries: false,
    nullStr: "null",
  });

  const yamlBlock = head.endsWith("\n") ? head : `${head}\n`;
  return `---\n${yamlBlock}---\n${doc.body}`;
}

/**
 * Head edit: merge `patch` into the front matter and return a NEW document
 * with the body untouched (same reference, byte-identical). A patch value of
 * `undefined` removes the key.
 *
 * This is the read/update/re-serialize path — a state transition writing a
 * status, say — and it exists so that path cannot accidentally rewrite the
 * body. It validates eagerly, so an unrepresentable patch value fails at the
 * edit rather than surfacing later at the save.
 */
export function updateArtifactFrontMatter(
  doc: ArtifactDocument,
  patch: Record<string, unknown>,
): ArtifactDocument {
  // Null-prototype accumulator + `defineProperty`: a patch key naming an
  // inherited accessor (`__proto__`) must land as an own property, never reach
  // `Object.prototype`'s setter.
  const merged = Object.assign(Object.create(null) as Record<string, unknown>, doc.frontMatter);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else Object.defineProperty(merged, key, { value, writable: true, enumerable: true, configurable: true });
  }

  // Representability is checked through the SAME walk serialization uses, so
  // the two paths cannot drift about what a front matter may hold. The
  // canonical tree is discarded: the caller keeps its own key order until it
  // actually serializes.
  canonicalFrontMatter(merged, resolveLimits(undefined));

  return { frontMatter: validateFrontMatter(merged), body: doc.body };
}
