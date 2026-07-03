/**
 * Daemon mode — connect to a Loopany server and short-poll for deliveries. On
 * each poll the server claims this machine's pending runs and returns them; we
 * run each locally (workflow gate + claude) and report back. Foreground, no
 * keep-alive (BYOA §6); Ctrl-C stops cleanly.
 *
 * Machine identity + workdir roots are the daemon's local config: the device
 * token (env) identifies the machine; LOOPANY_ROOTS is the cwd jail (empty ⇒
 * unrestricted — the bind-time UI is where a user would normally set this).
 */
import os from "node:os";

import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";
import { runDelivery, type Delivery } from "./runner.js";
import { DEVICE_FILE, SERVER_FILE, persist, readStored } from "./config.js";
import { ensureCallbackBin } from "./callback-bin.js";
import { snapshotProgress } from "./progress.js";
import { WatchManager, type WatchSpec } from "./watcher.js";
import { writePidFile, clearPidFile, verifiedRunningPid } from "./pidfile.js";
import { daemonVersion, writeRunningVersion } from "./version.js";

const POLL_MS = Number(process.env.LOOPANY_POLL_MS || 3000);
/** Per-poll fetch timeout — a hung connection must not stall the heartbeat
 *  (the machine would look offline and get swept). */
const POLL_TIMEOUT_MS = 30_000;
/** On SIGTERM/`down`, wait at most this long for in-flight runs to settle (the
 *  abort SIGTERMs their claude children; KILL_GRACE is 5s, so 10s covers it). */
const DRAIN_MS = 10_000;

/** Read a `--flag value` from argv. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Stable per-machine identity: persist the value we're given (so this machine
 * keeps the same identity/server across loops/restarts), or reuse the stored one
 * when none is passed. The machine id is derived from the token; the server URL
 * is persisted too so the interactive `loopany loops`/`edit` commands need no flags.
 */
function resolveStored(file: string, explicit: string | undefined): string | undefined {
  if (explicit) {
    persist(file, explicit);
    return explicit;
  }
  return readStored(file);
}

export async function runDaemon(): Promise<number> {
  // CLI flags (the UI shows `--server-url … --api-key …`) win over env. Both the
  // token and server URL are persisted/reused so this machine keeps a stable
  // identity across runs — and so interactive edits later read them zero-config.
  const token = resolveStored(DEVICE_FILE, flag("--api-key") || process.env.LOOPANY_TOKEN);
  const server = resolveStored(SERVER_FILE, (flag("--server-url") || process.env.LOOPANY_SERVER_URL)?.replace(/\/$/, ""));
  if (!token || !server) {
    logger.error("pass --server-url <url> --api-key <token> (or set LOOPANY_SERVER_URL / LOOPANY_TOKEN)");
    return 1;
  }
  const roots = (process.env.LOOPANY_ROOTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Machine identity reported on every poll (the server captures it on connect).
  // `version` is this daemon's own package version, so the web can flag an
  // outdated daemon and show the exact update command.
  const info = { host: os.hostname(), platform: process.platform, arch: process.arch, version: daemonVersion() };

  // Refuse to boot when a live, VERIFIED daemon already owns the pidfile — a
  // second daemon (e.g. a bare `loopany` in a terminal) would overwrite it, and
  // its exit would delete the file while daemon #1 still runs: invisible to
  // `status`, unkillable by `down`, and double-polling the server.
  const existing = verifiedRunningPid();
  if (existing !== undefined) {
    logger.error({ pid: existing }, "daemon already running — use `loopany down` first");
    return 1;
  }

  // Write the `loopany` callback wrapper once, before any run can fire. Each run
  // prepends CALLBACK_BIN_DIR to claude's PATH (no per-run shim in the workdir).
  ensureCallbackBin();

  // Record our pid so `loopany status`/`loopany down` can find this detached
  // daemon locally (the server only knows online-ness, not the local process).
  writePidFile();
  // Record our version beside the pidfile so `loopany update` can report the
  // old→new version when it hands the running daemon over (best-effort).
  writeRunningVersion();

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => ac.abort());
  }

  // Continuously watch each loop's folder and live-sync artifacts to the server.
  // The watch set is learned from the poll response (server-authoritative), so it
  // survives restarts and covers idle-time human edits, not just in-run output —
  // but the LOCAL roots jail still confines which folders may ever be watched.
  const watchManager = new WatchManager(server, token, roots);

  logger.info({ server, pollMs: POLL_MS, roots: roots.length ? roots : "(no workdir jail)" }, "polling for deliveries");

  // Runs execute in the BACKGROUND so the poll loop keeps heart-beating and can
  // claim further runs while one is still going — a claude run can take minutes,
  // and awaiting it inline made the machine look offline (the server then
  // reclaimed any queued run as "machine offline"). `inFlight` dedups in case the
  // same delivery is ever returned twice.
  const inFlight = new Set<string>();

  while (!ac.signal.aborted) {
    try {
      // Heartbeat carries live progress for any in-flight run (slim activity line,
      // not the transcript) so the dashboard shows "what's it doing" without WS.
      const progress = snapshotProgress();
      // ac.signal rides along so SIGTERM/`down` aborts an in-flight poll too.
      const res = await boundedFetch(`${server}/api/machine/poll`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(progress.length ? { ...info, progress } : info),
      }, POLL_TIMEOUT_MS, ac.signal);
      if (res.ok) {
        const data = (await res.json()) as { deliveries?: Delivery[]; watch?: WatchSpec[] };
        // Reconcile the loop-folder watchers against the server's current set.
        watchManager.reconcile(data.watch ?? []);
        for (const d of data.deliveries ?? []) {
          if (inFlight.has(d.runId)) continue;
          inFlight.add(d.runId);
          logger.info({ runId: d.runId, role: d.role }, "delivery claimed — running");
          // Don't await — let it run in the background while we keep polling.
          // The abort signal rides along so SIGTERM/`down` terminates in-flight
          // claude children instead of orphaning them.
          void runDelivery(d, server, roots, ac.signal)
            .then(() => logger.info({ runId: d.runId }, "delivery finished"))
            .catch((err) => logger.error({ runId: d.runId, err: err instanceof Error ? err.message : String(err) }, "delivery failed"))
            .finally(() => inFlight.delete(d.runId));
        }
      } else {
        logger.warn({ status: res.status, statusText: res.statusText }, "poll non-ok");
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "poll failed");
      }
    }
    await sleep(POLL_MS, ac.signal);
  }
  // Brief drain: the abort above already SIGTERMed in-flight claude children
  // (plumbed through runDelivery → runProcess); give them a bounded window to
  // settle and report instead of being orphaned mid-write.
  const drainDeadline = Date.now() + DRAIN_MS;
  while (inFlight.size > 0 && Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await watchManager.closeAll();
  // Only clear the pidfile if it still records OUR pid — never delete a file a
  // newer daemon has since claimed.
  clearPidFile(process.pid);
  return 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    // Remove the abort listener on normal timeout too — otherwise every poll
    // cycle leaks one listener on the long-lived signal (MaxListenersExceeded).
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
