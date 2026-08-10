import { describe, it, expect, vi } from "vitest";

import { makeDbWatchdog } from "./dbWatchdog.js";

// A silent logger so failing-ping warnings don't spam the test output.
const quietLog = { warn: () => {}, error: () => {} };

/** Immediate fake timers so the deadline race resolves synchronously in tests. */
function immediateTimers() {
  const fns: Array<() => void> = [];
  return {
    setTimer: (fn: () => void) => {
      fns.push(fn);
      return fns.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    // Fire every armed deadline timer (simulates timeouts elapsing).
    fireAll: () => {
      const pending = fns.splice(0);
      for (const fn of pending) fn();
    },
  };
}

describe("makeDbWatchdog", () => {
  it("exits after N consecutive failed pings", async () => {
    const exit = vi.fn();
    const wd = makeDbWatchdog({
      probe: () => Promise.reject(new Error("pool wedged")),
      exit,
      timeoutMs: 5000,
      failureThreshold: 3,
      log: quietLog,
    });

    await wd.tick();
    expect(wd.failures()).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    await wd.tick();
    expect(wd.failures()).toBe(2);
    expect(exit).not.toHaveBeenCalled();

    await wd.tick();
    expect(wd.failures()).toBe(3);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("a HUNG ping (never settles) counts as a failure via the deadline", async () => {
    const exit = vi.fn();
    const timers = immediateTimers();
    const wd = makeDbWatchdog({
      probe: () => new Promise(() => {}), // never resolves — the wedged-pool case
      exit,
      timeoutMs: 5000,
      failureThreshold: 2,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      log: quietLog,
    });

    const t1 = wd.tick();
    timers.fireAll(); // deadline elapses → ping rejects
    await t1;
    expect(wd.failures()).toBe(1);

    const t2 = wd.tick();
    timers.fireAll();
    await t2;
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("a healthy ping resets the failure streak (a blip never restarts)", async () => {
    const exit = vi.fn();
    let outcome: "fail" | "ok" = "fail";
    const wd = makeDbWatchdog({
      probe: () => (outcome === "ok" ? Promise.resolve(1) : Promise.reject(new Error("blip"))),
      exit,
      timeoutMs: 5000,
      failureThreshold: 3,
      log: quietLog,
    });

    await wd.tick(); // fail 1
    await wd.tick(); // fail 2
    expect(wd.failures()).toBe(2);

    outcome = "ok";
    await wd.tick(); // healthy → reset
    expect(wd.failures()).toBe(0);
    expect(exit).not.toHaveBeenCalled();

    // A fresh streak must again reach the threshold before exit.
    outcome = "fail";
    await wd.tick();
    await wd.tick();
    expect(exit).not.toHaveBeenCalled();
    await wd.tick();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("stops ticking after it has exited (single-shot)", async () => {
    const exit = vi.fn();
    const probe = vi.fn(() => Promise.reject(new Error("wedged")));
    const wd = makeDbWatchdog({ probe, exit, timeoutMs: 5000, failureThreshold: 1, log: quietLog });

    await wd.tick();
    expect(exit).toHaveBeenCalledOnce();
    const callsAfterExit = probe.mock.calls.length;

    await wd.tick();
    await wd.tick();
    // No further probes once latched — process is on its way down.
    expect(probe.mock.calls.length).toBe(callsAfterExit);
    expect(exit).toHaveBeenCalledOnce();
  });
});

/**
 * The 2026-08-10 outage regression: prod ran at ~6% of a core (88% `steal`) after
 * exhausting its shared-CPU burst balance. Node could not drain its DB sockets, so
 * `select 1` blew its deadline against a DATABASE THAT WAS HEALTHY (every backend
 * idle in `ClientRead`, zero lock contention). The watchdog called that a wedged
 * pool and exited; each restart re-armed every loop and re-fired misfire catch-up,
 * spiking CPU on an already-drained balance, so successive lives ran 455s, 161s,
 * then 100s. The "recovery" WAS the outage. A restart cannot fix a starved CPU.
 */
describe("makeDbWatchdog under event-loop starvation", () => {
  it("never exits on failed pings while the event loop is starved", async () => {
    const exit = vi.fn();
    const wd = makeDbWatchdog({
      probe: () => Promise.reject(new Error("db ping timed out after 5000ms")),
      exit,
      timeoutMs: 5000,
      failureThreshold: 3,
      lagMs: () => 4_000, // 4s of event-loop delay: this process cannot keep up
      lagCeilingMs: 1_000,
      log: quietLog,
    });

    for (let i = 0; i < 10; i++) await wd.tick();

    expect(exit).not.toHaveBeenCalled();
    expect(wd.failures()).toBe(0); // inconclusive ticks never build a streak
    expect(wd.starved()).toBe(10);
  });

  it("still exits for a real wedge once the loop is healthy again", async () => {
    const exit = vi.fn();
    let lag = 4_000;
    const wd = makeDbWatchdog({
      probe: () => Promise.reject(new Error("pool wedged")),
      exit,
      timeoutMs: 5000,
      failureThreshold: 3,
      lagMs: () => lag,
      lagCeilingMs: 1_000,
      log: quietLog,
    });

    await wd.tick();
    await wd.tick();
    expect(exit).not.toHaveBeenCalled();

    lag = 5; // CPU is fine now, so a failing ping really is the database
    await wd.tick();
    await wd.tick();
    await wd.tick();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("counts a failure normally when lag sits under the ceiling", async () => {
    const exit = vi.fn();
    const wd = makeDbWatchdog({
      probe: () => Promise.reject(new Error("pool wedged")),
      exit,
      timeoutMs: 5000,
      failureThreshold: 2,
      lagMs: () => 12, // a healthy server: single-digit-to-low-double-digit ms
      lagCeilingMs: 1_000,
      log: quietLog,
    });

    await wd.tick();
    expect(wd.failures()).toBe(1);
    await wd.tick();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("blames the database when the lag signal itself is unreadable", async () => {
    const exit = vi.fn();
    const wd = makeDbWatchdog({
      probe: () => Promise.reject(new Error("pool wedged")),
      exit,
      timeoutMs: 5000,
      failureThreshold: 1,
      lagMs: () => {
        throw new Error("monitor unavailable");
      },
      lagCeilingMs: 1_000,
      log: quietLog,
    });

    // A broken lag probe must never become a way to suppress a genuine wedge exit.
    await wd.tick();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps the old always-blame-the-DB behavior when no lag signal is wired", async () => {
    const exit = vi.fn();
    const wd = makeDbWatchdog({
      probe: () => Promise.reject(new Error("pool wedged")),
      exit,
      timeoutMs: 5000,
      failureThreshold: 1,
      log: quietLog,
    });

    await wd.tick();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a healthy ping clears both the failure streak and the starved counter", async () => {
    const exit = vi.fn();
    let ok = false;
    const wd = makeDbWatchdog({
      probe: () => (ok ? Promise.resolve(1) : Promise.reject(new Error("x"))),
      exit,
      timeoutMs: 5000,
      failureThreshold: 3,
      lagMs: () => 4_000,
      lagCeilingMs: 1_000,
      log: quietLog,
    });

    await wd.tick();
    expect(wd.starved()).toBe(1);
    ok = true;
    await wd.tick();
    expect(wd.starved()).toBe(0);
    expect(wd.failures()).toBe(0);
  });
});
