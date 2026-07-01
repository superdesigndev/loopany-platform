/**
 * Copy hand-authored plain-ESM runtime assets from src/ into dist/ at build time.
 *
 * tsc only emits .ts → .js; it neither compiles nor copies our `.mjs` files. But the
 * workflow subprocess (bare `node`, never tsx) must import `mcp-bridge.mjs` as a sibling
 * of the compiled workflow module in BOTH dev (src/) and prod (dist/). So we copy the
 * .mjs into dist/ here, chained ahead of `tsc` in build/prepublishOnly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "src");
const distDir = path.resolve(here, "..", "dist");

const ASSETS = ["mcp-bridge.mjs"];

fs.mkdirSync(distDir, { recursive: true });
for (const name of ASSETS) {
  const from = path.join(srcDir, name);
  const to = path.join(distDir, name);
  if (!fs.existsSync(from)) {
    throw new Error(
      `copy-runtime-assets: required asset ${name} not found at ${from} — refusing to build a package without it (tools.call would fail at runtime)`,
    );
  }
  fs.copyFileSync(from, to);
  console.log(`copy-runtime-assets: ${name} → dist/`);
}
