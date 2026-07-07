/**
 * Server boot — idempotent one-time init of the in-process backend: apply
 * migrations, wire the machine gateway's dispatcher into the Scheduler, start
 * the Scheduler + an offline-sweep interval. Guarded on `globalThis` so it
 * survives dev HMR and runs at most once per process. Call `ensureServer()`
 * from any server-side entry (the standalone machine server / TanStack server
 * fns); the first call boots, the rest share the same instance.
 */
import { runMigrations } from "../db/index.js";
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
  // Break the scheduler↔gateway cycle: the scheduler holds a thin dispatcher
  // that delegates to the gateway (assigned before any tick can fire).
  let gateway: MachineGateway;
  const dispatcher: Dispatcher = { dispatch: () => gateway.dispatcher.dispatch() };
  const scheduler = new Scheduler(dispatcher);
  gateway = new MachineGateway(scheduler);

  await scheduler.start(abort.signal);

  const sweep = setInterval(() => gateway.sweep(), ONLINE_TTL_MS);
  sweep.unref?.();
  abort.signal.addEventListener("abort", () => clearInterval(sweep), { once: true });

  // Storage maintenance (prune snapshots → GC unreferenced blob bytes) on its own
  // slower cadence — keeps R2 from growing monotonically. Async + best-effort, so a
  // slow R2 delete can't block the loop; void the promise (the method never throws).
  const gc = setInterval(() => void gateway.maintainStorage(), gcIntervalMs());
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
