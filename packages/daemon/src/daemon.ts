/**
 * Daemon mode — connect to a LoopAny server and short-poll for deliveries. On
 * each poll the server claims this machine's pending runs and returns them; we
 * run each locally (workflow gate + claude) and report back. Foreground, no
 * keep-alive (BYOA §6); Ctrl-C stops cleanly.
 *
 * Machine identity + workdir roots are the daemon's local config: the device
 * token (env) identifies the machine; LOOPANY_ROOTS is the cwd jail (empty ⇒
 * unrestricted — the bind-time UI is where a user would normally set this).
 */
import os from "node:os";

import { logger } from "./logger.js";
import { runDelivery, type Delivery } from "./runner.js";
import { DEVICE_FILE, SERVER_FILE, persist, readStored } from "./config.js";
import { ensureCallbackBin } from "./callback-bin.js";
import { snapshotProgress } from "./progress.js";
import { WatchManager, type WatchSpec } from "./watcher.js";
import { writePidFile, clearPidFile } from "./pidfile.js";

const POLL_MS = Number(process.env.LOOPANY_POLL_MS || 3000);

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
  const info = { host: os.hostname(), platform: process.platform, arch: process.arch };

  // Write the `loopany` callback wrapper once, before any run can fire. Each run
  // prepends CALLBACK_BIN_DIR to claude's PATH (no per-run shim in the workdir).
  ensureCallbackBin();

  // Record our pid so `loopany status`/`loopany down` can find this detached
  // daemon locally (the server only knows online-ness, not the local process).
  writePidFile();

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => ac.abort());
  }

  // Continuously watch each loop's folder and live-sync artifacts to the server.
  // The watch set is learned from the poll response (server-authoritative), so it
  // survives restarts and covers idle-time human edits, not just in-run output.
  const watchManager = new WatchManager(server, token);

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
      const res = await fetch(`${server}/api/machine/poll`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(progress.length ? { ...info, progress } : info),
        signal: ac.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { deliveries?: Delivery[]; watch?: WatchSpec[] };
        // Reconcile the loop-folder watchers against the server's current set.
        watchManager.reconcile(data.watch ?? []);
        for (const d of data.deliveries ?? []) {
          if (inFlight.has(d.runId)) continue;
          inFlight.add(d.runId);
          logger.info({ runId: d.runId, role: d.role }, "delivery claimed — running");
          // Don't await — let it run in the background while we keep polling.
          void runDelivery(d, server, roots)
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
  await watchManager.closeAll();
  clearPidFile();
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
