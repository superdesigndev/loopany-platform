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
import { boundedFetch } from "./http.js";
import { PID_FILE, readPidFile, clearPidFile, isAlive, processStartTime, verifiedRunningPid, type PidRecord } from "./pidfile.js";

export type MachineStatus = { online: boolean; name: string | null };

/** Best-effort server view of this machine (`/api/machine/status`) — shared by
 *  `status`'s connection line and `loopany up`'s readiness probe. Bounded (3s)
 *  and swallow-all: an unreachable/hung server degrades to undefined, never a
 *  crash or a long stall. */
export async function fetchMachineStatus(server: string, token: string): Promise<MachineStatus | undefined> {
  try {
    const res = await boundedFetch(
      `${server}/api/machine/status`,
      { headers: { Authorization: `Bearer ${token}` } },
      3000,
    );
    if (!res.ok) return undefined;
    return (await res.json()) as MachineStatus;
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
  fetchOnline?: (server: string, token: string) => Promise<MachineStatus | undefined>;
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
    fetchOnline: d.fetchOnline ?? fetchMachineStatus,
    out: d.out ?? ((s) => process.stdout.write(s)),
    err: d.err ?? ((s) => process.stderr.write(s)),
  };
}

/** Show a device token as a short non-secret fingerprint, never in full. */
function tokenFingerprint(token: string): string {
  return token.length <= 8 ? "stored" : `stored …${token.slice(-6)}`;
}

export async function runStatus(args: string[], injected: ControlDeps = {}): Promise<number> {
  const d = deps(injected);
  const server = "server" in injected ? (injected.server ?? "") : resolveServerUrl(undefined);
  const token = "token" in injected ? injected.token : readStored(DEVICE_FILE);
  // The shared pidfile.verifiedRunningPid check (reused-pid safe), fed our seams.
  // `status` is read-only. A sandbox may have an incomplete process view, so an
  // uncertain/stale result may be reported but must never erase the pidfile.
  const pid = verifiedRunningPid({ ...d, clearStale: false });

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
  const pid = verifiedRunningPid(d);

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
