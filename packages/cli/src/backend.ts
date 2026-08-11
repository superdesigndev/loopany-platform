/**
 * The BACKEND seam — the one interface the CLI verbs read/write through, so the
 * SAME verb code drives either the local `.loopany/` file driver OR a remote
 * loopany server (§9's "the replaceable thing is WHERE authority lives"). The M6
 * conformance double-run is exactly this: one golden command script, two
 * backends, identical projections.
 *
 * A backend does four things — every verb is one of these:
 *   command(cmd, actor, now, opts) -> CommandResult   (the write chokepoint)
 *   tick(now)                      -> TickResultReport (the host clock)
 *   snapshot()                     -> Snapshot         (reads: show/list/…)
 *   events(objectId)               -> KernelEvent[]    (the --log rung)
 *
 * LOCAL runs the kernel in-process against the file driver. REMOTE POSTs the raw
 * Command to the server, which runs the SAME kernel at the authority (so the two
 * can't drift) — with ONE deliberate exception: `--dry-run` prevalidates LOCALLY
 * (fetch the remote snapshot, `decide` here, never POST), per §10's "local kernel
 * used for --dry-run prevalidation only". Offline / HTTP failure is FAIL LOUD
 * (a thrown DriverError), never a silent local fallback — §11's "离线 fail loud".
 */
import {
  timelineView,
  type TimelineItem,
  type TimelineOptions,
  type Command,
  type KernelEvent,
  type Provenance,
  type Snapshot,
} from "@loopany/kernel";
import {
  type CommandResult,
  type TickResultReport,
  DriverError,
  loadEvents,
  readConfig,
  readSnapshot,
  requireWorkspace,
  runCommand,
  runTick,
} from "./driver.js";
import { RemoteBackend, type SyncTransport } from "./remote.js";

export interface Backend {
  /** Human-facing label for errors/usage (e.g. "local" or the server origin). */
  readonly kind: "local" | "remote";
  command(
    command: Command,
    actor: Provenance,
    now: string,
    opts?: { dryRun?: boolean; guard?: (locked: Snapshot) => void },
  ): CommandResult;
  tick(now: string): TickResultReport;
  snapshot(): Snapshot;
  events(objectId: string): KernelEvent[];
  /** The team-timeline projection (kernel-team-timeline). Local computes over
   *  the file driver's streams; remote queries the BOUNDED server endpoint
   *  (never downloads every event to filter client-side). Same timelineView
   *  underneath, so the two backends cannot drift. */
  timeline(opts: TimelineOptions): TimelineItem[];
}

/** The local file-driver backend: the kernel runs in-process against `.loopany/`. */
class LocalBackend implements Backend {
  readonly kind = "local" as const;
  constructor(private readonly wsDir: string) {}
  command(
    command: Command,
    actor: Provenance,
    now: string,
    opts?: { dryRun?: boolean; guard?: (locked: Snapshot) => void },
  ): CommandResult {
    return runCommand(this.wsDir, command, actor, now, opts);
  }
  tick(now: string): TickResultReport {
    return runTick(this.wsDir, now);
  }
  snapshot(): Snapshot {
    return readSnapshot(this.wsDir);
  }
  events(objectId: string): KernelEvent[] {
    return loadEvents(this.wsDir, objectId);
  }
  timeline(opts: TimelineOptions): TimelineItem[] {
    const snapshot = readSnapshot(this.wsDir);
    const events = Object.keys(snapshot.objects).flatMap((id) => loadEvents(this.wsDir, id));
    return timelineView(snapshot, events, opts);
  }
}

/**
 * Select the backend from the workspace `config.json`. A `backend` of "local"
 * (or absent) drives the file driver; anything else is a server URL and drives
 * the remote HTTP backend. The device token comes from `LOOPANY_KERNEL_TOKEN`
 * (env wins) or the config's `token` field — a remote backend with no token is a
 * loud usage error (an unauthenticated POST would 401 anyway; fail before the
 * round-trip).
 */
export function selectBackend(
  cwd: string,
  env: Record<string, string | undefined>,
  transport?: SyncTransport,
): Backend {
  // In-run remote override (P0 stage E): a daemon-spawned agent works in the
  // TASK's workdir - an arbitrary project checkout with no .loopany stub - so
  // the backend rides entirely on env: LOOPANY_KERNEL_BACKEND (the server URL,
  // injected by the daemon alongside the rk_ LOOPANY_KERNEL_TOKEN). Explicit env
  // beats workspace discovery; a stray stub in the checkout cannot hijack the
  // run's authority.
  const envBackend = env.LOOPANY_KERNEL_BACKEND;
  if (envBackend && /^https?:\/\//.test(envBackend)) {
    const token = env.LOOPANY_KERNEL_TOKEN;
    if (!token) {
      throw new DriverError("NO_CREDENTIAL", "LOOPANY_KERNEL_BACKEND is set but LOOPANY_KERNEL_TOKEN is not", {
        hint: "the daemon injects both; set LOOPANY_KERNEL_TOKEN or unset LOOPANY_KERNEL_BACKEND",
      });
    }
    return transport ? new RemoteBackend(envBackend, token, transport) : new RemoteBackend(envBackend, token);
  }
  const wsDir = requireWorkspace(cwd);
  const config = readConfig(wsDir);
  if (config.backend === "local") return new LocalBackend(wsDir);
  const token = env.LOOPANY_KERNEL_TOKEN ?? config.token;
  if (!token) {
    throw new DriverError(
      "NO_CREDENTIAL",
      `backend "${config.backend}" needs a device token`,
      { hint: "set LOOPANY_KERNEL_TOKEN, or add a `token` to .loopany/config.json" },
    );
  }
  return transport
    ? new RemoteBackend(config.backend, token, transport)
    : new RemoteBackend(config.backend, token);
}
