/**
 * Extra watch/sync folders for a loop (`syncPaths`). Resolves the loop's
 * configured entries — from the server-sent watch spec AND the machine-local
 * `.loopany-sync.json` in the loop folder — into the concrete root set the
 * watcher watches and syncs: `[{ absDir, prefix }]`, where `prefix` heads every
 * synced path from that root (`signals/FB-1.md`), keeping it disjoint from the
 * loop folder's own unprefixed tree.
 *
 * Security stance: these paths are server-/repo-authored, so every root passes
 * the SAME LOOPANY_ROOTS jail as the loop folder itself, and the watcher's
 * secrets/junk ignore rules apply inside each root. Anything invalid is skipped
 * with a warn log — a bad entry must never take the healthy roots down with it.
 *
 * Kept chokidar-free (like loopdir.ts) so non-watcher callers can share it.
 */
import fs from "node:fs";
import path from "node:path";

import { logger } from "./logger.js";
import { expandTilde } from "./loopdir.js";
import { isScratchDir, isWithinResolvedRoots } from "./roots.js";

const log = logger.child({ mod: "syncroots" });

/** One configured extra folder: a machine path (relative → the loop's workdir;
 *  absolute / `~/` allowed), optionally with an explicit sync prefix `as`
 *  (default: the folder's basename). Mirrors the server's SyncPathEntry. */
export type SyncPathEntry = string | { path?: string; as?: string };

/** One resolved watch root. The loop folder itself is `{ absDir, prefix: "" }`. */
export interface SyncRoot {
  absDir: string;
  prefix: string;
}

/** The machine-local config file read from the loop folder (additive union with
 *  the server-sent field). Shape: `{ "syncPaths": [ ... ] }`. */
export const LOCAL_SYNC_CONFIG = ".loopany-sync.json";

const MAX_ROOTS = 8;

/** Skips already warned about (deduped — resolution reruns every poll). */
const warned = new Set<string>();

/** A usable prefix: clean relative segments, no `..`/`.`, no separators abuse. */
function validPrefix(prefix: string): boolean {
  if (!prefix || prefix.length > 128) return false;
  if (prefix.includes("\\") || path.isAbsolute(prefix)) return false;
  const segs = prefix.split("/");
  return segs.every((s) => s !== "" && s !== "." && s !== "..");
}

function readLocalEntries(mainDir: string): SyncPathEntry[] {
  const file = path.join(mainDir, LOCAL_SYNC_CONFIG);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return []; // absent — the common case
  }
  try {
    const parsed = JSON.parse(text) as { syncPaths?: unknown };
    const list = Array.isArray(parsed) ? parsed : parsed?.syncPaths;
    if (!Array.isArray(list)) {
      log.warn({ file }, `invalid ${LOCAL_SYNC_CONFIG}: expected {"syncPaths": [...]} — ignored`);
      return [];
    }
    return list as SyncPathEntry[];
  } catch (err) {
    log.warn({ file, err: err instanceof Error ? err.message : String(err) }, `unparseable ${LOCAL_SYNC_CONFIG} — ignored`);
    return [];
  }
}

/** Is `a` at/under `b`? (both pre-resolved absolute) */
function isUnder(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep);
}

/**
 * Resolve a loop's extra sync roots. `entries` = the server-sent `syncPaths`;
 * the loop folder's `.loopany-sync.json` is unioned in. `resolvedRoots` = the
 * daemon's pre-resolved LOOPANY_ROOTS ([] ⇒ no jail). Invalid/unsafe entries are
 * skipped with a warn, never fatal. The returned list excludes the main dir
 * (the caller pairs it with `{ absDir: mainDir, prefix: "" }`).
 */
export function resolveSyncRoots(
  loopId: string,
  entries: SyncPathEntry[] | null | undefined,
  mainDir: string,
  workdir: string | null | undefined,
  resolvedRoots: string[],
): SyncRoot[] {
  const main = path.resolve(mainDir);
  const all = [...(entries ?? []), ...readLocalEntries(main)];
  if (!all.length) return [];

  const base = workdir ? path.resolve(expandTilde(workdir)) : main;
  const roots: SyncRoot[] = [];
  const usedPrefixes = new Set<string>();
  const warn = (raw: unknown, reason: string): void => {
    // Resolution reruns on every ~3s poll — warn each distinct skip ONCE, not
    // twenty times a minute (the skip repeats until the config/folder changes).
    const entry = typeof raw === "string" ? raw : JSON.stringify(raw);
    const key = `${loopId}|${entry}|${reason}`;
    if (warned.has(key)) return;
    warned.add(key);
    log.warn({ loopId, entry, reason }, "syncPaths entry skipped");
  };

  for (const entry of all) {
    if (roots.length >= MAX_ROOTS) {
      warn(entry, `more than ${MAX_ROOTS} sync roots — rest ignored`);
      break;
    }
    const rawPath = typeof entry === "string" ? entry : entry?.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      warn(entry, "missing path");
      continue;
    }
    const expanded = expandTilde(rawPath.trim());
    const absDir = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);

    // The jail: extra roots are server-/repo-authored paths — same rule as the
    // loop folder itself (scratch stays exempt; its location is fixed locally).
    if (resolvedRoots.length && !isWithinResolvedRoots(absDir, resolvedRoots) && !isScratchDir(absDir)) {
      warn(entry, "outside LOOPANY_ROOTS");
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(absDir);
    } catch {
      warn(entry, "folder does not exist");
      continue;
    }
    if (!st.isDirectory()) {
      warn(entry, "not a directory");
      continue;
    }
    // Nesting guards: a root inside the loop folder already syncs unprefixed
    // (prefixing it would duplicate every file); a root CONTAINING the loop
    // folder would re-sync the loop's own tree under the prefix.
    if (isUnder(absDir, main)) {
      warn(entry, "inside the loop folder — already synced");
      continue;
    }
    if (isUnder(main, absDir)) {
      warn(entry, "contains the loop folder — would double-sync it");
      continue;
    }
    if (roots.some((r) => isUnder(absDir, r.absDir) || isUnder(r.absDir, absDir))) {
      warn(entry, "overlaps another sync root");
      continue;
    }

    const prefix = (typeof entry === "object" && entry?.as?.trim()) || path.basename(absDir);
    if (!validPrefix(prefix)) {
      warn(entry, `unusable prefix "${prefix}"`);
      continue;
    }
    if (usedPrefixes.has(prefix)) {
      warn(entry, `prefix "${prefix}" already taken by another sync root`);
      continue;
    }
    // A prefix that shadows an existing top-level entry of the loop folder would
    // interleave two trees under one path — refuse loudly instead.
    if (fs.existsSync(path.join(main, prefix.split("/")[0]!))) {
      warn(entry, `prefix "${prefix}" collides with an entry in the loop folder`);
      continue;
    }

    usedPrefixes.add(prefix);
    roots.push({ absDir, prefix });
  }
  return roots;
}
