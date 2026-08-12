/**
 * GLOBAL remote binding - `loopany-kernel connect <url> --token <dk_...>`.
 *
 * ONE CREDENTIAL HOME (kernel-one-credential-home): the CLI's global layer
 * reads and writes the DAEMON's own files under `<LOOPANY_HOME|~/.loopany>` -
 *
 *   server-url     the server base URL      (daemon convention, plain text)
 *   device-token   the dk_ machine identity (daemon convention, 0600)
 *   me             who the human behind the credential is (CLI-only addition)
 *
 * so a machine that ran `loopany up` is ALREADY connected for the owner CLI,
 * and `connect` conversely seeds the token `loopany up` will adopt. There is no
 * second binding to drift. The pre-unification `kernel-backend.json` is
 * migrated on first read (files win when both exist) and removed.
 *
 * Resolution precedence is deliberate and unchanged:
 *
 *   env LOOPANY_KERNEL_BACKEND  >  cwd workspace config  >  this home
 *
 * env first preserves the in-run authority rule; the WORKSPACE beats the
 * global so standing inside any local `.loopany` keeps local semantics.
 * `--remote` on any verb forces the global binding from anywhere.
 *
 * GATED-MODE FUTURE: the server will resolve the credential's identity
 * (whoami) and validate/auto-fill `me`; the file stays the local cache.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GlobalConnect {
  backend: string;
  token: string;
  /** WHO the human behind this credential is (their kernel assignee email) -
   *  the identity `inbox` filters by on the remote backend. */
  me?: string;
}

type Env = Record<string, string | undefined>;

/** The credential home. `LOOPANY_HOME` overrides (same env the daemon honors,
 *  so a dev shell isolates BOTH tools with one variable). */
export function credentialHome(env: Env): string {
  return env.LOOPANY_HOME || join(homedir(), ".loopany");
}

/** The daemon-convention files this module shares with `loopany up`. */
export function connectFiles(env: Env): { server: string; token: string; me: string; legacy: string } {
  const home = credentialHome(env);
  return {
    server: join(home, "server-url"),
    token: join(home, "device-token"),
    me: join(home, "me"),
    legacy: join(home, "kernel-backend.json"),
  };
}

function readText(path: string): string | undefined {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeSecret(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600); // an existing file keeps its old mode without this
}

/** Read the global binding; null when absent or malformed. Migrates the
 *  pre-unification `kernel-backend.json` ONCE (files win when both exist). */
export function readGlobalConnect(env: Env): GlobalConnect | null {
  const files = connectFiles(env);
  migrateLegacy(env);
  const backend = readText(files.server);
  const token = readText(files.token);
  if (!backend || !/^https?:\/\//.test(backend) || !token) return null;
  const me = readText(files.me);
  return {
    backend: backend.replace(/\/+$/, ""),
    token,
    ...(me && me.includes("@") ? { me } : {}),
  };
}

/** Persist the binding into the ONE home (dir 0700, secrets 0600). Returns the
 *  home dir. The daemon's next `loopany up` adopts this token (readToken()
 *  precedes --connect-key), so CLI and daemon cannot point at different
 *  servers/credentials from here. */
export function writeGlobalConnect(env: Env, binding: GlobalConnect): string {
  const files = connectFiles(env);
  mkdirSync(credentialHome(env), { recursive: true, mode: 0o700 });
  writeSecret(files.server, binding.backend.replace(/\/+$/, ""));
  writeSecret(files.token, binding.token);
  if (binding.me) writeSecret(files.me, binding.me);
  rmSync(files.legacy, { force: true }); // the second binding must not linger
  return credentialHome(env);
}

/** Remove the binding. Returns whether one existed. NB with ONE credential
 *  home this clears the MACHINE's connection - the daemon's next `loopany up`
 *  will need an explicit --connect-key again (the caller warns). */
export function clearGlobalConnect(env: Env): boolean {
  const existed = readGlobalConnect(env) !== null;
  const files = connectFiles(env);
  for (const f of [files.server, files.token, files.me, files.legacy]) rmSync(f, { force: true });
  return existed;
}

/** ONE-SHOT migration of the pre-unification `kernel-backend.json`: fill only
 *  the MISSING daemon-convention files (an existing daemon connection always
 *  wins), then remove the legacy file. Malformed legacy content is dropped -
 *  `connect` rewrites it cleanly. */
function migrateLegacy(env: Env): void {
  const files = connectFiles(env);
  const raw = readText(files.legacy);
  if (raw === undefined) return;
  try {
    const legacy = JSON.parse(raw) as { backend?: unknown; token?: unknown; me?: unknown };
    mkdirSync(credentialHome(env), { recursive: true, mode: 0o700 });
    if (typeof legacy.backend === "string" && /^https?:\/\//.test(legacy.backend) && readText(files.server) === undefined) {
      writeSecret(files.server, legacy.backend.replace(/\/+$/, ""));
    }
    if (typeof legacy.token === "string" && legacy.token.length > 0 && readText(files.token) === undefined) {
      writeSecret(files.token, legacy.token);
    }
    if (typeof legacy.me === "string" && legacy.me.includes("@") && readText(files.me) === undefined) {
      writeSecret(files.me, legacy.me);
    }
  } catch {
    /* malformed legacy file - just retire it */
  }
  rmSync(files.legacy, { force: true });
}

/** A display-safe token form: prefix + last 4, never the middle. */
export function redactToken(token: string): string {
  if (token.length <= 8) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 7)}…${token.slice(-4)}`;
}
