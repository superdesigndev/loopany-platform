/**
 * Per-day SNAPSHOT capture - a full recursive copy of the workspace's kernel
 * state (`.loopany/`: objects/events/triggers/runs) and its `mirrors/` into
 * `out/<runId>/day-<N>/`. These snapshots are the scoring input (§6 rubric): the
 * event logs and object files are read after the run to compute the hard metrics.
 *
 * The out root is derived from a CALLER-SUPPLIED `runId` (never Date.now), so a
 * scenario run is fully deterministic and re-runnable into the same tree.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package-local `out/` dir (gitignored). Resolved relative to this module
 *  so it lands under packages/simulator regardless of the process cwd. */
export function outRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "out");
}

/** The snapshot dir for a given run + day index (1-based). */
export function snapshotDirFor(runId: string, dayIndex: number): string {
  return join(outRoot(), runId, `day-${dayIndex}`);
}

/** Copy `.loopany/` + `mirrors/` from the workspace into the day's snapshot dir.
 *  Returns the snapshot dir. A missing `mirrors/` (a scenario with no mirror
 *  writes yet) is simply skipped - not an error. */
export function captureDay(workspace: string, runId: string, dayIndex: number): string {
  const dest = snapshotDirFor(runId, dayIndex);
  mkdirSync(dest, { recursive: true });
  copyTree(join(workspace, ".loopany"), join(dest, ".loopany"));
  const mirrors = join(workspace, "mirrors");
  if (existsSync(mirrors)) copyTree(mirrors, join(dest, "mirrors"));
  return dest;
}

/** Recursive copy of a dir. The `.loopany/lock` file is transient (held only
 *  during a command) so it may be absent; cpSync tolerates that. */
function copyTree(src: string, dest: string): void {
  if (!existsSync(src)) return;
  cpSync(src, dest, { recursive: true });
}
