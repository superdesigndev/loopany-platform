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
