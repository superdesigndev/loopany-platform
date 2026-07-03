/**
 * `loopany up`, exercised with every external touch INJECTED (status fetch,
 * spawn, kill, sleep, local pidfile check, persistence, output) so nothing hits
 * the network, spawns a process, or writes the real ~/.loopany.
 */
import { describe, expect, test } from "vitest";

import { buildDaemonSpawn, runEnsure, type EnsureDeps } from "./ensure.js";
import type { InstallOpts } from "./skill-install.js";

type Cap = EnsureDeps & {
  stdout: () => string;
  stderr: () => string;
  spawned: () => number;
  killed: () => Array<[number, string]>;
  skillInstalls: () => InstallOpts[];
};

/** Baseline seams: nothing running, server unreachable, spawn returns pid 555. The
 *  skill refresh is stubbed so no test spawns npx / hits the network. */
function seams(extra: EnsureDeps = {}): Cap {
  let out = "";
  let err = "";
  let spawned = 0;
  const killed: Array<[number, string]> = [];
  const skillInstalls: InstallOpts[] = [];
  return {
    fetchStatus: async () => undefined,
    spawnDaemon: () => { spawned += 1; return 555; },
    kill: (pid, sig) => { killed.push([pid, sig]); },
    sleep: async () => {},
    localPid: () => undefined,
    persist: () => {},
    readToken: () => "dk_stored",
    installSkill: async (opts) => { skillInstalls.push(opts); return { ok: true, line: "loopany skill: installed → ~/.claude/skills/loopany" }; },
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdout: () => out,
    stderr: () => err,
    spawned: () => spawned,
    killed: () => killed,
    skillInstalls: () => skillInstalls,
    ...extra,
  };
}

describe("runEnsure — local pidfile first (no daemon leaks)", () => {
  test("a live local daemon short-circuits: never spawns a second one even when the server is unreachable", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => undefined });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(cap.stdout()).toContain("already running locally (pid 4242)");
  });

  test("a live local daemon that the server also sees online → the classic already-running message", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => ({ online: true, name: "MacBook" }) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(cap.stdout()).toContain("daemon already running for this machine (MacBook)");
  });
});

describe("runEnsure — readiness", () => {
  test("daemon comes online → success, spawned once, never killed", async () => {
    let calls = 0;
    const cap = seams({
      // Pre-spawn check offline, then online once the spawned daemon polls in.
      fetchStatus: async () => (++calls >= 2 ? { online: true, name: "MacBook" } : undefined),
    });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([]);
    expect(cap.stdout()).toContain("daemon online");
  });

  test("readiness timeout → kills exactly the daemon it spawned, exits 1", async () => {
    const cap = seams(); // server never reports online
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]); // no orphaned detached daemon
    expect(cap.stderr()).toContain("did not come online");
  });

  test("kill racing the daemon's own exit (throws) is swallowed", async () => {
    const cap = seams({
      kill: () => { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; },
    });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
  });
});

describe("runEnsure — force (update's replace path)", () => {
  test("force skips the already-running short-circuits and spawns anyway", async () => {
    // A live local daemon AND the server reporting online would normally short-
    // circuit; force starts a fresh daemon regardless (update just stopped the old
    // one, but the server still reports online within the TTL).
    let calls = 0;
    const cap = seams({
      localPid: () => 4242,
      fetchStatus: async () => (++calls >= 1 ? { online: true, name: "Mac" } : undefined),
    });
    const code = await runEnsure([], cap, { force: true });
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(cap.stdout()).toContain("starting daemon");
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });
});

describe("runEnsure — user-scope skill refresh on every success path", () => {
  test("live local daemon + server online → refreshes the skill (global), announced", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => ({ online: true, name: "Mac" }) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
    expect(cap.stdout()).toContain("loopany skill: installed → ~/.claude/skills/loopany");
  });

  test("live local daemon + server unreachable → still refreshes the skill", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => undefined });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("server already online (no local pid) → refreshes the skill", async () => {
    const cap = seams({ fetchStatus: async () => ({ online: true }) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("freshly spawned daemon comes online → refreshes the skill", async () => {
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls >= 2 ? { online: true } : undefined) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("readiness timeout (up FAILS) → does NOT refresh the skill", async () => {
    const cap = seams(); // never online
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.skillInstalls()).toEqual([]);
  });

  test("a throwing skill refresh never fails up (best-effort)", async () => {
    const cap = seams({
      fetchStatus: async () => ({ online: true }),
      installSkill: async () => { throw new Error("npx ENOENT"); },
    });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0); // up still succeeds
  });
});

describe("buildDaemonSpawn — the token travels via env, never argv", () => {
  test("argv carries only --server-url; the token rides LOOPANY_TOKEN", () => {
    const { args, env } = buildDaemonSpawn("http://srv", "dk_secret_token");
    expect(args.join(" ")).not.toContain("dk_secret_token"); // never visible in `ps`
    expect(args).not.toContain("--api-key");
    expect(env.LOOPANY_TOKEN).toBe("dk_secret_token");
    // cli.ts's DAEMON_FLAGS fallback keys on the LEADING flag after the entry
    // script — `--server-url <url>` must be the trailing pair so the re-exec
    // still routes to daemon mode.
    expect(args[args.length - 2]).toBe("--server-url");
    expect(args[args.length - 1]).toBe("http://srv");
  });
});
