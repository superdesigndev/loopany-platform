/**
 * pidfile — the shared verifiedRunningPid check (seams injected, no real
 * process/`ps`) and the ownership-checked clearPidFile: a daemon exiting must
 * never delete a pidfile another daemon has since claimed. The fs-touching test
 * relocates ~/.loopany via LOOPANY_HOME and re-imports the module so LOOPANY_DIR
 * (computed at load) points at a temp dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { verifiedRunningPid } from "./pidfile.js";

describe("verifiedRunningPid (seams injected)", () => {
  const noClear = () => {};

  test("live pid with matching start-time → returned", () => {
    const pid = verifiedRunningPid({
      readPid: () => ({ pid: 7, startTime: "t1" }),
      alive: () => true,
      startTime: () => "t1",
      clearPid: noClear,
    });
    expect(pid).toBe(7);
  });

  test("dead pid → undefined, stale file cleared", () => {
    let cleared = false;
    const pid = verifiedRunningPid({
      readPid: () => ({ pid: 7 }),
      alive: () => false,
      startTime: () => undefined,
      clearPid: () => { cleared = true; },
    });
    expect(pid).toBeUndefined();
    expect(cleared).toBe(true);
  });

  test("reused pid (start-time mismatch) → undefined, stale file cleared", () => {
    let cleared = false;
    const pid = verifiedRunningPid({
      readPid: () => ({ pid: 7, startTime: "t1" }),
      alive: () => true,
      startTime: () => "t2",
      clearPid: () => { cleared = true; },
    });
    expect(pid).toBeUndefined();
    expect(cleared).toBe(true);
  });

  test("start-time unreadable at check time → degrades to alive-only", () => {
    const pid = verifiedRunningPid({
      readPid: () => ({ pid: 7, startTime: "t1" }),
      alive: () => true,
      startTime: () => undefined,
      clearPid: noClear,
    });
    expect(pid).toBe(7);
  });

  test("no pidfile → undefined", () => {
    expect(verifiedRunningPid({ readPid: () => undefined, alive: () => true, startTime: () => undefined, clearPid: noClear })).toBeUndefined();
  });
});

describe("clearPidFile ownership (real fs under a temp LOOPANY_HOME)", () => {
  const prevHome = process.env.LOOPANY_HOME;
  let home: string | undefined;

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LOOPANY_HOME;
    else process.env.LOOPANY_HOME = prevHome;
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
    vi.resetModules();
  });

  test("clearPidFile(pid) removes the file only when it still records that pid", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-pidfile-"));
    vi.resetModules();
    process.env.LOOPANY_HOME = home;
    const mod = await import("./pidfile.js");

    // Daemon #2 owns the file (pid 222); an exiting daemon #1 (pid 111) must not delete it.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mod.PID_FILE, "222\n");
    mod.clearPidFile(111);
    expect(fs.existsSync(mod.PID_FILE)).toBe(true);

    // The recorded owner may clear it…
    mod.clearPidFile(222);
    expect(fs.existsSync(mod.PID_FILE)).toBe(false);

    // …and the unconditional form (stale-file cleanup) still clears anything.
    fs.writeFileSync(mod.PID_FILE, "333\n");
    mod.clearPidFile();
    expect(fs.existsSync(mod.PID_FILE)).toBe(false);
  });
});
