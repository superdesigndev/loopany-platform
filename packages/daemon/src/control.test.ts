/**
 * `adscaile status` / `adscaile down`, exercised with every external touch INJECTED
 * (pidfile read, liveness probe, start-time lookup, kill, server fetch, output) so
 * nothing reads a real ~/.adscaile, signals a real process, or hits the network.
 */
import { describe, expect, test } from "vitest";

import { runStatus, runDown, type ControlDeps } from "./control.js";

/** Capture stdout/stderr into strings for assertions. */
function capture(extra: ControlDeps = {}): ControlDeps & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdout: () => out,
    stderr: () => err,
    ...extra,
  };
}

describe("runStatus", () => {
  test("daemon running → reports pid", async () => {
    const cap = capture({ readPid: () => ({ pid: 4242 }), alive: () => true, server: "", token: undefined });
    const code = await runStatus([], cap);
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("running (pid 4242)");
    expect(cap.stdout()).not.toContain("not running");
  });

  test("no pidfile → not running + hint", async () => {
    const cap = capture({ readPid: () => undefined, server: "", token: undefined });
    await runStatus([], cap);
    expect(cap.stdout()).toContain("not running");
    expect(cap.stdout()).toContain("adscaile up");
  });

  test("stale pidfile (pid dead) → not running, clears the stale file", async () => {
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 999 }),
      alive: () => false,
      clearPid: () => { cleared = true; },
      server: "",
      token: undefined,
    });
    await runStatus([], cap);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("not running");
  });

  test("pid alive but start-time mismatch (reused pid) → not running, clears stale file", async () => {
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "Mon Jun 30 09:00:00 2026" }),
      alive: () => true,
      startTime: () => "Mon Jun 30 17:30:00 2026",
      clearPid: () => { cleared = true; },
      server: "",
      token: undefined,
    });
    await runStatus([], cap);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("not running");
  });

  test("start-time unavailable at check time → degrades to alive-only, reports running", async () => {
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "Mon Jun 30 09:00:00 2026" }),
      alive: () => true,
      startTime: () => undefined,
      server: "",
      token: undefined,
    });
    await runStatus([], cap);
    expect(cap.stdout()).toContain("running (pid 4242)");
  });

  test("server + token present → queries connection, shows online + name", async () => {
    let asked: [string, string] | undefined;
    const cap = capture({
      readPid: () => ({ pid: 1 }),
      alive: () => true,
      server: "https://srv.example",
      token: "dk_secret_abcdef",
      fetchOnline: async (s, t) => { asked = [s, t]; return { online: true, name: "MacBook" }; },
    });
    await runStatus([], cap);
    expect(asked).toEqual(["https://srv.example", "dk_secret_abcdef"]);
    expect(cap.stdout()).toContain("online (MacBook)");
    expect(cap.stdout()).toContain("https://srv.example");
    // The token is fingerprinted, never printed in full.
    expect(cap.stdout()).toContain("…abcdef");
    expect(cap.stdout()).not.toContain("dk_secret_abcdef");
  });

  test("server unreachable → connection unknown, never throws", async () => {
    const cap = capture({
      readPid: () => undefined,
      server: "https://srv.example",
      token: "dk_x",
      fetchOnline: async () => undefined,
    });
    await runStatus([], cap);
    expect(cap.stdout()).toContain("unknown — server unreachable");
  });

  test("no server/token → skips the server query entirely", async () => {
    let called = false;
    const cap = capture({
      readPid: () => undefined,
      server: "",
      token: undefined,
      fetchOnline: async () => { called = true; return undefined; },
    });
    await runStatus([], cap);
    expect(called).toBe(false);
    expect(cap.stdout()).toContain("no device token");
  });
});

describe("runDown", () => {
  test("running daemon → SIGTERM the tracked pid, clears pidfile", async () => {
    const signals: Array<[number, string]> = [];
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 4242 }),
      alive: () => true,
      kill: (pid, sig) => { signals.push([pid, sig]); },
      clearPid: () => { cleared = true; },
    });
    const code = await runDown([], cap);
    expect(code).toBe(0);
    expect(signals).toEqual([[4242, "SIGTERM"]]);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("stopped daemon (pid 4242)");
  });

  test("no daemon → clean no-op, never signals", async () => {
    let killed = false;
    const cap = capture({ readPid: () => undefined, kill: () => { killed = true; } });
    const code = await runDown([], cap);
    expect(code).toBe(0);
    expect(killed).toBe(false);
    expect(cap.stdout()).toContain("no daemon running");
  });

  test("reused pid (start-time mismatch) → never signaled, clears stale file", async () => {
    let killed = false;
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "Mon Jun 30 09:00:00 2026" }),
      alive: () => true,
      startTime: () => "Mon Jun 30 17:30:00 2026",
      clearPid: () => { cleared = true; },
      kill: () => { killed = true; },
    });
    const code = await runDown([], cap);
    expect(code).toBe(0);
    expect(killed).toBe(false);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("no daemon running");
  });

  test("race: pid dies between probe and signal (ESRCH) → clean no-op", async () => {
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 4242 }),
      alive: () => true,
      clearPid: () => { cleared = true; },
      kill: () => { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; },
    });
    const code = await runDown([], cap);
    expect(code).toBe(0);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("no daemon running");
  });

  test("kill fails (EPERM) → reports error, exits non-zero", async () => {
    const cap = capture({
      readPid: () => ({ pid: 4242 }),
      alive: () => true,
      kill: () => { const e = new Error("operation not permitted") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; },
    });
    const code = await runDown([], cap);
    expect(code).toBe(1);
    expect(cap.stderr()).toContain("could not stop daemon");
  });
});
