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
import { CORE_FIELD_ORDER, type ArtifactDocument, type ArtifactFrontMatter } from "./types.js";

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

/**
 * Deep canonical form: mappings get sorted keys at every depth (YAML mappings
 * are unordered, so ordering is presentation and we pick one), lists keep their
 * order (a list IS ordered data), and `undefined` values are dropped — a caller
 * spreading `{...fm, status: undefined}` means "no status", not "null status".
 */
function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > 64) {
    throw new ArtifactFormatError("FRONT_MATTER_TOO_DEEP", "front matter nests deeper than 64 levels");
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, depth + 1));
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of orderKeys(Object.keys(source))) {
      const child = source[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new ArtifactFormatError(
      "SCHEMA_VIOLATION",
      `front matter cannot hold a ${typeof value} value`,
      { issues: [{ path: "<front matter>", message: `unrepresentable ${typeof value} value` }] },
    );
  }
  return value;
}

export function serializeArtifact(doc: ArtifactDocument): string {
  // Serializing never emits a file this library would refuse to read back.
  validateFrontMatter(canonicalize(doc.frontMatter));

  const head = stringify(canonicalize(doc.frontMatter), {
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
