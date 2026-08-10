/**
 * Daemon pidfile — the local liveness/identity record `loopany status` and
 * `loopany down` need to find THIS machine's detached daemon.
 *
 * `up` spawns the daemon detached (it outlives the launching session) and relies
 * on the server's `/api/machine/status` for online-ness, but that says nothing
 * about the LOCAL process — you can't `down` a pid the server never sees. So the
 * daemon itself writes its pid here on boot (`daemon.pid` under the same
 * `~/.loopany` state dir as the device token / server URL) and removes it on a
 * clean exit. `status`/`down` read it back and probe the pid with signal 0.
 *
 * All writes are best-effort: a missing/unwritable pidfile degrades `status` to
 * "can't tell locally" and `down` to a clean no-op — never a crash.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { LOOPANY_DIR } from "./config.js";

export const PID_FILE = path.join(LOOPANY_DIR, "daemon.pid");

/** A pidfile record: the daemon's pid plus a best-effort identity marker. */
export type PidRecord = { pid: number; startTime?: string };

/** Deterministic environment for the cross-platform `ps lstart` identity. */
export function processStartTimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, TZ: "UTC", LC_ALL: "C" };
}

/**
 * Best-effort process start time, used as a second identity field so a REUSED
 * pid (after an unclean crash left the pidfile behind) can't be mistaken for our
 * daemon. `ps -p <pid> -o lstart=` prints the process's start timestamp on both
 * macOS and Linux. Its output depends on the caller's timezone and locale, so
 * force UTC + the C locale: `up` may run outside an agent sandbox while a later
 * `status` runs inside one, and the same process must still compare byte-for-byte.
 * Returns undefined when `ps` is unavailable, the pid is gone, or anything else
 * fails — callers degrade to alive-only.
 */
export function processStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: processStartTimeEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Record the running daemon's pid + start-time identity (best-effort, 0600). */
export function writePidFile(pid: number = process.pid): void {
  try {
    fs.mkdirSync(LOOPANY_DIR, { recursive: true });
    const startTime = processStartTime(pid);
    const body = startTime ? `${pid}:${startTime}` : `${pid}`;
    fs.writeFileSync(PID_FILE, `${body}\n`, { mode: 0o600 });
  } catch {
    /* best-effort — status/down just won't see a local pid */
  }
}

/**
 * The pid + start-time recorded in the pidfile, or undefined if absent/garbage.
 * Back-compat: an old bare-`<pid>` file parses with `startTime` undefined.
 */
export function readPidFile(): PidRecord | undefined {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const sep = raw.indexOf(":");
    const pidPart = sep === -1 ? raw : raw.slice(0, sep);
    const startTime = sep === -1 ? undefined : raw.slice(sep + 1).trim() || undefined;
    const pid = Number(pidPart);
    return Number.isInteger(pid) && pid > 0 ? { pid, startTime } : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the pidfile (on clean daemon exit, or when found stale). When
 *  `onlyIfPid` is given, remove it ONLY if it still records that pid — a daemon
 *  exiting must never delete a pidfile another daemon has since claimed. */
export function clearPidFile(onlyIfPid?: number): void {
  try {
    if (onlyIfPid !== undefined && readPidFile()?.pid !== onlyIfPid) return;
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    /* best-effort */
  }
}

export type AliveProbeDeps = {
  signal?: (pid: number) => void;
  procVisible?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
};

/**
 * Is a process with this pid alive? `kill(pid, 0)` probes without delivering a
 * signal: it normally throws ESRCH when no such process exists and EPERM when
 * the process exists but is owned by someone else.
 *
 * Some Linux agent sandboxes return ESRCH for a host process even though that
 * same process is visible through `/proc` and `ps`. In that case `/proc/<pid>`
 * is the authoritative fallback. The separately recorded start time still
 * protects callers from treating a reused pid as this daemon.
 */
export function isAlive(pid: number, injected: AliveProbeDeps = {}): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const signal = injected.signal ?? ((target: number) => process.kill(target, 0));
  const platform = injected.platform ?? process.platform;
  const procVisible = injected.procVisible ?? ((target: number) => fs.existsSync(`/proc/${target}/stat`));
  try {
    signal(pid);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return code === "ESRCH" && platform === "linux" && procVisible(pid);
  }
}

/** Injectable seams for verifiedRunningPid (control.ts and tests reuse them). */
export type PidCheckDeps = {
  readPid?: () => PidRecord | undefined;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
  clearPid?: () => void;
  /** Read-only callers set false: an uncertain probe may report "not running",
   *  but must not destroy the only handle to a live daemon. */
  clearStale?: boolean;
};

/**
 * The pid of a daemon that is ACTUALLY ours and alive, or undefined. A pid is
 * "our daemon" iff it is alive AND (no recorded start-time, or the live process's
 * start-time still equals the one we recorded) — so a pid REUSED by an unrelated
 * process after an unclean crash (which left the pidfile behind) is NOT mistaken
 * for the daemon and never signaled. A dead pid OR a start-time mismatch is
 * cleared by mutating lifecycle callers by default; read-only callers pass
 * `clearStale:false` so a best-effort probe cannot erase the only management
 * handle to a live daemon. When the start-time can't be read at check time we
 * degrade to alive-only (best-effort, never crash).
 */
export function verifiedRunningPid(deps: PidCheckDeps = {}): number | undefined {
  const readPid = deps.readPid ?? readPidFile;
  const alive = deps.alive ?? isAlive;
  const startTime = deps.startTime ?? processStartTime;
  const clearPid = deps.clearPid ?? clearPidFile;
  const rec = readPid();
  if (rec === undefined) return undefined;
  if (!alive(rec.pid)) {
    if (deps.clearStale !== false) clearPid();
    return undefined;
  }
  if (rec.startTime !== undefined) {
    const live = startTime(rec.pid);
    if (live !== undefined && live !== rec.startTime) {
      if (deps.clearStale !== false) clearPid();
      return undefined;
    }
  }
  return rec.pid;
}
