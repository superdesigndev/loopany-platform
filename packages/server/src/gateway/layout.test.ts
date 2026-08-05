import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * Gateway layout guard - pins the module structure the CliGateway extraction cut
 * established, so it can't silently regress in review noise (same test-as-guardrail
 * pattern as the daemon's sync-skill.test.ts):
 *
 *   - dependency direction is one-way: cli.ts imports index.ts, never the
 *     reverse (no cycles, the core never depends on its satellite);
 *   - both write surfaces import the ONE validators module (the anti-drift
 *     invariant documented in validate.ts);
 *   - http.ts stays a leaf (shared wire helpers must not grow gateway deps);
 *   - the retired byte-ingress module (sync.ts) stays gone.
 */

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** The module specifiers a file imports via `from "..."` (static imports only -
 *  the gateway modules under test use no dynamic import of siblings). */
const importsOf = (source: string): string[] =>
  [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

test("index.ts never imports its extracted satellite (cli.ts)", () => {
  expect(importsOf(read("index.ts"))).not.toContain("./cli.js");
});

test("the retired byte-ingress module is gone and nothing imports it", () => {
  // Path in a VARIABLE: Vite statically rewrites a LITERAL new URL("./x", import.meta.url).
  const rel = "./sync.ts";
  expect(existsSync(fileURLToPath(new URL(rel, import.meta.url)))).toBe(false);
  for (const name of ["index.ts", "cli.ts", "http.ts", "retention.ts"]) {
    expect(importsOf(read(name))).not.toContain("./sync.js");
  }
});

test("both write surfaces import the one validators module (anti-drift)", () => {
  expect(importsOf(read("index.ts"))).toContain("./validate.js");
  expect(importsOf(read("cli.ts"))).toContain("./validate.js");
});

test("http.ts is a leaf module (no gateway-internal imports)", () => {
  expect(importsOf(read("http.ts")).filter((s) => s.startsWith("./"))).toEqual([]);
});
