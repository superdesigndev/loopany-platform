/**
 * Scheduler — the in-process cron engine (croner) + a one-shot `nextRunAt` timer
 * per loop. Boots once (Nitro plugin) and runs until the abort signal fires.
 *
 * P0 scope: a tick creates a *pending* run and hands it to a `Dispatcher` (the
 * machine WS gateway in P1). The server itself executes nothing — no workflow
 * JS, no claude. If the bound machine isn't reachable, the run is recorded as an
 * error ("machine offline") and the next cron tick retries (best-effort, no
 * inbox/catch-up). Overlapping ticks for a loop with an open run are skipped.
 *
 * Evolution and timeout-reclaim land in later phases; the run
 * lifecycle (pending → running → done/error) and the Dispatcher seam are shaped
 * to absorb them without reshaping the engine.
 */
import { Cron } from "croner";

import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { Loop, Run } from "../db/schema.js";

const log = logger.child({ mod: "scheduler" });

const MAX_TIMER_MS = 2_147_483_647; // setTimeout ceiling
const EVOLVE_EVERY = Number(process.env.LOOPANY_EVOLVE_EVERY || 3);
const EVOLVE_DELAY_MS = Number(process.env.LOOPANY_EVOLVE_DELAY_MS || 5_000);
/** Hard ceiling on AUTO evolution cadence: at most once per this window, however
 *  fast the loop runs (a 1-min loop won't evolve hundreds of times/day). */
const EVOLVE_MIN_INTERVAL_MS = Number(process.env.LOOPANY_EVOLVE_MIN_INTERVAL_MS || 24 * 3_600_000);

/**
 * Best-effort notify that a run is pending for the loop's machine. Transport-
 * agnostic: the short-poll gateway no-ops (the pending run IS the queue; the
 * daemon's poll claims it); a future WS gateway would push. The engine never
 * decides "offline" — a pending run that no machine ever claims is reclaimed as
 * an error by the gateway's sweep. Throwing marks this run errored.
 */
export interface Dispatcher {
  dispatch(loop: Loop, run: Run): Promise<void> | void;
}

export class Scheduler {
  private readonly crons = new Map<string, Cron>();
  private readonly nextTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly dispatcher: Dispatcher) {}

  /** Load enabled loops and run until `signal` aborts. */
  start(signal: AbortSignal): void {
    for (const loop of store.listEnabledLoops()) this.schedule(loop);
    signal.addEventListener("abort", () => this.stopAll(), { once: true });
    log.info({ loops: this.crons.size }, "scheduler started");
  }

  /** Validate a cron expression; returns the next fire time or throws. */
  static nextRun(expr: string): Date {
    const probe = new Cron(expr, { paused: true });
    const next = probe.nextRun();
    probe.stop();
    if (!next) throw new Error(`cron expression never fires again: ${expr}`);
    return next;
  }

  /** (Re)register a loop after a store create/update. */
  addLoop(loop: Loop): void {
    this.unschedule(loop.id);
    if (loop.enabled) this.schedule(loop);
  }

  /** Stop a loop's timers (call after delete / disable). */
  removeLoop(id: string): void {
    this.unschedule(id);
  }

  /** Make a loop due immediately (run-now), via the one-shot timer path. */
  runNow(id: string): void {
    const loop = store.updateLoop(id, { nextRunAt: new Date().toISOString() });
    if (loop) this.armNextRunAt(loop);
  }

  /** Manually schedule a dedicated evolution pass as the next tick. */
  evolveNow(id: string): boolean {
    const loop = store.getLoop(id);
    if (!loop || !store.canEvolve(loop)) return false;
    const updated = store.updateLoop(id, { evolveDue: true, nextRunAt: new Date().toISOString() });
    if (updated) this.armNextRunAt(updated);
    return !!updated;
  }

  /** Queue an owner edit: the next tick runs an `edit` agent that applies the
   *  instruction (Agent-First — even cron goes through the machine's claude). */
  requestEdit(id: string, instruction: string): boolean {
    const updated = store.updateLoop(id, { editRequest: instruction, nextRunAt: new Date().toISOString() });
    if (updated) this.armNextRunAt(updated);
    return !!updated;
  }

  /** Clear the edit marker after the edit run ends (mirrors finishEvolution). */
  finishEdit(id: string): void {
    const updated = store.updateLoop(id, { editRequest: null, ...spentNextRunAt(id) });
    if (updated) this.addLoop(updated);
  }

  /** Flag evolution after the first run (to shape the loop from real data ASAP),
   *  then at the slower of "every N runs" and "once a day". */
  maybeFlagEvolve(id: string): void {
    const loop = store.getLoop(id);
    if (!loop || loop.evolveDue || !store.canEvolve(loop)) return;
    const runCount = store.countRuns(id);
    if (runCount < 1) return; // nothing to shape the loop from yet
    const evolved = loop.evolvedRunCount ?? 0;
    // `lastEvolveAt` counts manual evolves too, so a recent hand-triggered
    // "Evolve now" also defers the automatic one. Null ⇒ never evolved → bootstrap
    // now, so the first evolve fires as soon as run #1 lands.
    const last = store.lastEvolveAt(id);
    if (last) {
      // Steady state: both gates must clear — every EVOLVE_EVERY runs AND at most
      // once per EVOLVE_MIN_INTERVAL_MS (= max(N runs, 1 day), the slower cadence).
      if (runCount - evolved < EVOLVE_EVERY) return;
      if (Date.now() - Date.parse(last) < EVOLVE_MIN_INTERVAL_MS) return;
    }
    const updated = store.updateLoop(id, {
      evolveDue: true,
      nextRunAt: new Date(Date.now() + EVOLVE_DELAY_MS).toISOString(),
    });
    if (updated) this.armNextRunAt(updated);
    log.info({ id, runs: runCount, lastEvolved: evolved, bootstrap: !last }, "evolution flagged");
  }

  /** Clear an evolution marker and advance the watermark after the evolve run ends. */
  finishEvolution(id: string): void {
    const updated = store.updateLoop(id, {
      evolveDue: null,
      evolvedRunCount: store.countRuns(id),
      ...spentNextRunAt(id),
    });
    if (updated) this.addLoop(updated);
  }

  /** Loop ids with an open (pending/running) run — for a live "running" indicator. */
  runningIds(): string[] {
    return store.openRuns().map((r) => r.loopId);
  }

  // ---- internals ----

  private schedule(loop: Loop): void {
    try {
      const cron = new Cron(
        loop.cron,
        { name: loop.id, protect: true, catch: true, ...(loop.timezone ? { timezone: loop.timezone } : {}) },
        () => void this.runLoop(loop.id),
      );
      this.crons.set(loop.id, cron);
      log.info({ id: loop.id, cron: loop.cron, next: cron.nextRun()?.toISOString() }, "scheduled");
    } catch (err) {
      log.error({ id: loop.id, cron: loop.cron, err: msg(err) }, "invalid cron — not scheduled");
    }
    this.armNextRunAt(loop);
  }

  private unschedule(id: string): void {
    this.crons.get(id)?.stop();
    this.crons.delete(id);
    const t = this.nextTimers.get(id);
    if (t) clearTimeout(t);
    this.nextTimers.delete(id);
  }

  /** Arm a one-shot timer for `nextRunAt` (run-now / future self-reschedule). */
  private armNextRunAt(loop: Loop): void {
    const existing = this.nextTimers.get(loop.id);
    if (existing) clearTimeout(existing);
    this.nextTimers.delete(loop.id);
    if (!loop.enabled || !loop.nextRunAt) return;
    const target = Date.parse(loop.nextRunAt);
    if (Number.isNaN(target)) return;
    const delay = target - Date.now();
    if (delay <= 0) {
      void this.runLoop(loop.id);
      return;
    }
    if (delay > MAX_TIMER_MS) {
      const t = setTimeout(() => this.armNextRunAt(store.getLoop(loop.id) ?? loop), MAX_TIMER_MS);
      t.unref?.();
      this.nextTimers.set(loop.id, t);
      return;
    }
    const t = setTimeout(() => void this.runLoop(loop.id), delay);
    t.unref?.();
    this.nextTimers.set(loop.id, t);
  }

  /** Execute one tick: create a pending run and dispatch it to the loop's machine. */
  private async runLoop(id: string): Promise<void> {
    let loop = store.getLoop(id);
    if (!loop) {
      this.unschedule(id);
      return;
    }
    if (!loop.enabled) return;
    if (store.hasOpenRun(id)) return; // a prior run is still open — skip this tick

    // Consume a due one-shot override so it doesn't re-fire.
    if (loop.nextRunAt && Date.parse(loop.nextRunAt) <= Date.now() + 1500) {
      loop = store.updateLoop(id, { nextRunAt: null }) ?? loop;
    }

    if (loop.evolveDue && !store.canEvolve(loop)) {
      this.finishEvolution(id);
      return;
    }

    // Edit takes precedence over a scheduled run: the owner asked for a change.
    const role = loop.editRequest ? "edit" : loop.evolveDue ? "evolve" : "exec";
    const run = store.addRun({
      loopId: loop.id,
      userId: loop.userId,
      machineId: loop.machineId,
      phase: "pending",
      role,
      ts: new Date().toISOString(),
    });

    try {
      await this.dispatcher.dispatch(loop, run);
      log.info({ id, runId: run.id, role, machine: loop.machineId }, "tick: run pending");
    } catch (err) {
      store.updateRun(run.id, { phase: "error", outcome: "error", error: msg(err), ts: new Date().toISOString() });
      if (role === "evolve") this.finishEvolution(id);
      else if (role === "edit") this.finishEdit(id); // clear the marker so a failed dispatch doesn't re-fire forever
      log.error({ id, runId: run.id, err: msg(err) }, "tick: dispatch failed");
    } finally {
      const fresh = store.getLoop(id);
      if (fresh) this.armNextRunAt(fresh);
    }
  }

  private stopAll(): void {
    for (const id of [...this.crons.keys()]) this.unschedule(id);
    log.info("scheduler stopped");
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `nextRunAt` cleanup patch for finishEdit/finishEvolution: clear it ONLY
 *  when it's spent (missing / unparsable / in the past — the one-shot that fired
 *  this very run). A FUTURE value is the edit/evolve run's OWN work — it may have
 *  applied `reschedule` — and unconditionally nulling it would silently undo the
 *  change the run just made. */
function spentNextRunAt(id: string): { nextRunAt: null } | Record<string, never> {
  const next = store.getLoop(id)?.nextRunAt;
  return next && Date.parse(next) > Date.now() ? {} : { nextRunAt: null };
}
