/**
 * The WORKSPACE REGISTRY - the bridge between a local `.loopany/` kernel
 * workspace and the resident production daemon that ticks it.
 *
 * A kernel workspace has no resident process: its cron loops only fire when
 * someone runs `loopany-kernel tick`. To get them ticked automatically, each
 * workspace registers itself here; the running `@crewlet/loopany` daemon reads
 * this file on a slow cadence and runs `<bin> tick --spawn` per entry.
 *
 * The file lives at `<home>/.loopany/kernel.json` (the daemon already owns
 * `~/.loopany/` for its pidfile / device token). It is a JSON array of entries:
 *   { dir: <absolute workspace dir holding .loopany>, bin: <absolute CLI entry> }
 * `bin` is the path of the CLI that registered the workspace, so the daemon
 * replays the EXACT binary that owns it (dev bin vs a global npm install) - the
 * daemon and kernel versions stay independent (subprocess-over-import).
 *
 * Reads are TOLERANT (a missing or corrupt file is an empty list, never a throw
 * at the caller - registry breakage must never fail a `tick` or the daemon's
 * poll loop). Writes are ATOMIC (temp-file + rename) and DEDUP by resolved dir.
 *
 * The home dir is an INJECTABLE seam (`RegistryDeps.home`) so tests never touch
 * the real `~/.loopany` - the CLI threads it through `deps.registryHome`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** One registered workspace: WHERE the `.loopany/` lives and WHICH CLI owns it. */
export interface RegistryEntry {
  /** Absolute path to the workspace dir that holds `.loopany/`. */
  dir: string;
  /** Absolute path to the `loopany-kernel` entry that registered it (replayed
   *  verbatim by the daemon so version skew between daemon and kernel is fine). */
  bin: string;
}

export interface RegistryDeps {
  /** The home dir under which `.loopany/kernel.json` lives. Defaults to the OS
   *  home; injected in tests so no real `~/.loopany` is ever written. */
  home?: string;
}

/** The state dir holding the registry. Resolution order:
 *   1. an explicitly INJECTED `home` (tests / the CLI `deps.registryHome` seam),
 *   2. `LOOPANY_HOME` - the SAME relocation env the daemon's `config.ts` honors,
 *      so a dev daemon + a dev CLI share one `.loopany` (its value IS the dir, so
 *      it is used verbatim, not joined with a second `.loopany`), else
 *   3. `~/.loopany` (the daemon's pidfile home).
 */
function registryDir(deps: RegistryDeps): string {
  if (deps.home !== undefined) return join(deps.home, ".loopany");
  const relocated = process.env.LOOPANY_HOME;
  if (relocated) return relocated;
  return join(homedir(), ".loopany");
}

/** The registry file path. */
export function registryPath(deps: RegistryDeps = {}): string {
  return join(registryDir(deps), "kernel.json");
}

/** Read the registry, tolerant of every failure: a missing file, unreadable
 *  bytes, invalid JSON, or a non-array/garbage shape all yield an EMPTY list.
 *  Individual entries missing `dir`/`bin` are dropped (never a partial that a
 *  consumer would crash on). Never throws. */
export function readRegistry(deps: RegistryDeps = {}): RegistryEntry[] {
  let raw: string;
  try {
    raw = readFileSync(registryPath(deps), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RegistryEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { dir, bin } = item as Record<string, unknown>;
    if (typeof dir !== "string" || dir.length === 0) continue;
    if (typeof bin !== "string" || bin.length === 0) continue;
    out.push({ dir, bin });
  }
  return out;
}

/** Atomically write the registry (temp-file + rename), creating the state dir. */
function writeRegistry(entries: RegistryEntry[], deps: RegistryDeps): void {
  const dir = registryDir(deps);
  mkdirSync(dir, { recursive: true });
  const path = registryPath(deps);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Register (or refresh) a workspace. DEDUP is by RESOLVED `dir`: a second
 *  register of the same workspace replaces its entry (a moved bin, e.g. a global
 *  install after a dev run, wins) rather than appending a duplicate. Returns the
 *  full list AFTER the upsert. */
export function registerWorkspace(
  entry: RegistryEntry,
  deps: RegistryDeps = {},
): RegistryEntry[] {
  const normalized: RegistryEntry = { dir: resolve(entry.dir), bin: entry.bin };
  const others = readRegistry(deps).filter((e) => resolve(e.dir) !== normalized.dir);
  const next = [...others, normalized];
  writeRegistry(next, deps);
  return next;
}

/** Remove a workspace by dir (resolved match). A no-op when it was not
 *  registered. Returns the full list AFTER the removal, and whether anything was
 *  actually removed. */
export function unregisterWorkspace(
  dir: string,
  deps: RegistryDeps = {},
): { entries: RegistryEntry[]; removed: boolean } {
  const target = resolve(dir);
  const before = readRegistry(deps);
  const entries = before.filter((e) => resolve(e.dir) !== target);
  const removed = entries.length !== before.length;
  // Only touch disk when something changed - an unregister of an unknown dir
  // leaves the file byte-identical (and never creates an empty registry).
  if (removed) writeRegistry(entries, deps);
  return { entries, removed };
}
