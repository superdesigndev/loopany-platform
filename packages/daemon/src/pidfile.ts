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

/**
 * Best-effort process start time, used as a second identity field so a REUSED
 * pid (after an unclean crash left the pidfile behind) can't be mistaken for our
 * daemon. `ps -p <pid> -o lstart=` prints the process's start timestamp on both
 * macOS and Linux; one shared helper is used at write-time AND check-time so the
 * two strings compare byte-for-byte. Returns undefined when `ps` is unavailable,
 * the pid is gone, or anything else fails — callers degrade to alive-only.
 */
export function processStartTime(pid: number): string | undefined {
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

/** Remove the pidfile (on clean daemon exit, or when found stale). */
export function clearPidFile(): void {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Is a process with this pid alive? `kill(pid, 0)` probes without delivering a
 * signal: it throws ESRCH when no such process exists, EPERM when the process
 * exists but is owned by someone else (still alive, so treat as running).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
