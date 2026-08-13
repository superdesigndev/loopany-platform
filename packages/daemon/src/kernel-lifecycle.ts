/**
 * KERNEL RUN LIFECYCLE - the ONE owner of "receive kernel deliveries and see
 * them through" (kernel-real-daemon-simulator). Two consumers, zero drift:
 *
 *   - the production daemon loop (daemon.ts): its poll response's `kernelRuns`
 *     go through {@link KernelLifecycle.dispatch} - dedup against the SHARED
 *     inFlight set, background execution via the production
 *     {@link runKernelDelivery} (spawn, one retry, session extraction, the
 *     finish retry ladder), bookkeeping on settle;
 *   - the SIMULATOR's remote driver: {@link KernelLifecycle.pollOnce} builds
 *     the SAME poll body (buildPollBody - `kernelInFlight` always present, so
 *     the server's orphan reconcile sees real reports) and feeds the same
 *     dispatch, then {@link KernelLifecycle.settle} awaits the executions a
 *     synchronous scenario tick needs settled.
 *
 * A second protocol implementation (the old remote-pump) is exactly how a
 * simulation passes on behavior production never executes - this module is the
 * anti-drift chokepoint. Seams: `fetchImpl` (tests/driver), `runDeps`
 * (forwarded to runKernelDelivery), `inFlight` (the daemon passes its own
 * unified set; the driver lets the lifecycle own one).
 */
import { boundedFetch } from "./http.js";
import { machineHeaders } from "./config.js";
import { logger } from "./logger.js";
import { runKernelDelivery, type KernelRunDelivery, type KernelRunDeps } from "./kernel-run.js";

const POLL_TIMEOUT_MS = 30_000;

/** Poll request body: machine identity + optional progress + long-poll opt-in
 *  (idle only — with a run in flight the short cadence keeps the progress
 *  heartbeat fresh) + the last watch digest echo (absent until a server sent
 *  one) + `kernelInFlight`: the runIds this host is executing, ALWAYS present
 *  (even empty) so the server's orphan reconcile can tell "executing nothing"
 *  from "old daemon that never reports". Lives HERE (the lifecycle leaf) so the
 *  daemon loop and the simulator driver share ONE body shape - re-exported by
 *  daemon.ts for compatibility. */
export function buildPollBody(
  info: Record<string, unknown>,
  progress: Array<{ runId: string; step: number; label: string }>,
  idle: boolean,
  watchDigest: string | undefined,
  kernelInFlight: string[] = [],
): Record<string, unknown> {
  return {
    ...info,
    ...(progress.length ? { progress } : {}),
    ...(idle ? { wait: true } : {}),
    ...(watchDigest ? { watchDigest } : {}),
    kernelInFlight,
  };
}

export interface KernelLifecycleOpts {
  server: string;
  token: string;
  /** Poll identity fields (host, alias, ...). */
  info: Record<string, unknown>;
  /** The local LOOPANY_ROOTS jail (same rule as production runs). */
  roots?: string[];
  signal?: AbortSignal;
  /** The daemon passes its own unified in-flight set (production + kernel runs
   *  share one); absent = the lifecycle owns a fresh one (the driver). */
  inFlight?: Set<string>;
  /** Forwarded to runKernelDelivery (spawn/finish/fs seams). */
  runDeps?: KernelRunDeps;
  fetchImpl?: typeof boundedFetch;
}

export class KernelLifecycle {
  readonly inFlight: Set<string>;
  private readonly executions = new Map<string, Promise<void>>();

  constructor(private readonly opts: KernelLifecycleOpts) {
    this.inFlight = opts.inFlight ?? new Set();
  }

  /** Dispatch delivered kernel runs EXACTLY like the daemon loop: in-flight
   *  dedup, background execution through the production runKernelDelivery,
   *  bookkeeping cleared on settle. Never throws (a failed execution logs and
   *  settles; the kernel's re-arm policy owns what happens next). */
  dispatch(kernelRuns: readonly KernelRunDelivery[] | undefined): void {
    for (const kr of kernelRuns ?? []) {
      if (this.inFlight.has(kr.runId)) continue;
      this.inFlight.add(kr.runId);
      logger.info({ runId: kr.runId, taskId: kr.taskId, agent: kr.agent }, "kernel run delivered — running");
      const exec = runKernelDelivery(kr, this.opts.server, this.opts.roots ?? [], this.opts.signal, this.opts.runDeps)
        .then(() => logger.info({ runId: kr.runId }, "kernel run finished"))
        .catch((err) =>
          logger.error({ runId: kr.runId, err: err instanceof Error ? err.message : String(err) }, "kernel run failed"),
        )
        .finally(() => {
          this.inFlight.delete(kr.runId);
          this.executions.delete(kr.runId);
        });
      this.executions.set(kr.runId, exec);
    }
  }

  /** One kernel poll with the PRODUCTION body shape (`kernelInFlight` always
   *  present - the orphan reconcile must see real reports, never `[]` lies),
   *  dispatching whatever was delivered. Returns the delivered count. */
  async pollOnce(): Promise<number> {
    const fetchImpl = this.opts.fetchImpl ?? boundedFetch;
    const body = buildPollBody(this.opts.info, [], false, undefined, [...this.inFlight]);
    const res = await fetchImpl(
      `${this.opts.server}/api/machine/poll`,
      {
        method: "POST",
        headers: machineHeaders(this.opts.token, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
      POLL_TIMEOUT_MS,
      this.opts.signal,
    );
    if (!res.ok) throw new Error(`kernel poll -> HTTP ${res.status}`);
    const data = (await res.json()) as { kernelRuns?: KernelRunDelivery[] };
    const delivered = data.kernelRuns?.length ?? 0;
    this.dispatch(data.kernelRuns);
    return delivered;
  }

  /** Await every in-flight execution (the driver's per-tick barrier). */
  async settle(): Promise<void> {
    while (this.executions.size > 0) {
      await Promise.allSettled([...this.executions.values()]);
    }
  }

  /** Drive polls until a round delivers nothing AND everything settled - a
   *  run's own writes may mint follow-on runs (reassign cascades), so one
   *  poll is not enough. Bounded (a runaway cascade must not hang a tick). */
  async pumpUntilDry(maxRounds = 8): Promise<{ delivered: number; rounds: number }> {
    let total = 0;
    for (let round = 1; round <= maxRounds; round++) {
      const delivered = await this.pollOnce();
      await this.settle();
      total += delivered;
      if (delivered === 0) return { delivered: total, rounds: round };
    }
    logger.warn({ maxRounds }, "kernel pump: round cap hit with deliveries still flowing");
    return { delivered: total, rounds: maxRounds };
  }
}
