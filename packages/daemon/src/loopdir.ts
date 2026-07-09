/**
 * Resolve a loop to its folder on this machine — the single source the artifact
 * watcher and `adscaile log` both use, so a workdir-scoped command maps the current
 * directory back to a loop exactly the way the watcher decides what to watch.
 *
 * Kept dependency-free (no chokidar) so the `adscaile log` path stays light.
 */
import os from "node:os";
import path from "node:path";

import { ADSCAILE_DIR } from "./config.js";

/** The loop fields needed to resolve its folder (subset of the loop row). */
export interface LoopDirSpec {
  loopId: string;
  workdir: string | null;
  taskFile: string | null;
}

export function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** The folder a loop lives in: dirname(taskFile) → workdir → daemon scratch dir.
 *  Mirrors the runner's workdir fallbacks; always returns an absolute path. */
export function resolveLoopDir(spec: LoopDirSpec): string {
  if (spec.taskFile) {
    const tf = expandTilde(spec.taskFile);
    // resolve() even when already absolute: a server-sent path may carry `..`
    // segments, and the jail checks downstream compare normalized paths.
    if (path.isAbsolute(tf)) return path.dirname(path.resolve(tf));
    if (spec.workdir) return path.dirname(path.resolve(expandTilde(spec.workdir), tf));
  }
  if (spec.workdir) return path.resolve(expandTilde(spec.workdir));
  return path.join(ADSCAILE_DIR, "work", spec.loopId);
}
