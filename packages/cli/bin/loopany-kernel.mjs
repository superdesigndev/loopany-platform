#!/usr/bin/env node
/**
 * The published `loopany-kernel` launcher. This is a PLAIN `.mjs` so bare
 * `node` runs it with no build step and no loader flags. The real entry
 * (`src/bin.ts`) is TypeScript with `.js`-extension ESM imports (the vitest /
 * tsc idiom) — bare node cannot resolve those against `.ts` files, so we
 * re-exec `src/bin.ts` through the bundled `tsx` runtime, which strips types
 * AND rewrites the `.js`→`.ts` specifiers.
 *
 * Why a spawn and not `import("tsx/esm")`: tsx's programmatic API is version-
 * sensitive; spawning its resolved binary is the stable contract, and it keeps
 * this shim testable by a process-spawn smoke test (the run()-only E2E cannot
 * mask a broken bin). The child inherits stdio and its exit code becomes ours.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "bin.ts");
const require = createRequire(import.meta.url);

// Resolve tsx's CLI from THIS package's dependency tree (never PATH), so the
// launcher works regardless of the caller's global installs.
const tsxCli = require.resolve("tsx/cli");

// Record THIS launcher's absolute path so the workspace registry (written by
// `init`/`register`) points the daemon at the node-runnable `.mjs` entry - never
// the tsx-only `src/bin.ts` the child sees as its own argv[1].
const child = spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, LOOPANY_KERNEL_BIN: fileURLToPath(import.meta.url) },
});

if (child.error) {
  process.stderr.write(`loopany-kernel: failed to launch: ${child.error.message}\n`);
  process.exit(1);
}
process.exit(child.status ?? 1);
