/**
 * File-flag containment fence: every `--*-file <path>` the CLI reads must live
 * inside the invoking working directory unless `--allow-external-file` is passed.
 *
 * Why: agents habitually write payload files to fixed /tmp paths.
 * A write that silently fails — or a stale file left by a DIFFERENT run or
 * environment minutes earlier — then feeds another run's content into this
 * command with no error anywhere. Requiring the file to live under the cwd turns
 * "silently read another run's file" into a loud command failure: an
 * incorrect-content bug becomes a command-errored bug.
 *
 * Pure helpers (no fs): callers resolve/read; this module only judges paths.
 */
import path from "node:path";

/** True when `p` (relative or absolute) resolves to cwd or below. */
export function isWithinCwd(p: string, cwd: string): boolean {
  const rel = path.relative(path.resolve(cwd), path.resolve(cwd, p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The escape-hatch flag; consumed by the fence, never forwarded to the server. */
export const ALLOW_EXTERNAL_FLAG = "--allow-external-file";

/**
 * Judge one file flag. Returns null when allowed, else the full error message
 * (already prefixed) the caller should emit before failing the command.
 */
export function fenceFileFlag(flagName: string, p: string, cwd: string, allowExternal: boolean): string | null {
  if (allowExternal || isWithinCwd(p, cwd)) return null;
  return (
    `loopany: ${flagName} must point inside the current working directory (got: ${p}).\n` +
    `  A path like /tmp is shared across runs and environments — a stale file left by a\n` +
    `  different run would silently become this command's content. Write the file to the\n` +
    `  cwd (e.g. ./payload.md), or pass ${ALLOW_EXTERNAL_FLAG} to override deliberately.\n`
  );
}
