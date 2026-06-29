/**
 * Machine-local config under ~/.loopany — the device token (machine identity)
 * and the server URL. The daemon persists both when it connects; the interactive
 * `loopany loops` / `loopany edit` commands read them back so editing a loop from
 * the owner's Claude Code is zero-config (no re-auth, no flags).
 *
 * Set LOOPANY_HOME to relocate this dir — run a dev daemon against localhost with
 * `LOOPANY_HOME=~/.loopany-dev` so its identity/server don't clobber the prod
 * `~/.loopany` you keep connected to the live server (and vice-versa).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOOPANY_DIR = process.env.LOOPANY_HOME || path.join(os.homedir(), ".loopany");
export const DEVICE_FILE = path.join(LOOPANY_DIR, "device-token");
export const SERVER_FILE = path.join(LOOPANY_DIR, "server-url");

/** Best-effort 0600 persistence (so a stable identity survives restarts). */
export function persist(file: string, value: string): void {
  try {
    fs.mkdirSync(LOOPANY_DIR, { recursive: true });
    fs.writeFileSync(file, value, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function readStored(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Read a `--flag value` from an argv slice (bare/terminal `--flag` → ""). */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
}

/** Resolve this machine's server URL: explicit flag → env → stored, with any
 *  trailing slash stripped (so `${server}/api/...` never doubles up). */
export function resolveServerUrl(flagValue: string | undefined): string {
  return (flagValue || process.env.LOOPANY_SERVER_URL || readStored(SERVER_FILE) || "").replace(/\/$/, "");
}
