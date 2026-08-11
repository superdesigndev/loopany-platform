/**
 * Bundle the kernel CLI (`@loopany/cli`, a PRIVATE workspace package that runs
 * from source via tsx) into ONE self-contained ESM file the published daemon
 * ships: `dist/kernel-cli.mjs`, exposed as the `loopany-kernel` bin.
 *
 * WHY A BUNDLE: the server-frozen kernel CORE prompt instructs the spawned
 * agent to run `loopany-kernel <verb>`. The daemon npm package cannot DEPEND on
 * @loopany/cli (private, source-run), so without this step an npm-installed
 * daemon spawns agents that cannot execute any kernel callback at all (the
 * 2026-08-11 codex review's blocking finding). All transitive deps are pure JS
 * (yaml, croner), so the bundle is clean; node builtins stay external.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "..", "cli", "src", "bin.ts");
const outfile = join(here, "..", "dist", "kernel-cli.mjs");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    // esbuild hoists the SOURCE entry's shebang to line 1 itself; the banner
    // only adds the createRequire shim that keeps CJS interop inside the ESM
    // bundle working.
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
  logLevel: "warning",
});

console.log(`bundled kernel CLI -> ${outfile}`);
