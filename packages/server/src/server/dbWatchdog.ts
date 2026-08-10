/**
 * DB watchdog — the real auto-recovery backstop for a wedged postgres-js pool.
 *
 * BACKGROUND (2026-07-12 outage, twice in one day): the runtime pool against the
 * Supabase transaction pooler wedged — every connection stuck on a query that
 * never returned, so `/api/health/db`'s `select 1` queued behind them forever and
 * the server stopped sending response headers. Fly's health check went `critical`,
 * which only PULLS the machine from load balancing (a well-known Fly footgun:
 * failing `[http_service.checks]` do NOT restart the VM — only a process EXIT
 * triggers `restart.policy = "on-failure"`). Result: ~9h fully down with no
 * auto-recovery until a manual `fly machine restart`. The pool's own self-healing
 * (`max_lifetime`/`statement_timeout`, `db/index.ts`) can't cover a busy-wedged
 * connection or a dead socket that never errors.
 *
 * This watchdog closes that gap: it pings `select 1` on a fixed cadence under a
 * HARD client-side deadline (a hung ping counts as a failure, since the underlying
 * query can't be canceled). After N consecutive failures it exits the process, so
 * Fly restarts the machine with a fresh pool — turning a multi-hour hang into a
 * ~1-2min self-heal. A single healthy ping resets the streak, so a transient blip
 * never restarts the box.
 *
 * NOT every slow ping is a wedged pool (the 2026-08-10 outage). When the process
 * itself is starved of CPU it cannot drain its DB sockets or fire its own timers,
 * so `select 1` blows its deadline while the database is perfectly healthy. Exiting
 * then makes things strictly worse: the restart re-arms every loop and re-fires
 * misfire catch-up, spiking CPU on an already-drained budget, so each life gets
 * shorter and the box never recovers. The watchdog therefore consults event-loop
 * delay before blaming the database, and treats a ping that failed under starvation
 * as INCONCLUSIVE — it neither trips the exit nor clears a real streak. A restart is
 * the right cure for a wedged pool and the wrong cure for a starved CPU.
 *
 * That guard is an EXCUSE, never an alibi. A wedged pool can coexist with a busy
 * event loop, so an unbounded excuse would quietly hand back the 2026-07-12 failure
 * mode above. After `starvedCeiling` consecutive inconclusive ticks the watchdog
 * exits anyway: restarting is a poor cure for a starved CPU, but a strictly better
 * outcome than remaining wedged forever. The ceiling is far longer than the failure
 * threshold, so the crash-loop amplification stays broken.
 *
 * Pure + injectable: `makeDbWatchdog` takes the probe / exit / clock / lag signal as
 * deps so the decision logic is unit-tested with no real DB, timers, or
 * `process.exit`.
 */
import { logger } from "../logger.js";

type Logger = typeof logger;

export interface DbWatchdogDeps {
  /** Runs the liveness query (e.g. `db.execute(sql\`select 1\`)`). May hang. */
  probe: () => Promise<unknown>;
  /** Terminates the process (real: `process.exit`; tests: a spy). */
  exit: (code: number) => void;
  /** Hard per-ping deadline in ms — a ping exceeding it is a failure. */
  timeoutMs: number;
  /** Consecutive failures before exit. A healthy ping resets the streak. */
  failureThreshold: number;
  /** Recent worst event-loop delay in ms (real: `perf_hooks.monitorEventLoopDelay`).
   *  Read ONLY to disqualify a failed ping — see `lagCeilingMs`. Omit to disable
   *  the guard entirely (the pre-2026-08-10 behavior). */
  lagMs?: () => number;
  /** Event-loop delay above which a failed ping proves NOTHING about the database.
   *  Beyond this, the process cannot service its own socket reads or fire its own
   *  timers on time, so `select 1` "timing out" is a statement about THIS process,
   *  not the pool. Such a tick is recorded as inconclusive: it neither counts
   *  toward the exit threshold nor resets a genuine streak. */
  lagCeilingMs?: number;
  /** How many CONSECUTIVE inconclusive ticks to tolerate before exiting anyway.
   *  The starvation guard must be an excuse, never an alibi: a wedged pool can
   *  coexist with a busy event loop, and an unbounded guard would restore the
   *  unrecoverable-wedge failure mode the watchdog exists to end. Defaults to
   *  `DEFAULT_STARVED_CEILING`. */
  starvedCeiling?: number;
  /** Injectable timer for the deadline race (default `setTimeout`). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  log?: Pick<Logger, "warn" | "error">;
}

/** Reject if `p` hasn't settled within `ms`. The underlying promise keeps running
 *  (we can't cancel a wedged query) — bounded by the exit after `failureThreshold`. */
function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
  clearTimer: (h: ReturnType<typeof setTimeout>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const h = setTimer(() => reject(new Error(`db ping timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimer(h);
        resolve(v);
      },
      (e) => {
        clearTimer(h);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface DbWatchdog {
  /** Run one probe cycle; updates the failure streak and exits at the threshold. */
  tick: () => Promise<void>;
  /** Current consecutive-failure count (test/observability). */
  failures: () => number;
  /** Consecutive ticks discarded as inconclusive under event-loop starvation. */
  starved: () => number;
}

/**
 * Consecutive inconclusive (starved) ticks before the watchdog exits regardless.
 * 45 ticks is ~15 minutes at the default 20s cadence: long enough that a genuinely
 * CPU-starved box is not put back into the 100s crash loop the guard was added to
 * break (a shared-CPU burst balance can accrue between lives), short enough that a
 * wedge hiding behind a busy event loop is still bounded rather than permanent.
 */
export const DEFAULT_STARVED_CEILING = 45;

export function makeDbWatchdog(deps: DbWatchdogDeps): DbWatchdog {
  const {
    probe,
    exit,
    timeoutMs,
    failureThreshold,
    lagMs,
    lagCeilingMs,
    starvedCeiling = DEFAULT_STARVED_CEILING,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    log = logger,
  } = deps;

  let consecutive = 0;
  let starvedTicks = 0;
  let running = false; // never overlap ticks (deadline < interval, but be safe)
  let done = false; // latch: after exit, ignore further ticks

  /** Read AND reset the lag window. Called on EVERY tick, success or failure, so the
   *  sample always describes the interval that contained this probe. Reading only on
   *  failure would let `max` accumulate across any number of healthy ticks, so one
   *  old boot-time stall could disqualify a much later, genuine failure. */
  function sampleLag(): number | null {
    if (!lagMs || lagCeilingMs == null) return null;
    try {
      const lag = lagMs();
      return Number.isFinite(lag) ? lag : null;
    } catch {
      return null; // an unreadable lag signal must never block a real wedge exit
    }
  }

  async function tick(): Promise<void> {
    if (running || done) return;
    running = true;
    try {
      let failure: unknown;
      let failed = false;
      try {
        await withDeadline(Promise.resolve().then(probe), timeoutMs, setTimer, clearTimer);
      } catch (err) {
        failed = true;
        failure = err;
      }
      // Sample unconditionally, so the window stays fresh even across healthy ticks.
      const lag = sampleLag();

      if (!failed) {
        consecutive = 0;
        starvedTicks = 0;
        return;
      }

      // A failed ping under event-loop starvation is INCONCLUSIVE. This is the
      // 2026-08-10 outage: the machine's CPU burst balance was exhausted and it ran
      // at ~6% of a core (88% steal), so Node could not drain its DB sockets. The DB
      // was healthy - every backend sat in `ClientRead`, zero lock contention - yet
      // `select 1` blew its 5s deadline, this watchdog called it a wedge, and the
      // restart re-armed every loop and re-fired misfire catch-up, spiking CPU on an
      // already-drained balance. Each life got shorter (455s -> 161s -> 100s) and the
      // process never recovered: the "recovery" was the outage. Restarting cannot fix
      // a starved CPU, so we decline to act rather than amplify.
      if (lag != null && lagCeilingMs != null && lag > lagCeilingMs) {
        starvedTicks += 1;
        // ...but NOT forever. A wedged pool can perfectly well coexist with a busy
        // event loop, and an unbounded excuse would hand back the very failure mode
        // this watchdog exists to end (2026-07-12: ~9h down, no auto-recovery). Past
        // the ceiling we exit anyway: a restart is a poor cure for CPU starvation but
        // a strictly better outcome than staying wedged indefinitely. The ceiling is
        // far longer than the failure threshold, so the crash-loop amplification is
        // still broken - the restart cadence goes from ~100s to ~15min, which leaves
        // room for a shared-CPU burst balance to recover between lives.
        if (starvedTicks >= starvedCeiling) {
          done = true;
          log.error(
            { starvedTicks, starvedCeiling, lagMs: Math.round(lag), lagCeilingMs },
            "db watchdog: pings have failed under a starved event loop for too long - exiting anyway rather than staying unrecoverable",
          );
          exit(1);
          return;
        }
        log.warn(
          { lagMs: Math.round(lag), lagCeilingMs, consecutive, starvedTicks, starvedCeiling, err: String(failure) },
          "db watchdog: ping failed while the event loop was starved - inconclusive, not counting it (a restart cannot fix CPU starvation)",
        );
        return;
      }

      consecutive += 1;
      starvedTicks = 0;
      log.warn(
        { consecutive, failureThreshold, err: String(failure) },
        "db watchdog: liveness ping failed",
      );
      if (consecutive >= failureThreshold) {
        done = true;
        log.error(
          { consecutive },
          "db watchdog: database unreachable for too long - exiting so the platform restarts with a fresh pool",
        );
        exit(1);
      }
    } finally {
      running = false;
    }
  }

  return { tick, failures: () => consecutive, starved: () => starvedTicks };
}

/**
 * Start the watchdog on a repeating interval. Returns a stop function (cleared on
 * the boot AbortController). The interval is `unref`'d so it never keeps the
 * process alive on its own.
 */
export function startDbWatchdog(
  deps: DbWatchdogDeps & { intervalMs: number },
): () => void {
  const wd = makeDbWatchdog(deps);
  const handle = setInterval(() => void wd.tick(), deps.intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
