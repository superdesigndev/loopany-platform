/**
 * Deterministic serialization.
 *
 * `serializeArtifact` is a PURE FUNCTION OF THE DATA: two documents whose front
 * matter is deeply equal and whose bodies are identical produce identical
 * bytes, regardless of the key insertion order of the objects they were built
 * from. That is what makes the format diffable and content-addressable.
 *
 * Round-trip contract:
 *   parseArtifact(serializeArtifact(doc))  deep-equals  doc
 *   serializeArtifact(parseArtifact(text)) is stable under repetition
 */

import { stringify } from "yaml";
import { ArtifactFormatError } from "./errors.js";
import { validateFrontMatter } from "./schema.js";
import {
  CORE_FIELD_ORDER,
  resolveLimits,
  type ArtifactDocument,
  type ArtifactFrontMatter,
  type ArtifactLimits,
  type SerializeOptions,
} from "./types.js";

const CORE_INDEX = new Map<string, number>(CORE_FIELD_ORDER.map((key, i) => [key, i]));

/** Code-unit comparison, NOT `localeCompare` — determinism must not depend on
 *  the host's locale/ICU build. */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Core fields in their declared order first, unknown keys lexicographically. */
function orderKeys(keys: string[]): string[] {
  return keys.slice().sort((a, b) => {
    const ai = CORE_INDEX.get(a);
    const bi = CORE_INDEX.get(b);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return byKey(a, b);
  });
}

/** A mapping we can represent: a YAML-shaped bag of keys, not a host object
 *  (`Date`, `Map`, `Set`, a class instance) whose state YAML cannot carry. */
function isPlainMapping(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeHostObject(value: object): string {
  const name = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)?.constructor
    ?.name;
  return typeof name === "string" && name.length > 0 ? name : "non-plain object";
}

function unrepresentable(kind: string): ArtifactFormatError {
  return new ArtifactFormatError("SCHEMA_VIOLATION", `front matter cannot hold a ${kind} value`, {
    issues: [{ path: "<front matter>", message: `unrepresentable ${kind} value` }],
  });
}

/**
 * Deep canonical form: mappings get sorted keys at every depth (YAML mappings
 * are unordered, so ordering is presentation and we pick one), lists keep their
 * order (a list IS ordered data), and `undefined` values are dropped — a caller
 * spreading `{...fm, status: undefined}` means "no status", not "null status".
 *
 * The accumulator has a NULL prototype, so a key that names an inherited
 * accessor (`__proto__` above all) becomes an ordinary own property and
 * survives the round trip like any other unknown field, instead of silently
 * vanishing into `Object.prototype`'s setter.
 *
 * Depth is indexed exactly as the parse-side walk (`guardShape`) indexes it —
 * the root mapping is depth 1 — and reads the SAME `maxFrontMatterDepth`, so
 * what parses always re-serializes.
 */
function canonicalize(value: unknown, limits: ArtifactLimits, depth = 1): unknown {
  if (depth > limits.maxFrontMatterDepth) {
    throw new ArtifactFormatError(
      "FRONT_MATTER_TOO_DEEP",
      `front matter nests deeper than ${limits.maxFrontMatterDepth} levels`,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, limits, depth + 1));
  if (typeof value === "object" && value !== null) {
    if (!isPlainMapping(value)) throw unrepresentable(describeHostObject(value));
    const source = value as Record<string, unknown>;
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of orderKeys(Object.keys(source))) {
      const child = source[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child, limits, depth + 1);
    }
    return out;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw unrepresentable(typeof value);
  }
  return value;
}

export function serializeArtifact(doc: ArtifactDocument, options?: SerializeOptions): string {
  // ONE canonical tree: the bytes emitted are structurally the same value that
  // was validated, and it can never be rebuilt differently between the two.
  const canonical = canonicalize(doc.frontMatter, resolveLimits(options));

  // Serializing never emits a file this library would refuse to read back.
  validateFrontMatter(canonical);

  const head = stringify(canonical, {
    version: "1.2",
    schema: "core",
    // No folding: a long value stays on one line so a byte diff tracks a data
    // change, not a re-wrap.
    lineWidth: 0,
    // Keep our own ordering (`canonicalize` already sorted).
    sortMapEntries: false,
    nullStr: "null",
  });

  const yamlBlock = head.endsWith("\n") ? head : `${head}\n`;
  return `---\n${yamlBlock}---\n${doc.body}`;
}

/**
 * Machine head edit: merge `patch` into the front matter and return a NEW
 * document with the body untouched (same reference, byte-identical). A patch
 * value of `undefined` removes the field.
 *
 * This is the read/update/re-serialize path — e.g. a state transition writing
 * `status` — and it exists so that path cannot accidentally rewrite the body.
 */
export function updateArtifactFrontMatter(
  doc: ArtifactDocument,
  patch: Partial<ArtifactFrontMatter> & Record<string, unknown>,
): ArtifactDocument {
  const merged: Record<string, unknown> = { ...doc.frontMatter };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return { frontMatter: validateFrontMatter(merged), body: doc.body };
}
