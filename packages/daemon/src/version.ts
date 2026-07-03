/**
 * Daemon self-version — the version string this CLI reports to the server on
 * every poll (so the web can flag an outdated daemon), plus the tiny
 * running-version file `loopany update` reads to say "v<old> → v<new>".
 *
 * `daemonVersion()` resolves THIS package's own package.json version robustly for
 * both layouts: `../package.json` sits beside the package root from BOTH `src/`
 * (tsx dev) and `dist/` (built) — the same `../skill` trick `bundledSkillDir`
 * uses. Returns undefined if the file is missing/garbage (never throws).
 *
 * The running-version file (`~/.loopany/daemon.version`, beside the pidfile) is a
 * best-effort record of which version the CURRENTLY RUNNING detached daemon
 * booted as. The daemon writes it on boot; `loopany update` reads it BEFORE it
 * stops the old daemon so it can print the old→new summary. It's optional and
 * fully backward-compatible: an old daemon that never wrote it just makes the old
 * version "unknown".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOOPANY_DIR } from "./config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** This package's own version (from its package.json). Undefined if unreadable. */
export function daemonVersion(base = moduleDir): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(base, "..", "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Where the running daemon records its own version (beside the pidfile). */
export const VERSION_FILE = path.join(LOOPANY_DIR, "daemon.version");

/** Record the running daemon's version (best-effort; called on boot). */
export function writeRunningVersion(version: string | undefined = daemonVersion()): void {
  if (!version) return;
  try {
    fs.mkdirSync(LOOPANY_DIR, { recursive: true });
    fs.writeFileSync(VERSION_FILE, `${version}\n`, { mode: 0o600 });
  } catch {
    /* best-effort — `update` just won't know the old version */
  }
}

/** The version the currently-running daemon booted as, or undefined. */
export function readRunningVersion(): string | undefined {
  try {
    return fs.readFileSync(VERSION_FILE, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
