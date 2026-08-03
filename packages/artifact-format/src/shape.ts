/**
 * The shape ceilings, defined ONCE.
 *
 * Depth and node count are properties of the front-matter VALUE, not of one
 * direction's bytes, so both directions run this same walk: the parser applies
 * it to the tree it just materialized, and the writer applies it to the
 * canonical tree it is about to emit. Read and write therefore cannot drift
 * about what a ceiling means or where it sits.
 */

import { ArtifactFormatError } from "./errors.js";
import type { ArtifactLimits } from "./types.js";

/**
 * Iterative (never recursive — a deep value must not blow OUR stack while we
 * check whether it is too deep) depth + node-count walk. Depth is counted from
 * the root mapping: the root is 1, its values are 2, and so on.
 */
export function guardShape(value: unknown, limits: ArtifactLimits): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;

  while (stack.length > 0) {
    const entry = stack.pop() as { value: unknown; depth: number };
    nodes += 1;
    if (nodes > limits.maxFrontMatterNodes) {
      throw new ArtifactFormatError(
        "FRONT_MATTER_TOO_MANY_NODES",
        `front matter has more than ${limits.maxFrontMatterNodes} nodes`,
      );
    }
    if (entry.depth > limits.maxFrontMatterDepth) {
      throw new ArtifactFormatError(
        "FRONT_MATTER_TOO_DEEP",
        `front matter nests deeper than ${limits.maxFrontMatterDepth} levels`,
      );
    }
    const v = entry.value;
    if (Array.isArray(v)) {
      for (const child of v) stack.push({ value: child, depth: entry.depth + 1 });
    } else if (typeof v === "object" && v !== null) {
      for (const child of Object.values(v as Record<string, unknown>)) {
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
}
