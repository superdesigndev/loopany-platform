/**
 * Server boot — idempotent one-time init of the in-process backend: apply
 * migrations, wire the machine gateway's dispatcher into the Scheduler, start
 * the Scheduler + an offline-sweep interval. Guarded on `globalThis` so it
 * survives dev HMR and runs at most once per process. Call `ensureServer()`
 * from any server-side entry (the standalone machine server / TanStack server
 * fns); the first call boots, the rest share the same instance.
 */
import { sql } from "drizzle-orm";

import { runMigrations, closeClient, db } from "../db/index.js";
import { logger } from "../logger.js";
import { MachineGateway, ONLINE_TTL_MS } from "../gateway/index.js";
import { CliGateway } from "../gateway/cli.js";
import { createBlobStore, type BlobStore } from "../gateway/blobstore.js";
import {
  gcIntervalMs,
  dbWatchdogEnabled,
  dbWatchdogIntervalMs,
  dbWatchdogTimeoutMs,
  dbWatchdogFailureThreshold,
} from "../env.js";
import { Scheduler, type Dispatcher } from "../scheduler/index.js";
import { DueTaskScheduler, setProductionRunDispatcher } from "../kernel/runQueue.js";
import { startDbWatchdog } from "./dbWatchdog.js";

interface Booted {
  scheduler: Scheduler;
  dueTaskScheduler: DueTaskScheduler;
  gateway: MachineGateway;
  blobStore: BlobStore;
  cliGateway: CliGateway;
  abort: AbortController;
}

// Cache the in-flight boot PROMISE (not the resolved value): async migrations +
// scheduler.start mean two concurrent first-requests would otherwise each run
// `boot()` → double scheduler → double-fire every run. Assigning the promise
// synchronously (before the first await) makes concurrent callers share it.
const g = globalThis as unknown as { __loopanyBooted?: Promise<Booted> };

export function ensureServer(): Promise<Booted> {
  if (g.__loopanyBooted) return g.__loopanyBooted;
  const p = boot();
  g.__loopanyBooted = p;
  // If boot fails, clear the cache so a later call can retry (mirrors the old
  // sync behavior where a throw left `__loopanyBooted` unset).
  p.catch(() => {
    if (g.__loopanyBooted === p) g.__loopanyBooted = undefined;
  });
  return p;
}

async function boot(): Promise<Booted> {
  // Migration `0010` disposes of any run row the retired kernel queue still
  // owned (S3.1's boot pass moved INTO the migration when its columns went), so
  // by the time anything below runs there is one run world and one sweep.
  await runMigrations();

  const abort = new AbortController();
  // Drain the runtime postgres pool on clean shutdown (main.ts aborts on
  // SIGINT/SIGTERM); no-op for the pglite tier.
  abort.signal.addEventListener("abort", () => void closeClient(), { once: true });
  // Break the scheduler↔gateway cycle: the scheduler holds a thin dispatcher
  // that delegates to the gateway (assigned before any tick can fire).
  let gateway: MachineGateway;
  const dispatcher: Dispatcher = { dispatch: (loop) => gateway.dispatcher.dispatch(loop) };
  const scheduler = new Scheduler(dispatcher);
  // ONE blob store, shared: the artifact READERS resolve bytes through it
  // (`getBlobStore`) and the gateway's `maintainStorage` reclaims them. Byte
  // ingress retired with the folder watcher, so nothing else writes to it.
  const blobStore = createBlobStore();
  gateway = new MachineGateway(scheduler, blobStore);
  setProductionRunDispatcher((loop) => gateway.dispatcher.dispatch(loop));
  // CLI verb dispatch (unified /api/machine/cli + legacy /agent-api/loop) over
  // the same core gateway instance.
  const cliGateway = new CliGateway(gateway);

  await scheduler.start(abort.signal);
  // Task follow-ups remain kernel facts after loop convergence, and nothing in
  // the production scheduler knows about them, so their scan is always live.
  const dueTaskScheduler = new DueTaskScheduler();
  await dueTaskScheduler.start(abort.signal);

  // sweep() is async now: a rejected promise off a bare timer callback is an
  // unhandled rejection (Node can terminate). Catch it so a transient sweep error
  // just logs and the interval keeps ticking.
  const sweep = setInterval(
    () => void gateway.sweep().catch((err) => logger.error({ err: String(err) }, "sweep tick failed")),
    ONLINE_TTL_MS,
  );
  sweep.unref?.();
  abort.signal.addEventListener("abort", () => clearInterval(sweep), { once: true });

  // Storage maintenance (prune snapshots → GC unreferenced blob bytes) on its own
  // slower cadence — keeps R2 from growing monotonically. Async + best-effort, so a
  // slow R2 delete can't block the loop; catch the promise (same unhandled-rejection
  // guard as sweep — the method is not supposed to throw, but a timer must never let
  // one escape).
  const gc = setInterval(
    () => void gateway.maintainStorage().catch((err) => logger.error({ err: String(err) }, "gc tick failed")),
    gcIntervalMs(),
  );
  gc.unref?.();
  abort.signal.addEventListener("abort", () => clearInterval(gc), { once: true });

  // DB watchdog — the ACTUAL auto-recovery backstop for a wedged postgres pool
  // (Fly's failing health check only de-routes; it never restarts the VM). Pings
  // `select 1` under a hard deadline and exits after a sustained wedge so Fly's
  // on-failure restart brings up a fresh pool. Hosted-postgres tier only; see
  // env.ts `dbWatchdogEnabled` + server/dbWatchdog.ts for the full rationale.
  if (dbWatchdogEnabled()) {
    const intervalMs = dbWatchdogIntervalMs();
    const timeoutMs = dbWatchdogTimeoutMs();
    const failureThreshold = dbWatchdogFailureThreshold();
    logger.info({ intervalMs, timeoutMs, failureThreshold }, "db watchdog: armed");
    const stopWatchdog = startDbWatchdog({
      probe: () => db.execute(sql`select 1`),
      exit: (code) => process.exit(code),
      intervalMs,
      timeoutMs,
      failureThreshold,
    });
    abort.signal.addEventListener("abort", () => stopWatchdog(), { once: true });
  }

  logger.info("loopany server booted");
  return { scheduler, dueTaskScheduler, gateway, blobStore, cliGateway, abort };
}

export async function getGateway(): Promise<MachineGateway> {
  return (await ensureServer()).gateway;
}

/** The process's ONE artifact blob byte store. Read-only in practice: byte ingress
 *  retired with the folder watcher, so the only writer left is the GC's delete. */
export async function getBlobStore(): Promise<BlobStore> {
  return (await ensureServer()).blobStore;
}

export async function getCliGateway(): Promise<CliGateway> {
  return (await ensureServer()).cliGateway;
}
