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

const BANNER = {
  // esbuild hoists the SOURCE entry's shebang to line 1 itself; the banner
  // only adds the createRequire shim that keeps CJS interop inside the ESM
  // bundle working.
  js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: BANNER,
  logLevel: "warning",
});

// The HUMAN TUI ships as a SEPARATE lazy chunk (review round 3): the callback
// bundle above stays Ink/React-free (in-run agents never pay for a TUI), while
// `loopany-kernel kanban` on a packed install dynamic-imports this sibling.
const kanbanEntry = join(here, "..", "..", "cli", "src", "kanban", "bin.ts");
const kanbanOut = join(here, "..", "dist", "kernel-kanban.mjs");
await build({
  entryPoints: [kanbanEntry],
  outfile: kanbanOut,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: BANNER,
  // Ink needs the JSX runtime + react bundled; both are pure JS. Ink's optional
  // devtools bridge is DEV-only (loaded solely under process.env.DEV); a plain
  // `external` would hoist its import to the single-file bundle's top level and
  // fail eagerly at load, so alias it to a no-op stub instead.
  alias: { "react-devtools-core": join(here, "stub-react-devtools.mjs") },
  logLevel: "warning",
});

console.log(`bundled kernel CLI -> ${outfile}`);
console.log(`bundled kanban TUI chunk -> ${kanbanOut}`);
