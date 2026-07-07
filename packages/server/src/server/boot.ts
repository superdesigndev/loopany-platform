/**
 * Server boot — idempotent one-time init of the in-process backend: apply
 * migrations, wire the machine gateway's dispatcher into the Scheduler, start
 * the Scheduler + an offline-sweep interval. Guarded on `globalThis` so it
 * survives dev HMR and runs at most once per process. Call `ensureServer()`
 * from any server-side entry (the standalone machine server / TanStack server
 * fns); the first call boots, the rest share the same instance.
 */
import { runMigrations, closeClient } from "../db/index.js";
import { logger } from "../logger.js";
import { MachineGateway, ONLINE_TTL_MS } from "../gateway/index.js";
import { gcIntervalMs } from "../env.js";
import { Scheduler, type Dispatcher } from "../scheduler/index.js";

interface Booted {
  scheduler: Scheduler;
  gateway: MachineGateway;
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
  await runMigrations();

  const abort = new AbortController();
  // Drain the runtime postgres pool on clean shutdown (main.ts aborts on
  // SIGINT/SIGTERM); no-op for the pglite tier.
  abort.signal.addEventListener("abort", () => void closeClient(), { once: true });
  // Break the scheduler↔gateway cycle: the scheduler holds a thin dispatcher
  // that delegates to the gateway (assigned before any tick can fire).
  let gateway: MachineGateway;
  const dispatcher: Dispatcher = { dispatch: () => gateway.dispatcher.dispatch() };
  const scheduler = new Scheduler(dispatcher);
  gateway = new MachineGateway(scheduler);

  await scheduler.start(abort.signal);

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

  logger.info("loopany server booted");
  return { scheduler, gateway, abort };
}

export async function getScheduler(): Promise<Scheduler> {
  return (await ensureServer()).scheduler;
}

export async function getGateway(): Promise<MachineGateway> {
  return (await ensureServer()).gateway;
}
