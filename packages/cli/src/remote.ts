/**
 * The REMOTE backend — a THIN HTTP client that forwards a kernel Command (never a
 * Changeset) to a loopany server's POST /api/kernel/cli, which runs the SAME
 * `@loopany/kernel` at the authority (§9). The server decides + persists; this
 * client only serializes the request, renders the ONE response envelope, and
 * translates a Refusal/ApplyConflict back into the SAME `DriverError` the local
 * driver raises — so the verb layer above cannot tell the two backends apart.
 *
 * `--dry-run` is the one thing that runs LOCALLY (§10): fetch the remote snapshot,
 * `decide` in-process, and return the decision WITHOUT posting — a validate-only
 * preview that never mutates the server.
 *
 * FAIL LOUD (§11 "离线 fail loud"): a network error, a non-JSON response, or an
 * unexpected status is a thrown DriverError with a clear code — never a silent
 * degrade to a local write (which would fork authority).
 *
 * SYNC over an ASYNC transport: the whole CLI verb layer is synchronous, but the
 * request is I/O. The `transport` seam is a SYNCHRONOUS `(request) -> response`
 * function; the default (`syncHttpTransport`) blocks on the network by running
 * the request in a child `node` process (`spawnSync`) — one subprocess per verb,
 * which is fine for a CLI (never a hot path) and keeps the verb layer, its 28
 * synchronous tests, and the local driver untouched. Tests/harness inject an
 * in-process transport instead.
 */
import {
  type TimelineItem,
  type TimelineOptions,
  type Command,
  type KernelEvent,
  type Provenance,
  type Snapshot,
  decide,
} from "@loopany/kernel";
import { spawnSync } from "node:child_process";
import type { Backend } from "./backend.js";
import { type CommandResult, type TickResultReport, DriverError } from "./driver.js";

/** The response envelope POST /api/kernel/cli returns (server `KernelCliResponse`).
 *  Kept in sync structurally; unknown fields are ignored. */
export interface KernelCliResponse {
  ok: boolean;
  refusal?: { code: string; message: string; issues?: string[]; hint?: string };
  conflict?: { kind: string; id: string; message: string };
  notices?: string[];
  result?: { id: string; existing?: boolean };
  snapshot?: Snapshot;
  events?: Record<string, KernelEvent[]>;
  applied?: number;
  timeline?: TimelineItem[];
  machinePresence?: Record<string, string>;
}

/** A synchronous HTTP transport: given a URL/token/body, return the parsed
 *  response (or throw a DriverError on any transport/decode failure). The default
 *  blocks via a child process; the conformance harness injects an in-process one. */
export interface SyncTransport {
  (url: string, token: string, body: unknown): { status: number; response: KernelCliResponse };
}

export class RemoteBackend implements Backend {
  readonly kind = "remote" as const;
  private readonly url: string;

  constructor(
    serverUrl: string,
    private readonly token: string,
    private readonly transport: SyncTransport = syncHttpTransport,
    /** The SIMULATOR time-authority capability (LOOPANY_KERNEL_SIM_AUTHORITY):
     *  presented on every request so a virtual `now` is honored at the
     *  authority. Absent in every normal use - see the server's
     *  kernel-authority-clock-seam invariant. */
    private readonly simAuthority?: string,
  ) {
    // POST target: <serverUrl>/api/kernel/cli. Tolerate a trailing slash.
    this.url = `${serverUrl.replace(/\/+$/, "")}/api/kernel/cli`;
  }

  command(
    command: Command,
    actor: Provenance,
    now: string,
    opts?: { dryRun?: boolean; guard?: (locked: Snapshot) => void },
  ): CommandResult {
    // --dry-run is validate-only and runs LOCALLY against the fetched snapshot
    // (§10): never POST, never mutate the server. The guard (doc-put's TOCTOU
    // wipe-protection) runs against that same snapshot, matching the local path.
    if (opts?.dryRun) {
      const before = this.snapshot();
      if (opts.guard) opts.guard(before);
      const decision = decide(command, before, actor, now);
      if (!decision.ok) throw refusalError(decision.refusal);
      return { snapshot: before, notices: decision.notices, result: decision.result };
    }
    // A live write: the guard is a pre-POST existence check against the current
    // remote snapshot — a fast, friendly reject, NOT the authority precondition.
    // The pre-POST snapshot is racy (there is no client-held lock at the server),
    // so the "don't wipe an existing doc" protection is really enforced at the
    // AUTHORITY: the create-only `doc put` path carries `ifVersion: 0` (see cli.ts
    // verbDoc), which the server's decideDocPut refuses with CONFLICT if the doc
    // was created under the race window. The guard here just avoids a round-trip
    // when the doc is already visible.
    if (opts?.guard) opts.guard(this.snapshot());
    const res = this.send({ command, now, provenance: actor });
    return { snapshot: EMPTY_SNAPSHOT, notices: res.notices ?? [], result: res.result };
  }

  tick(now: string): TickResultReport {
    const res = this.send({ tick: true, now });
    return { notices: res.notices ?? [], applied: res.applied ?? 0, snapshot: EMPTY_SNAPSHOT };
  }

  snapshot(): Snapshot {
    const res = this.send({ read: true });
    if (!res.snapshot) throw new DriverError("REMOTE_ERROR", "server read returned no snapshot");
    // Cache the streams so a following events(id) in the same command reuses one
    // round-trip (show --log reads snapshot() then events()).
    this.lastEvents = res.events ?? {};
    this.lastPresence = res.machinePresence ?? {};
    return res.snapshot;
  }

  private lastPresence: Record<string, string> = {};
  machinePresence(): Readonly<Record<string, string>> {
    return this.lastPresence;
  }

  timeline(opts: TimelineOptions): TimelineItem[] {
    // The BOUNDED server endpoint runs the same timelineView at the authority -
    // never download every team event to filter client-side.
    const res = this.send({ timeline: opts });
    return res.timeline ?? [];
  }

  private lastEvents: Record<string, KernelEvent[]> | null = null;
  events(objectId: string): KernelEvent[] {
    if (this.lastEvents) return this.lastEvents[objectId] ?? [];
    const res = this.send({ read: true });
    return (res.events ?? {})[objectId] ?? [];
  }

  /** POST the envelope, translate a Refusal/ApplyConflict to a DriverError, and
   *  return the ok response. FAIL LOUD on any transport/status failure. */
  private send(body: Record<string, unknown>): KernelCliResponse {
    const withAuthority = this.simAuthority ? { ...body, simAuthority: this.simAuthority } : body;
    const { status, response } = this.transport(this.url, this.token, withAuthority);
    if (response.refusal) throw refusalError(response.refusal);
    if (response.conflict) throw conflictError(response.conflict);
    if (status !== 200 || !response.ok) {
      throw new DriverError(
        "REMOTE_ERROR",
        `server returned HTTP ${status}`,
        { hint: "the loopany server rejected the request" },
      );
    }
    return response;
  }
}

// A structural empty snapshot for write/tick returns (the render path reads only
// notices/result/applied, never the snapshot, on those paths).
const EMPTY_SNAPSHOT: Snapshot = { objects: {}, triggers: [], runs: [] };

function refusalError(r: { code: string; message: string; issues?: string[]; hint?: string }): DriverError {
  return new DriverError(r.code, r.message, { issues: r.issues, hint: r.hint });
}

function conflictError(c: { kind: string; id: string; message: string }): DriverError {
  return new DriverError("CONFLICT", `${c.message} (${c.kind} ${c.id})`, {
    hint: "the workspace changed under this command — re-read and retry",
  });
}

/**
 * The default synchronous transport: block on the network by running the fetch in
 * a child `node` process. A CLI verb is never a hot path, so one subprocess per
 * request is an acceptable price for keeping the verb layer synchronous. The child
 * prints a single JSON line `{status, body}` on success or `{error}` on a
 * transport failure; anything else (a crash, a timeout) is a loud DriverError.
 */
export const syncHttpTransport: SyncTransport = (url, token, body) => {
  const script = `
    const url = process.env.__U, token = process.env.__T;
    const payload = process.env.__B;
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: payload,
    })
      .then(async (r) => {
        const text = await r.text();
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
        process.stdout.write(JSON.stringify({ status: r.status, body: parsed }));
      })
      .catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) })); });
  `;
  const out = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, __U: url, __T: token, __B: JSON.stringify(body) },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (out.error) {
    throw new DriverError("OFFLINE", `cannot reach ${url}: ${out.error.message}`, {
      hint: "the loopany server is unreachable — check --backend and the network",
    });
  }
  if (out.status !== 0) {
    throw new DriverError("OFFLINE", `request to ${url} failed (exit ${out.status})`, {
      hint: "the loopany server is unreachable — check --backend and the network",
    });
  }
  let decoded: { status?: number; body?: KernelCliResponse; error?: string };
  try {
    decoded = JSON.parse(out.stdout) as typeof decoded;
  } catch {
    throw new DriverError("REMOTE_ERROR", `server response was not JSON`, {
      hint: `raw: ${out.stdout.slice(0, 200)}`,
    });
  }
  if (decoded.error) {
    throw new DriverError("OFFLINE", `cannot reach ${url}: ${decoded.error}`, {
      hint: "the loopany server is unreachable — check --backend and the network",
    });
  }
  if (!decoded.body) {
    throw new DriverError("REMOTE_ERROR", "server returned an empty body");
  }
  return { status: decoded.status ?? 0, response: decoded.body };
};
