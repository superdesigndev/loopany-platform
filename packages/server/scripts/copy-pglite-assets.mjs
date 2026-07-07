#!/usr/bin/env node
// Postbuild: copy @electric-sql/pglite's runtime assets next to the nitro-bundled
// module so the EMBEDDED pglite tier works in the BUILT server.
//
// nitro bundles pglite's JS into `.output/server/_libs/electric-sql__pglite.mjs`
// but does NOT copy its WASM/data runtime assets. At runtime the bundled module
// opens `pglite.data` / `pglite.wasm` RELATIVE to its own directory (`_libs/`), so
// the first DB query dies with ENOENT and the whole embedded/self-host tier
// (`pnpm start` / Docker / fly.toml's pglite default) is broken. This step copies
// the assets into `_libs/` (beside the bundled module) to close that gap.
//
// It is intentionally forgiving: if there is no `.output` (e.g. a bare checkout, or
// this ran without a build) it logs and exits 0 — safe to run unconditionally.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const outputRoot = path.join(serverRoot, ".output", "server");

if (!fs.existsSync(outputRoot)) {
  console.log(`[copy-pglite-assets] no build output at ${outputRoot} — skipping`);
  process.exit(0);
}

// Resolve pglite's dist dir by resolving its main entry (its package.json blocks
// the `./package.json` subpath via "exports"), then taking the entry's directory.
const require = createRequire(import.meta.url);
const pgliteDist = path.dirname(require.resolve("@electric-sql/pglite"));

// Copy every WASM/data asset present (pglite.wasm, pglite.data, initdb.wasm, ...).
const assets = fs
  .readdirSync(pgliteDist)
  .filter((f) => f.endsWith(".wasm") || f.endsWith(".data"));

if (assets.length === 0) {
  console.warn(`[copy-pglite-assets] no *.wasm/*.data assets found in ${pgliteDist}`);
  process.exit(0);
}

// Land the assets in the SAME directory as the bundled pglite module — the runtime
// error path is `<module dir>/pglite.data`. Locate `_libs/*pglite*.mjs` under the
// output; fall back to `.output/server/_libs/`.
const targets = new Set();
const libsDir = path.join(outputRoot, "_libs");
walk(outputRoot, (file) => {
  const rel = path.relative(outputRoot, file);
  if (rel.startsWith("_libs" + path.sep) && /pglite.*\.mjs$/.test(path.basename(file))) {
    targets.add(path.dirname(file));
  }
});
if (targets.size === 0) targets.add(libsDir);

for (const dir of targets) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of assets) {
    fs.copyFileSync(path.join(pgliteDist, name), path.join(dir, name));
    console.log(`[copy-pglite-assets] ${name} → ${path.relative(serverRoot, path.join(dir, name))}`);
  }
}

// Ship the drizzle migrations folder beside the server bundle so the EMBEDDED
// pglite tier can apply them IN-PROCESS at boot (its only migration path —
// db/index.ts `runMigrations` → `migrationsDir` resolves `.output/server/drizzle`).
// nitro bundles the JS but never the `.sql` migration files, so without this the
// built pglite server boots with NO tables and the first DB query 500s.
const migrationsSrc = path.join(serverRoot, "drizzle");
const migrationsDest = path.join(outputRoot, "drizzle");
if (fs.existsSync(migrationsSrc)) {
  fs.cpSync(migrationsSrc, migrationsDest, { recursive: true });
  console.log(`[copy-pglite-assets] drizzle/ → ${path.relative(serverRoot, migrationsDest)}`);
} else {
  console.warn(`[copy-pglite-assets] no drizzle/ migrations at ${migrationsSrc} — pglite tier will boot unmigrated`);
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else if (entry.isFile()) onFile(full);
  }
}
