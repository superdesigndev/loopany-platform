/**
 * Scheduler — the in-process cron engine (croner) + a one-shot `nextRunAt` timer
 * per loop. Boots once (Nitro plugin) and runs until the abort signal fires.
 *
 * P0 scope: a tick creates a *pending* run and hands it to a `Dispatcher` (the
 * machine WS gateway in P1). The server itself executes nothing — no workflow
 * JS, no claude. The pending run row IS a durable inbox: if the bound machine
 * isn't reachable it simply waits (the gateway sweep holds, never fails, an
 * offline machine's pending run), the daemon's next poll claims it on
 * reconnect (catch-up), and the NEXT cron fire supersedes a still-waiting one
 * (`skipped`) so the queue coalesces to exactly one catch-up run however long
 * the sleep lasted. Overlapping ticks for a loop with a RUNNING run are skipped.
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
  /** Per-loop in-process in-flight guard. Under sync SQLite, hasOpenRun→addRun was
   *  atomic; async awaits between them now let two concurrent triggers (cron + a
   *  one-shot/runNow landing together) both pass and create TWO pending runs. This
   *  serializes runLoop per loop within this single scheduler process — it
   *  complements (never replaces) the DB-level hasOpenRun check. */
  private readonly running = new Set<string>();

  constructor(private readonly dispatcher: Dispatcher) {}

  /** Load enabled loops and run until `signal` aborts. */
  async start(signal: AbortSignal): Promise<void> {
    for (const loop of await store.listEnabledLoops()) {
      this.schedule(loop);
      await this.catchUpMissedFire(loop);
    }
    signal.addEventListener("abort", () => this.stopAll(), { once: true });
    log.info({ loops: this.crons.size }, "scheduler started");
  }

  /**
   * Boot-time misfire catch-up: croner only computes FUTURE fires, so a cron
   * occurrence that fell inside a deploy/restart window (no scheduler alive)
   * would otherwise vanish silently — a daily loop would skip a whole day
   * because of a 30s deploy. Detect it by reconstruction: the loop's most
   * recent PAST occurrence, if it lies after both the loop's creation and its
   * newest run, was never ticked — fire one compensating tick now. Coalesces by
   * construction (ONE previous occurrence = one tick, however long the outage).
   * The machine-offline case needs nothing here: that fire DID tick and left a
   * deferred pending run (which `newest run ts >= prev` correctly covers). A
   * past-due `nextRunAt` one-shot is already caught up by `armNextRunAt`, so we
   * stand down when one is present rather than double-firing into a supersede.
   */
  private async catchUpMissedFire(loop: Loop): Promise<void> {
    try {
      if (loop.nextRunAt && Date.parse(loop.nextRunAt) <= Date.now()) return;
      const prev = new Cron(loop.cron, loop.timezone ? { timezone: loop.timezone } : {}).previousRuns(1)[0];
      if (!prev) return;
      const prevMs = prev.getTime();
      if (prevMs <= Date.parse(loop.createdAt)) return; // the loop didn't exist yet at that occurrence
      const newest = (await store.listRuns(loop.id, 1))[0];
      if (newest && Date.parse(newest.ts) >= prevMs) return; // that fire happened (or later activity covers it)
      log.info({ id: loop.id, missed: prev.toISOString() }, "boot: firing missed cron occurrence (catch-up)");
      await this.runLoop(loop.id);
    } catch (err) {
      // An invalid cron was already surfaced by schedule(); never block boot.
      log.warn({ id: loop.id, err: msg(err) }, "misfire catch-up probe failed");
    }
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
  async runNow(id: string): Promise<void> {
    const loop = await store.updateLoop(id, { nextRunAt: new Date().toISOString() });
    if (loop) this.armNextRunAt(loop);
  }

  /** Manually schedule a dedicated evolution pass as the next tick. */
  async evolveNow(id: string): Promise<boolean> {
    const loop = await store.getLoop(id);
    if (!loop || !store.canEvolve(loop)) return false;
    const updated = await store.updateLoop(id, { evolveDue: true, nextRunAt: new Date().toISOString() });
    if (updated) this.armNextRunAt(updated);
    return !!updated;
  }

  /** Queue an owner edit: the next tick runs an `edit` agent that applies the
   *  instruction (Agent-First — even cron goes through the machine's claude). */
  async requestEdit(id: string, instruction: string): Promise<boolean> {
    const updated = await store.updateLoop(id, { editRequest: instruction, nextRunAt: new Date().toISOString() });
    if (updated) this.armNextRunAt(updated);
    return !!updated;
  }

  /** Clear the edit marker after the edit run ends (mirrors finishEvolution). */
  async finishEdit(id: string): Promise<void> {
    const updated = await store.updateLoop(id, { editRequest: null, ...(await spentNextRunAt(id)) });
    if (updated) this.addLoop(updated);
  }

  /** Flag evolution after the first run (to shape the loop from real data ASAP),
   *  then at the slower of "every N runs" and "once a day". */
  async maybeFlagEvolve(id: string): Promise<void> {
    const loop = await store.getLoop(id);
    if (!loop || loop.evolveDue || !store.canEvolve(loop)) return;
    const runCount = await store.countRuns(id);
    if (runCount < 1) return; // nothing to shape the loop from yet
    const evolved = loop.evolvedRunCount ?? 0;
    // `lastEvolveAt` counts manual evolves too, so a recent hand-triggered
    // "Evolve now" also defers the automatic one. Null ⇒ never evolved → bootstrap
    // now, so the first evolve fires as soon as run #1 lands.
    const last = await store.lastEvolveAt(id);
    if (last) {
      // Steady state: both gates must clear — every EVOLVE_EVERY runs AND at most
      // once per EVOLVE_MIN_INTERVAL_MS (= max(N runs, 1 day), the slower cadence).
      if (runCount - evolved < EVOLVE_EVERY) return;
      if (Date.now() - Date.parse(last) < EVOLVE_MIN_INTERVAL_MS) return;
    }
    const updated = await store.updateLoop(id, {
      evolveDue: true,
      nextRunAt: new Date(Date.now() + EVOLVE_DELAY_MS).toISOString(),
    });
    if (updated) this.armNextRunAt(updated);
    log.info({ id, runs: runCount, lastEvolved: evolved, bootstrap: !last }, "evolution flagged");
  }

  /** Clear an evolution marker and advance the watermark after the evolve run ends. */
  async finishEvolution(id: string): Promise<void> {
    const updated = await store.updateLoop(id, {
      evolveDue: null,
      evolvedRunCount: await store.countRuns(id),
      ...(await spentNextRunAt(id)),
    });
    if (updated) this.addLoop(updated);
  }

  /** Loop ids with an open (pending/running) run — for a live "running" indicator. */
  async runningIds(): Promise<string[]> {
    return (await store.openRuns()).map((r) => r.loopId);
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
      // Guard the awaited getLoop: a rejection off this timer callback would be an
      // unhandled rejection — fall back to the stale loop and re-arm regardless.
      const t = setTimeout(() => {
        void store
          .getLoop(loop.id)
          .catch(() => undefined)
          .then((fresh) => this.armNextRunAt(fresh ?? loop));
      }, MAX_TIMER_MS);
      t.unref?.();
      this.nextTimers.set(loop.id, t);
      return;
    }
    const t = setTimeout(() => void this.runLoop(loop.id), delay);
    t.unref?.();
    this.nextTimers.set(loop.id, t);
  }

  /** Execute one tick: create a pending run and dispatch it to the loop's machine.
   *  Fire-and-forget from cron/timer callbacks (`void this.runLoop(id)`), so the
   *  WHOLE body is wrapped so a rejected await (getLoop/hasOpenRun/addRun — all now
   *  async) can never escape into a timer as an unhandled rejection. The per-loop
   *  in-flight guard (`this.running`) serializes concurrent triggers into ONE run. */
  private async runLoop(id: string): Promise<void> {
    if (this.running.has(id)) return; // a tick for this loop is already in flight
    this.running.add(id);
    try {
      let loop = await store.getLoop(id);
      if (!loop) {
        this.unschedule(id);
        return;
      }
      if (!loop.enabled) return;
      // A RUNNING run always blocks the tick (never two agents on one loop). A
      // PENDING one is the machine-unreachable deferred case — handled below
      // once this tick's role is known.
      const open = await store.openRunsForLoop(id);
      if (open.some((r) => r.phase === "running")) return;
      const pending = open.filter((r) => r.phase === "pending");
      // Edit takes precedence over a scheduled run: the owner asked for a change.
      const role = loop.editRequest ? "edit" : loop.evolveDue ? "evolve" : "exec";
      if (pending.length) {
        // Only an exec fire supersedes an exec pending (the fresh run does the
        // same work, so the old slot retires as `skipped` — neither success nor
        // failure — and the queue stays depth-1). Evolve/edit passes, and a
        // pending evolve/edit, keep the old skip-this-tick behavior.
        if (role !== "exec" || pending.some((r) => r.role !== "exec")) return;
        for (const r of pending) {
          // Atomic phase-guard: if the daemon claimed it in this same instant,
          // back off — the claimed run is executing, this tick is redundant.
          if (!(await store.supersedePendingRun(r.id, "skipped - the machine was unreachable at the scheduled time; superseded by the next scheduled run"))) return;
        }
        log.info({ id, superseded: pending.length }, "tick: superseded deferred pending run(s)");
      }

      // Consume a due one-shot override so it doesn't re-fire.
      if (loop.nextRunAt && Date.parse(loop.nextRunAt) <= Date.now() + 1500) {
        loop = (await store.updateLoop(id, { nextRunAt: null })) ?? loop;
      }

      if (loop.evolveDue && !store.canEvolve(loop)) {
        await this.finishEvolution(id);
        return;
      }

      const run = await store.addRun({
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
        await store.updateRun(run.id, { phase: "error", outcome: "error", error: msg(err), ts: new Date().toISOString() });
        if (role === "evolve") await this.finishEvolution(id);
        else if (role === "edit") await this.finishEdit(id); // clear the marker so a failed dispatch doesn't re-fire forever
        log.error({ id, runId: run.id, err: msg(err) }, "tick: dispatch failed");
      } finally {
        const fresh = await store.getLoop(id);
        if (fresh) this.armNextRunAt(fresh);
      }
    } catch (err) {
      // Never let a rejection escape a fire-and-forget tick into a timer.
      log.error({ id, err: msg(err) }, "runLoop failed");
    } finally {
      this.running.delete(id);
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
async function spentNextRunAt(id: string): Promise<{ nextRunAt: null } | Record<string, never>> {
  const next = (await store.getLoop(id))?.nextRunAt;
  return next && Date.parse(next) > Date.now() ? {} : { nextRunAt: null };
}
