/**
 * `adscaile update` — hand the running daemon over to a newer version.
 *
 * The invoking CLI IS already the new version (the user ran
 * `npx @crewlet/adscaile@latest update`), so there's nothing to download: the
 * verb just swaps the *running* detached daemon for this one.
 *
 *   - No daemon running → behave like `up` (start this version + refresh the
 *     user-scope skill), with a clear line.
 *   - Daemon running → stop the verified pid (reuse `down`'s machinery), start
 *     the new daemon (reuse `up`/ensure incl. the readiness probe + env-token
 *     passing + skill refresh), and print an old→new summary when the old
 *     version is knowable (from the running-version file the daemon writes).
 *
 * On a stop, in-flight runs matter: the daemon drains them (its SIGTERM handler
 * gives claude children a bounded window) before exiting, but there's no local
 * record another process can read to know whether a run is mid-flight, so we say
 * so honestly rather than pretend to check. We warn, then proceed.
 *
 * Every external touch (pid check, stop, start, version reads, output) is an
 * injectable seam so tests need no real process/network.
 */
import { DEVICE_FILE, readStored, resolveServerUrl } from "./config.js";
import { runDown, type ControlDeps } from "./control.js";
import { runEnsure, type EnsureDeps, type EnsureOpts } from "./ensure.js";
import { verifiedRunningPid } from "./pidfile.js";
import { daemonVersion, readRunningVersion } from "./version.js";

export type UpdateDeps = {
  localPid?: () => number | undefined;
  readServer?: () => string;
  readToken?: () => string | undefined;
  currentVersion?: () => string | undefined;
  runningVersion?: () => string | undefined;
  down?: (args: string[], injected?: ControlDeps) => Promise<number>;
  ensure?: (args: string[], injected?: EnsureDeps, opts?: EnsureOpts) => Promise<number>;
  out?: (s: string) => void;
  err?: (s: string) => void;
};

export async function runUpdate(args: string[], injected: UpdateDeps = {}): Promise<number> {
  const d = {
    localPid: injected.localPid ?? (() => verifiedRunningPid()),
    readServer: injected.readServer ?? (() => resolveServerUrl(undefined)),
    readToken: injected.readToken ?? (() => readStored(DEVICE_FILE)),
    currentVersion: injected.currentVersion ?? daemonVersion,
    runningVersion: injected.runningVersion ?? readRunningVersion,
    down: injected.down ?? runDown,
    ensure: injected.ensure ?? runEnsure,
    out: injected.out ?? ((s: string) => process.stdout.write(s)),
    err: injected.err ?? ((s: string) => process.stderr.write(s)),
  };

  const server = d.readServer();
  const token = d.readToken();
  if (!server || !token) {
    d.err("adscaile: not connected — run `adscaile up --server-url <url> --connect-key <dk_…>` first\n");
    return 2;
  }

  const newVer = d.currentVersion();
  const newLabel = newVer ? `v${newVer}` : "the current version";

  const pid = d.localPid();
  if (pid === undefined) {
    // Nothing to hand over — just stand this version up (like `up`).
    d.out(`no daemon running — starting ${newLabel}…\n`);
    return d.ensure([]);
  }

  // A daemon is running. We can't see run state locally from another process, so
  // be honest: stopping it will end any run currently in flight (the daemon
  // drains briefly before exit) rather than pretending we checked.
  const oldVer = d.runningVersion();
  const oldLabel = oldVer ? `v${oldVer}` : "the running daemon";
  d.out(`updating ${oldLabel} → ${newLabel} (pid ${pid})…\n`);
  d.out("note: this stops the running daemon — any run in flight is drained briefly, then ended.\n");

  const stopCode = await d.down([]);
  if (stopCode !== 0) {
    d.err("adscaile: could not stop the running daemon — update aborted\n");
    return stopCode;
  }

  // Force a fresh start: `down` cleared the local pidfile, but the server still
  // reports this machine online for up to ONLINE_TTL (30s), which would make a
  // plain `up` decline to start the replacement.
  const upCode = await d.ensure([], {}, { force: true });
  if (upCode === 0) {
    d.out(oldVer && newVer ? `updated: v${oldVer} → v${newVer}\n` : `updated to ${newLabel}\n`);
  }
  return upCode;
}
