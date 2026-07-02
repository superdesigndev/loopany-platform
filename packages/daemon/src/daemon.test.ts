/**
 * runDaemon boot guard — a second daemon must REFUSE to start while a live,
 * verified daemon owns the pidfile: it would otherwise overwrite the file, and
 * its exit would delete it while daemon #1 still runs (invisible to `status`,
 * unkillable by `down`, double-polling the server).
 *
 * Uses a temp LOOPANY_HOME and records THIS test process's pid as "the running
 * daemon" — it's alive and its `ps` start-time matches, so the verified check
 * treats it exactly like a live daemon, with no child process to manage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

describe("runDaemon", () => {
  const saved = {
    home: process.env.LOOPANY_HOME,
    token: process.env.LOOPANY_TOKEN,
    server: process.env.LOOPANY_SERVER_URL,
  };
  let home: string | undefined;

  afterEach(() => {
    for (const [k, v] of [
      ["LOOPANY_HOME", saved.home],
      ["LOOPANY_TOKEN", saved.token],
      ["LOOPANY_SERVER_URL", saved.server],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
    vi.resetModules();
  });

  test("refuses to boot when a verified daemon already owns the pidfile", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-daemon-"));
    vi.resetModules();
    process.env.LOOPANY_HOME = home;
    process.env.LOOPANY_TOKEN = "dk_test";
    process.env.LOOPANY_SERVER_URL = "http://127.0.0.1:1";

    const pidfile = await import("./pidfile.js");
    pidfile.writePidFile(process.pid); // alive + matching start-time: a "live daemon"

    const { runDaemon } = await import("./daemon.js");
    const code = await runDaemon();
    expect(code).toBe(1);
    // The existing daemon's pidfile is untouched (not overwritten, not cleared).
    expect(pidfile.readPidFile()?.pid).toBe(process.pid);
  }, 15000);
});
