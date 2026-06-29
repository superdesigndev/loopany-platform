/**
 * `loopany up` — idempotent "make sure a daemon is running for THIS machine".
 *
 * Folds SKILL.md §1 (the token/daemon dance the agent used to hand-run) into one
 * command: resolve this machine's device token (reuse the stored one, else adopt
 * the connect-key), check whether its daemon is already live, and if not spawn a
 * single detached daemon that survives this session, then wait until the server
 * reports the machine online. Safe to call every time — it never starts a second
 * daemon when one is already polling.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DEVICE_FILE, LOOPANY_DIR, SERVER_FILE, flag, persist, readStored, resolveServerUrl } from "./config.js";

type Status = { online: boolean; name: string | null };

async function fetchStatus(server: string, token: string): Promise<Status | undefined> {
  try {
    const res = await fetch(`${server}/api/machine/status`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    return (await res.json()) as Status;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Spawn the daemon detached so it outlives this `loopany up` process (and the
 * Claude Code session that called it). Re-execs THIS CLI with no verb — argless
 * ⇒ daemon mode — replaying the exact launcher (execPath + execArgv + entry) the
 * same way callback-bin does, so `npx`, `node dist/cli.js`, and `tsx src/cli.ts`
 * all resolve to runDaemon(). stdio is redirected to ~/.loopany/daemon.log.
 */
function spawnDaemon(server: string, token: string, logFile: string): void {
  const out = fs.openSync(logFile, "a");
  const args = [...process.execArgv, process.argv[1] ?? "", "--server-url", server, "--api-key", token];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
}

const READY_TIMEOUT_MS = 45_000;
const POLL_MS = 1_500;

export async function runEnsure(args: string[]): Promise<number> {
  const server = resolveServerUrl(flag(args, "server-url"));
  // Reuse this machine's stored identity first (so we stay the SAME machine across
  // runs); only adopt the connect-key the first time, when nothing is stored yet.
  const token = readStored(DEVICE_FILE) || flag(args, "connect-key") || process.env.LOOPANY_TOKEN;
  if (!server || !token) {
    process.stderr.write("loopany: usage: loopany up --server-url <url> --connect-key <dk_…>\n");
    return 2;
  }

  // Persist both now so `loopany new` and a restart are zero-config (the daemon
  // persists them too on boot; doing it here makes them available immediately).
  persist(SERVER_FILE, server);
  persist(DEVICE_FILE, token);

  const logFile = path.join(LOOPANY_DIR, "daemon.log");

  const before = await fetchStatus(server, token);
  if (before?.online) {
    process.stdout.write(`daemon already running for this machine${before.name ? ` (${before.name})` : ""}\n`);
    return 0;
  }

  process.stdout.write("starting daemon…\n");
  spawnDaemon(server, token, logFile);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const st = await fetchStatus(server, token);
    if (st?.online) {
      process.stdout.write(`daemon online — this machine is connected${st.name ? ` (${st.name})` : ""}\n`);
      return 0;
    }
  }

  process.stderr.write(`loopany: daemon did not come online within ${READY_TIMEOUT_MS / 1000}s — check ${logFile}\n`);
  return 1;
}
