/**
 * `loopany status` and `loopany down` — the owner-outside-a-run commands that
 * inspect and stop THIS machine's detached daemon (the one `loopany up` started).
 *
 * Both are built on the local pidfile (`pidfile.ts`): the daemon records its pid
 * on boot, so `status` can say "running (pid N)" and `down` can signal it — no
 * round-trip to the server required. `status` ALSO reports what's locally
 * knowable about identity (the configured server URL, whether a device token is
 * stored) and, best-effort, the server's view (online + machine name) when both
 * a server and token are available. Nothing is fabricated: an unreachable server
 * or absent pidfile simply degrades to "unknown / can't tell locally".
 *
 * Every external touch (pidfile read, liveness probe, start-time lookup, kill,
 * server fetch, output) is an injectable seam so the tests need no real process
 * or network.
 */
import { DEVICE_FILE, readStored, resolveServerUrl } from "./config.js";
import { PID_FILE, readPidFile, clearPidFile, isAlive, processStartTime, type PidRecord } from "./pidfile.js";

type Online = { online: boolean; name: string | null };

/** Best-effort server view of this machine (same endpoint `loopany up` waits on). */
async function fetchOnlineDefault(server: string, token: string): Promise<Online | undefined> {
  try {
    const res = await fetch(`${server}/api/machine/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as Online;
  } catch {
    return undefined;
  }
}

export type ControlDeps = {
  readPid?: () => PidRecord | undefined;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
  clearPid?: () => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  fetchOnline?: (server: string, token: string) => Promise<Online | undefined>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  // The local config inputs `status` reports — overridable so tests are isolated
  // from the ambient ~/.loopany. Omitted ⇒ read from disk.
  server?: string;
  token?: string;
};

type Seams = Required<Omit<ControlDeps, "server" | "token">>;

function deps(d: ControlDeps): Seams {
  return {
    readPid: d.readPid ?? readPidFile,
    alive: d.alive ?? isAlive,
    startTime: d.startTime ?? processStartTime,
    clearPid: d.clearPid ?? clearPidFile,
    kill: d.kill ?? ((pid, signal) => process.kill(pid, signal)),
    fetchOnline: d.fetchOnline ?? fetchOnlineDefault,
    out: d.out ?? ((s) => process.stdout.write(s)),
    err: d.err ?? ((s) => process.stderr.write(s)),
  };
}

/**
 * The pid of a daemon that is ACTUALLY ours and alive, or undefined. A pid is
 * "our daemon" iff it is alive AND (no recorded start-time, or the live process's
 * start-time still equals the one we recorded) — so a pid REUSED by an unrelated
 * process after an unclean crash (which left the pidfile behind) is NOT mistaken
 * for the daemon and never signaled. A dead pid OR a start-time mismatch is
 * cleared as a side effect so we don't report a ghost and a fresh `up` isn't
 * confused by stale state. When the start-time can't be read at check time we
 * degrade to alive-only (best-effort, never crash).
 */
function runningPid(d: Seams): number | undefined {
  const rec = d.readPid();
  if (rec === undefined) return undefined;
  if (!d.alive(rec.pid)) {
    d.clearPid();
    return undefined;
  }
  if (rec.startTime !== undefined) {
    const live = d.startTime(rec.pid);
    if (live !== undefined && live !== rec.startTime) {
      d.clearPid();
      return undefined;
    }
  }
  return rec.pid;
}

/** Show a device token as a short non-secret fingerprint, never in full. */
function tokenFingerprint(token: string): string {
  return token.length <= 8 ? "stored" : `stored …${token.slice(-6)}`;
}

export async function runStatus(args: string[], injected: ControlDeps = {}): Promise<number> {
  const d = deps(injected);
  const server = "server" in injected ? (injected.server ?? "") : resolveServerUrl(undefined);
  const token = "token" in injected ? injected.token : readStored(DEVICE_FILE);
  const pid = runningPid(d);

  d.out("loopany status:\n");
  d.out(
    pid !== undefined
      ? `  daemon:    running (pid ${pid})\n`
      : "  daemon:    not running — run `loopany up` to start it\n",
  );
  d.out(`  server:    ${server || "not configured — run `loopany up --server-url <url>`"}\n`);
  d.out(`  identity:  ${token ? tokenFingerprint(token) : "no device token — run `loopany up`"}\n`);
  d.out(`  pidfile:   ${PID_FILE}\n`);

  // Best-effort: only the server can say whether this machine is currently
  // CONNECTED (the local pid being alive doesn't prove the poll loop is healthy).
  if (server && token) {
    const view = await d.fetchOnline(server, token);
    if (view) {
      d.out(`  connection: ${view.online ? "online" : "offline"}${view.name ? ` (${view.name})` : ""}\n`);
    } else {
      d.out("  connection: unknown — server unreachable\n");
    }
  }
  return 0;
}

export async function runDown(args: string[], injected: ControlDeps = {}): Promise<number> {
  const d = deps(injected);
  const pid = runningPid(d);

  if (pid === undefined) {
    d.out("no daemon running for this machine\n");
    return 0;
  }

  try {
    d.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      // Raced: the daemon exited between the liveness probe and the signal.
      d.clearPid();
      d.out("no daemon running for this machine\n");
      return 0;
    }
    d.err(`loopany: could not stop daemon (pid ${pid}): ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // The daemon clears its own pidfile on clean exit; clear it here too so an
  // immediate `status` is correct even before the daemon's SIGTERM handler lands.
  d.clearPid();
  d.out(`stopped daemon (pid ${pid})\n`);
  return 0;
}
