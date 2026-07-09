/**
 * `adscaile up` — idempotent "make sure a daemon is running for THIS machine".
 *
 * Folds SKILL.md §1 (the token/daemon dance the agent used to hand-run) into one
 * command: resolve this machine's device token (reuse the stored one, else adopt
 * the connect-key), check whether its daemon is already live, and if not spawn a
 * single detached daemon that survives this session, then wait until the server
 * reports the machine online. Safe to call every time — it never starts a second
 * daemon when one is already polling: the LOCAL pidfile is consulted FIRST, so an
 * unreachable server can't make repeated `up`s leak a new daemon per attempt.
 *
 * On a successful up (daemon confirmed live or already running) it also best-effort
 * REFRESHES the adscaile agent skill at USER scope (`~/.claude/skills/adscaile`), so
 * the on-disk skill stays version-locked to the daemon `up` just launched. This is a
 * deliberate reintroduction of skill logic into `up`: 0.4.0 removed it because the
 * old PROJECT-scope install would pollute an arbitrary cwd `up` might run from; user
 * scope has no such hazard (it targets the home dir regardless of cwd), so `up` is
 * the natural refresh point. It's announced in one line and NEVER fails up (it is
 * awaited, so on a cold `npx` it can delay up's return up to the install timeout,
 * but it can never change up's outcome).
 *
 * Every external touch (status fetch, spawn, kill, sleep, pidfile check, skill
 * refresh, persistence, output) is an injectable seam so tests need no process/network.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ensureBinShim } from "./bin-shim.js";
import { DEVICE_FILE, ADSCAILE_DIR, SERVER_FILE, flag, persist, readStored, resolveServerUrl } from "./config.js";
import { fetchMachineStatus, type MachineStatus } from "./control.js";
import { verifiedRunningPid } from "./pidfile.js";
import { refreshHooks } from "./setup.js";
import { type InstallOpts, type InstallOutcome, installSkill } from "./skill-install.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The argv/env plan for the detached daemon spawn (pure, exported for tests).
 * The device token travels via ENV (ADSCAILE_TOKEN — runDaemon reads it), NEVER
 * argv: argv is visible in `ps` for the daemon's whole lifetime while the token
 * file is carefully 0600. Only `--server-url` stays in argv — it's non-secret,
 * and cli.ts's DAEMON_FLAGS fallback keys on the LEADING flag, so a
 * `--server-url …` invocation still routes to daemon mode.
 */
export function buildDaemonSpawn(server: string, token: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [...process.execArgv, process.argv[1] ?? "", "--server-url", server];
  return { args, env: { ...process.env, ADSCAILE_TOKEN: token } };
}

/**
 * Spawn the daemon detached so it outlives this `adscaile up` process (and the
 * Claude Code session that called it). Re-execs THIS CLI, replaying the exact
 * launcher (execPath + execArgv + entry) the same way callback-bin does, so
 * `npx`, `node dist/cli.js`, and `tsx src/cli.ts` all resolve to runDaemon().
 * stdio is redirected to ~/.adscaile/daemon.log. Returns the child pid so a
 * readiness timeout can kill exactly what it started.
 */
function spawnDaemonDefault(server: string, token: string, logFile: string): number | undefined {
  const out = fs.openSync(logFile, "a");
  const { args, env } = buildDaemonSpawn(server, token);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  child.unref();
  return child.pid;
}

const READY_TIMEOUT_MS = 45_000;
const POLL_MS = 1_500;

export type EnsureDeps = {
  fetchStatus?: (server: string, token: string) => Promise<MachineStatus | undefined>;
  spawnDaemon?: (server: string, token: string, logFile: string) => number | undefined;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  /** The local pidfile check (verified alive + start-time match). */
  localPid?: () => number | undefined;
  persist?: (file: string, value: string) => void;
  readToken?: () => string | undefined;
  /** Refresh the user-scope skill (best-effort, announced). Injected in tests. */
  installSkill?: (opts: InstallOpts) => Promise<InstallOutcome>;
  /** Install/refresh the `adscaile` PATH shim (best-effort, feedback #4). Injected in tests. */
  ensureBinShim?: () => void;
  /** Install/refresh the SessionStart hooks (best-effort, P7). Injected in tests. */
  refreshHooks?: () => Promise<void>;
  out?: (s: string) => void;
  err?: (s: string) => void;
};

export type EnsureOpts = {
  /** Skip the "already running" short-circuits and start a fresh daemon
   *  unconditionally. `adscaile update` sets this: it has just stopped the old
   *  daemon, but the server still reports the machine online for up to
   *  ONLINE_TTL (30s), which would otherwise make `up` decline to start the
   *  replacement. The local pidfile was cleared by `down`, so the new daemon
   *  boots cleanly. */
  force?: boolean;
};

export async function runEnsure(args: string[], injected: EnsureDeps = {}, opts: EnsureOpts = {}): Promise<number> {
  const d = {
    fetchStatus: injected.fetchStatus ?? fetchMachineStatus,
    spawnDaemon: injected.spawnDaemon ?? spawnDaemonDefault,
    kill: injected.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig)),
    sleep: injected.sleep ?? sleep,
    localPid: injected.localPid ?? (() => verifiedRunningPid()),
    persist: injected.persist ?? persist,
    readToken: injected.readToken ?? (() => readStored(DEVICE_FILE)),
    installSkill: injected.installSkill ?? installSkill,
    ensureBinShim: injected.ensureBinShim ?? (() => void ensureBinShim()),
    refreshHooks: injected.refreshHooks ?? (() => refreshHooks()),
    out: injected.out ?? ((s: string) => process.stdout.write(s)),
    err: injected.err ?? ((s: string) => process.stderr.write(s)),
  };

  /** Best-effort integration refresh — the user-scope skill, the `adscaile` PATH shim
   *  (feedback #4), and the SessionStart hooks (P7) — each announced in one line, none
   *  ever throwing/failing `up`. Called on every success path. Mirrors how the skill
   *  install has always been best-effort + awaited (may delay `up` on a cold npx, but
   *  never changes the outcome). */
  const refreshSkill = async (): Promise<void> => {
    try {
      const r = await d.installSkill({ global: true });
      d.out(r.line + "\n");
    } catch {
      /* never let a skill refresh fail `up` */
    }
    try {
      d.ensureBinShim();
    } catch {
      /* never let the PATH shim fail `up` */
    }
    await d.refreshHooks();
  };

  const server = resolveServerUrl(flag(args, "server-url"));
  // Reuse this machine's stored identity first (so we stay the SAME machine across
  // runs); only adopt the connect-key the first time, when nothing is stored yet.
  const token = d.readToken() || flag(args, "connect-key") || process.env.ADSCAILE_TOKEN;
  if (!server || !token) {
    d.err("adscaile: usage: adscaile up --server-url <url> --connect-key <dk_…>\n");
    return 2;
  }

  // Persist both now so `adscaile new` and a restart are zero-config (the daemon
  // persists them too on boot; doing it here makes them available immediately).
  d.persist(SERVER_FILE, server);
  d.persist(DEVICE_FILE, token);

  const logFile = path.join(ADSCAILE_DIR, "daemon.log");

  // Local pidfile FIRST: a live verified daemon means never spawn a second one —
  // deciding purely from the server status endpoint meant an unreachable server
  // spawned a NEW detached daemon on every retry (leaking daemons). `force` skips
  // these guards (update just stopped the daemon and always replaces it).
  if (!opts.force) {
    const localPid = d.localPid();
    if (localPid !== undefined) {
      const st = await d.fetchStatus(server, token);
      if (st?.online) {
        d.out(`daemon already running for this machine${st.name ? ` (${st.name})` : ""}\n`);
      } else {
        d.out(`daemon already running locally (pid ${localPid}) — server unreachable or machine still connecting; check ${logFile}\n`);
      }
      await refreshSkill();
      return 0;
    }

    const before = await d.fetchStatus(server, token);
    if (before?.online) {
      d.out(`daemon already running for this machine${before.name ? ` (${before.name})` : ""}\n`);
      await refreshSkill();
      return 0;
    }
  }

  d.out("starting daemon…\n");
  const childPid = d.spawnDaemon(server, token, logFile);

  const attempts = Math.ceil(READY_TIMEOUT_MS / POLL_MS);
  for (let i = 0; i < attempts; i++) {
    await d.sleep(POLL_MS);
    const st = await d.fetchStatus(server, token);
    if (st?.online) {
      d.out(`daemon online — this machine is connected${st.name ? ` (${st.name})` : ""}\n`);
      await refreshSkill();
      return 0;
    }
  }

  // Readiness timeout: don't leave the just-spawned daemon running detached —
  // we're about to report failure, so tear down exactly what we started (its
  // SIGTERM handler exits cleanly and clears its own pidfile).
  if (childPid !== undefined) {
    try {
      d.kill(childPid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  d.err(`adscaile: daemon did not come online within ${READY_TIMEOUT_MS / 1000}s — check ${logFile}\n`);
  return 1;
}
