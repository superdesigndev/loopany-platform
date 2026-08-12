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
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  // ATOMIC per file (write-then-rename): a crash mid-write must never leave a
  // truncated credential. The PAIR is still two files (the daemon's on-disk
  // convention) - writeGlobalConnect orders token-before-server so any torn
  // pair fails LOUD at first use (an unknown token at the old server is a 401,
  // never a silently-working half-new binding).
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600); // an existing file keeps its old mode without this
}

// ---- live-daemon probe (read-only) ----

/** Injectable seams for {@link liveDaemonPid} (tests never need a real ps). */
export interface DaemonProbeDeps {
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pid of a LIVE daemon owning this credential home, or undefined. Reads the
 * daemon's own `daemon.pid` (`<pid>[:<ps lstart>]` - the format
 * packages/daemon/src/pidfile.ts writes; the real-process test exercises the
 * exact `ps -o lstart=` identity so the two implementations cannot drift
 * silently), verifies liveness AND the start-time identity so a REUSED pid
 * never blocks a connect. READ-ONLY by design: the daemon owns its pidfile
 * hygiene - the CLI never deletes another tool's state, even a stale file.
 */
export function liveDaemonPid(env: Env, deps: DaemonProbeDeps = {}): number | undefined {
  const raw = readText(join(credentialHome(env), "daemon.pid"));
  if (raw === undefined) return undefined;
  const sep = raw.indexOf(":");
  const pid = Number(sep === -1 ? raw : raw.slice(0, sep));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const recorded = sep === -1 ? undefined : raw.slice(sep + 1).trim() || undefined;
  if (!(deps.alive ?? processAlive)(pid)) return undefined;
  if (recorded !== undefined) {
    const live = (deps.startTime ?? processStartTime)(pid);
    if (live !== undefined && live !== recorded) return undefined; // reused pid
  }
  return pid;
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
  // TOKEN first, server last: a crash between the two leaves new-token +
  // old-server - unknown at that server, a loud 401 on first use. The reverse
  // order (new server + old token) is the same loud 401 shape, but writing the
  // secret first means the verify-passed pair is complete the instant the
  // server file lands.
  writeSecret(files.token, binding.token);
  writeSecret(files.server, binding.backend.replace(/\/+$/, ""));
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
