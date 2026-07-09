/**
 * Workdir-jail helpers (ADSCAILE_ROOTS). The daemon's env roots are the LOCAL,
 * always-enforced jail; server-sent roots may only NARROW it, never widen it —
 * every server-controlled path (a run's workdir, a watched loop folder, a
 * task-file read) is checked against these before it's touched. With no local
 * roots configured, behavior is unchanged (fully open — the documented default).
 */
import path from "node:path";

import { ADSCAILE_DIR } from "./config.js";
import { expandTilde } from "./loopdir.js";

/** Absolute, tilde-expanded form of a configured root. */
function resolveRoot(root: string): string {
  return path.resolve(expandTilde(root));
}

/** Absolute, tilde-expanded forms of a configured root list — resolve ONCE and
 *  reuse via isWithinResolvedRoots (hot callers like the watcher's per-poll
 *  reconcile shouldn't re-resolve the same fixed list on every check). */
export function resolveRoots(roots: string[]): string[] {
  return roots.map(resolveRoot);
}

/** Compare-only jail check against PRE-RESOLVED roots (see resolveRoots).
 *  An empty list is "no jail" — but callers gate on `roots.length` first, so
 *  empty never silently allows here. `abs` is normalized before the prefix
 *  compare: a server-sent path can carry unresolved `..` segments
 *  (`/jail/root/../../…`) that a raw lexical startsWith would wrongly admit
 *  while the OS resolves it OUTSIDE the jail. */
export function isWithinResolvedRoots(abs: string, resolvedRoots: string[]): boolean {
  const a = path.resolve(abs);
  return resolvedRoots.some((r) => a === r || a.startsWith(r + path.sep));
}

/** Is `abs` at/under any of the given (possibly unresolved) roots? */
export function isWithinRoots(abs: string, roots: string[]): boolean {
  return isWithinResolvedRoots(abs, resolveRoots(roots));
}

/** The daemon-owned per-loop scratch parent (`~/.adscaile/work`). Computed once —
 *  ADSCAILE_DIR is itself fixed at module load (env read at import time). */
const SCRATCH_DIR = path.join(ADSCAILE_DIR, "work");

/** Is `abs` the scratch parent or under it? Its location is fixed locally —
 *  never server-chosen — so it's allowed even under a jail (mirrors the
 *  runner's no-workdir fallback, which skips the roots check for the same
 *  reason). `abs` gets the same `..`-normalization as isWithinResolvedRoots. */
export function isScratchDir(abs: string): boolean {
  const a = path.resolve(abs);
  return a === SCRATCH_DIR || a.startsWith(SCRATCH_DIR + path.sep);
}

/**
 * The jail a run must obey. Local env roots (when set) ALWAYS apply: server-sent
 * roots survive only when they sit inside a local root (narrowing); disjoint
 * server roots are ignored and the local jail stands — a hostile/compromised
 * server must never be able to widen the jail and point a run at e.g. ~/.ssh.
 * With no local roots the server's roots apply as before (fully open when
 * neither is set).
 */
export function effectiveRoots(local: string[], server: string[] | undefined): string[] {
  if (local.length === 0) return server ?? [];
  if (!server?.length) return local;
  const resolvedLocal = resolveRoots(local);
  const narrowed = server.filter((s) => isWithinResolvedRoots(resolveRoot(s), resolvedLocal));
  return narrowed.length ? narrowed : local;
}
