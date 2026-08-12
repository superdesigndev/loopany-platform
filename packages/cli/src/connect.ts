/**
 * GLOBAL remote binding - `loopany-kernel connect <url> --token <dk_...>`.
 *
 * The stored pair lives at `<LOOPANY_HOME|~/.loopany>/kernel-backend.json`
 * (0600, same home + discipline as the daemon's device-token). Resolution
 * precedence is deliberate:
 *
 *   env LOOPANY_KERNEL_BACKEND  >  cwd workspace config  >  global binding
 *
 * env first preserves the in-run authority rule (a daemon-spawned agent's
 * backend can never be hijacked by ambient state); the WORKSPACE beats the
 * global so standing inside any local `.loopany` keeps local semantics - a
 * forgotten global binding must never silently redirect a local write to a
 * server. `--remote` on any verb forces the global binding from anywhere.
 *
 * LONG-TERM: when the kernel CLI merges into `loopany`, this file retires and
 * the global layer reads the daemon's own `~/.loopany/{server-url,device-token}`
 * - one credential home, no drift. The `connect` verb's surface stays.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GlobalConnect {
  backend: string;
  token: string;
}

type Env = Record<string, string | undefined>;

/** The binding file path. `LOOPANY_HOME` overrides the home (same env the
 *  daemon honors, so a dev shell isolates both with one variable). */
export function connectPath(env: Env): string {
  return join(env.LOOPANY_HOME || join(homedir(), ".loopany"), "kernel-backend.json");
}

/** Read the global binding; null when absent or malformed (a broken file must
 *  never take the CLI down - `connect` overwrites it). */
export function readGlobalConnect(env: Env): GlobalConnect | null {
  try {
    const raw = JSON.parse(readFileSync(connectPath(env), "utf8")) as Partial<GlobalConnect>;
    if (typeof raw.backend !== "string" || !/^https?:\/\//.test(raw.backend)) return null;
    if (typeof raw.token !== "string" || raw.token.length === 0) return null;
    return { backend: raw.backend.replace(/\/+$/, ""), token: raw.token };
  } catch {
    return null;
  }
}

/** Persist the binding (dir 0700, file 0600 - it holds a device credential).
 *  Returns the written path. */
export function writeGlobalConnect(env: Env, binding: GlobalConnect): string {
  const path = connectPath(env);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ backend: binding.backend.replace(/\/+$/, ""), token: binding.token }, null, 2) + "\n");
  chmodSync(path, 0o600);
  return path;
}

/** Remove the binding. Returns whether one existed. */
export function clearGlobalConnect(env: Env): boolean {
  const existed = readGlobalConnect(env) !== null;
  rmSync(connectPath(env), { force: true });
  return existed;
}

/** A display-safe token form: prefix + last 4, never the middle. */
export function redactToken(token: string): string {
  if (token.length <= 8) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 7)}…${token.slice(-4)}`;
}
