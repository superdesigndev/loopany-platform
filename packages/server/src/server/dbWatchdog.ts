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
 * Pure + injectable: `makeDbWatchdog` takes the probe / exit / clock as deps so the
 * decision logic is unit-tested with no real DB, timers, or `process.exit`.
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
}

export function makeDbWatchdog(deps: DbWatchdogDeps): DbWatchdog {
  const {
    probe,
    exit,
    timeoutMs,
    failureThreshold,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    log = logger,
  } = deps;

  let consecutive = 0;
  let running = false; // never overlap ticks (deadline < interval, but be safe)
  let done = false; // latch: after exit, ignore further ticks

  async function tick(): Promise<void> {
    if (running || done) return;
    running = true;
    try {
      await withDeadline(Promise.resolve().then(probe), timeoutMs, setTimer, clearTimer);
      consecutive = 0;
    } catch (err) {
      consecutive += 1;
      log.warn(
        { consecutive, failureThreshold, err: String(err) },
        "db watchdog: liveness ping failed",
      );
      if (consecutive >= failureThreshold) {
        done = true;
        log.error(
          { consecutive },
          "db watchdog: database unreachable for too long — exiting so the platform restarts with a fresh pool",
        );
        exit(1);
      }
    } finally {
      running = false;
    }
  }

  return { tick, failures: () => consecutive };
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
