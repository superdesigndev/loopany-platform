#!/usr/bin/env node
/**
 * The `loopany-kernel` executable. Thin: it collects the real environment
 * (cwd / now / env) and hands off to the pure `run(argv, deps)`, then writes the
 * outcome and exits. All logic is testable without a process (cli.ts).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./cli.js";
import { realSpawn } from "./spawn.js";

// PACKED-INSTALL kanban (review round 3): the workspace launcher intercepts
// `kanban` before this entry, so reaching here with it means the daemon's
// BUNDLED bin. The TUI ships as a SIBLING lazy chunk (kernel-kanban.mjs) so the
// callback bundle itself stays Ink/React-free; when the chunk is present we
// hand over to it, otherwise cli.ts renders the directed refusal.
if (process.argv[2] === "kanban") {
  const sibling = new URL("./kernel-kanban.mjs", import.meta.url);
  if (existsSync(fileURLToPath(sibling))) {
    process.argv.splice(2, 1); // the chunk's own entry reads no verb
    await import(sibling.href); // runs the TUI and exits
    process.exit(0);
  }
}

const outcome = run(process.argv.slice(2), {
  cwd: process.cwd(),
  now: new Date().toISOString(),
  env: process.env,
  spawn: realSpawn,
  // The absolute path recorded in the workspace registry at `init`/`register` so
  // the daemon replays the exact binary that owns the workspace. The `.mjs`
  // launcher re-execs this file via tsx, so our own argv[1] is the tsx-only
  // `src/bin.ts` - not node-runnable directly. The launcher passes its own
  // durable path via LOOPANY_KERNEL_BIN; fall back to argv[1] when run directly.
  binPath: process.env.LOOPANY_KERNEL_BIN ?? process.argv[1],
});

if (outcome.stdout) process.stdout.write(outcome.stdout + "\n");
if (outcome.stderr) process.stderr.write(outcome.stderr + "\n");
process.exit(outcome.exitCode);
