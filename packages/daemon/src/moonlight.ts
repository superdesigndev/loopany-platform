/**
 * Moonlight: the resident daemon doubles as the local KERNEL TICK DRIVER.
 *
 * A `@loopany/cli` kernel workspace (`.loopany/` holding local tasks/loops) has
 * no resident process - its cron loops only fire when someone runs
 * `loopany-kernel tick`. To get them ticked automatically, each workspace
 * registers itself in `<LOOPANY_DIR>/kernel.json` (written by `loopany-kernel
 * init`/`register`). This module reads that registry on a slow cadence (~60s,
 * NOT every poll - cron is minute-granular) and runs `<entry.bin> tick --spawn`
 * per workspace, so due loops fire and their runs are claimed + executed against
 * the LOCAL filesystem.
 *
 * Subprocess-over-import ON PURPOSE: the CLI is the interface, so the daemon and
 * the kernel/CLI versions stay independent (the daemon replays whatever bin the
 * workspace registered - a dev `.mjs` or a global npm install).
 *
 * Every touch is BEST-EFFORT and ISOLATED: a missing/broken workspace or bin
 * logs one concise line and never affects the poll loop or the other workspaces.
 * In-flight is tracked per dir so the daemon never piles up concurrent ticks of
 * the same workspace (the CLI's own lockfile makes a collision safe, but we don't
 * spawn into it). A child is bounded by a wall-clock timeout, then its whole
 * process group is killed (consistent with the daemon's other child kills).
 *
 * All external touches (registry read, spawn, clock, fs existence, logging) are
 * INJECTABLE seams so tests drive it with no real process, registry, or clock.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { LOOPANY_DIR } from "./config.js";
import { logger } from "./logger.js";
import { allowlistEnv } from "./spawn.js";

/** How often the moonlight tick runs. Cron is minute-granular, so a per-poll
 *  (3s) cadence would be wasteful; ~60s catches every minute boundary. */
export const MOONLIGHT_INTERVAL_MS = Number(process.env.LOOPANY_MOONLIGHT_MS || 60_000);
/** Per-workspace child wall-clock cap. A `tick --spawn` may launch an agent, so
 *  give it real headroom, then kill the process group (a hung workspace must not
 *  wedge the moonlight loop forever). */
export const MOONLIGHT_TICK_TIMEOUT_MS = Number(
  process.env.LOOPANY_MOONLIGHT_TIMEOUT_MS || 10 * 60_000,
);

/** One registered workspace, as read from `kernel.json`. Mirrors the CLI's
 *  `RegistryEntry` (we DON'T import across packages - the daemon reads the file
 *  itself, so the wire shape is the contract). */
export interface RegistryEntry {
  dir: string;
  bin: string;
}

/** The result of spawning one workspace tick. `status` null ⇒ killed by signal
 *  (timeout). `lines` are the child's stdout lines worth surfacing. */
export interface TickChildResult {
  status: number | null;
  /** stdout lines the child emitted that are worth logging (tick:/spawn:/»). */
  lines: string[];
  /** A launch/spawn error message, if the child never ran. */
  error?: string;
}

/** The process-spawn seam. Resolves when the child exits (or is killed). */
export type TickSpawnFn = (entry: RegistryEntry) => Promise<TickChildResult>;

export interface MoonlightDeps {
  /** Read the registry entries. Defaults to reading `<LOOPANY_DIR>/kernel.json`. */
  readRegistry?: () => RegistryEntry[];
  /** Spawn `<bin> tick --spawn` for one workspace. Defaults to a real subprocess. */
  spawnTick?: TickSpawnFn;
  /** Does this path exist? (a vanished workspace dir is skipped). Default: fs. */
  exists?: (p: string) => boolean;
  /** Concise logger. Defaults to the daemon logger. */
  log?: (line: string) => void;
}

const REGISTRY_FILE = path.join(LOOPANY_DIR, "kernel.json");
const warnedMissing = new Set<string>();

/** Read + parse `kernel.json`, TOLERANT of every failure (missing, corrupt,
 *  non-array, bad entries) → an empty list. Never throws (registry breakage must
 *  never fault the daemon). Mirrors the CLI's `readRegistry` tolerance. */
export function readRegistryFile(file: string = REGISTRY_FILE): RegistryEntry[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RegistryEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { dir, bin } = item as Record<string, unknown>;
    if (typeof dir !== "string" || dir.length === 0) continue;
    if (typeof bin !== "string" || bin.length === 0) continue;
    out.push({ dir, bin });
  }
  return out;
}

/** The default real spawn: `node? <bin> tick --spawn` with cwd = the workspace,
 *  an allowlisted env (needs a normal PATH + HOME so the bin and its agents
 *  resolve), a wall-clock timeout, and a process-group kill on timeout. Captures
 *  stdout, returning only the lines worth surfacing. Never rejects - a launch
 *  failure resolves as `{status:127,error}`. */
export const realTickSpawn: TickSpawnFn = (entry) =>
  new Promise<TickChildResult>((resolve) => {
    const grouped = process.platform !== "win32";
    // The registered bin is a directly-runnable executable (a `.mjs` launcher
    // with a node shebang, or a global shim), invoked with a shell=false argv so
    // a hostile path can't inject. `tick --spawn` is the fixed verb.
    const child = spawn(entry.bin, ["tick", "--spawn"], {
      cwd: entry.dir,
      env: allowlistEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });

    let stdout = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      signalTree(child, grouped, "SIGKILL");
    }, MOONLIGHT_TICK_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", () => {
      /* surfaced only via nonzero exit; stdout carries the tick/spawn lines */
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: 127, lines: [], error: err.message });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        status: killed ? null : status,
        lines: surfaceLines(stdout),
        ...(killed ? { error: "timed out - killed" } : {}),
      });
    });
  });

/** Signal a child's process group (posix), falling back to the direct child. */
function signalTree(
  child: { pid?: number; kill: (sig: NodeJS.Signals) => void },
  grouped: boolean,
  sig: NodeJS.Signals,
): void {
  if (grouped && child.pid) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      /* group already gone - fall through */
    }
  }
  child.kill(sig);
}

/** Pick the child's stdout lines worth logging: the CLI prints `tick:`/`spawn:`
 *  status lines and `»`-prefixed notices. A no-op tick ("tick: nothing due" +
 *  "spawn: nothing to run") stays silent so the daemon log doesn't fill with
 *  noise, so we drop those two exact lines. */
export function surfaceLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => /^(tick:|spawn:|»)/.test(l))
    .filter((l) => l !== "tick: nothing due" && l !== "spawn: nothing to run");
}

/** Run one moonlight pass: for each registered workspace whose dir still exists
 *  and is not already ticking, spawn `<bin> tick --spawn`. Best-effort + isolated
 *  per workspace. `inFlight` is the caller-owned set of dirs currently ticking
 *  (so a slow tick spanning two intervals is never double-spawned).
 *
 *  Returns when EVERY spawned tick has settled (so a test can await one pass);
 *  the interval scheduler does not await it (fire-and-forget). */
export async function tickRegisteredWorkspaces(
  inFlight: Set<string>,
  deps: MoonlightDeps = {},
): Promise<void> {
  const read = deps.readRegistry ?? (() => readRegistryFile());
  const spawnTick = deps.spawnTick ?? realTickSpawn;
  const exists = deps.exists ?? existsSync;
  const log = deps.log ?? ((line: string) => logger.info(line));

  let entries: RegistryEntry[];
  try {
    entries = read();
  } catch {
    return; // a broken registry never faults the loop
  }

  const passes = entries.map(async (entry) => {
    const dir = path.resolve(entry.dir);
    if (inFlight.has(dir)) return; // still ticking from a prior interval
    if (!exists(dir)) {
      if (!warnedMissing.has(dir)) {
        warnedMissing.add(dir);
        log(`moonlight: registered workspace missing - skipped ${dir}; run \`lk unregister\` from that workspace or remove the stale registry entry`);
      }
      return; // never auto-remove: registry authority stays explicit
    }
    warnedMissing.delete(dir);
    inFlight.add(dir);
    try {
      const res = await spawnTick(entry);
      if (res.error) {
        log(`moonlight: ${dir} tick error: ${res.error}`);
      } else if (typeof res.status === "number" && res.status !== 0) {
        log(`moonlight: ${dir} tick exited ${res.status}`);
      }
      for (const line of res.lines) log(`moonlight: ${dir} | ${line}`);
    } catch (err) {
      // A rejected spawn seam must never escape the pass (best-effort).
      log(`moonlight: ${dir} tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight.delete(dir);
    }
  });
  await Promise.all(passes);
}

/** Start the moonlight side-job on an interval. Returns a stop function that
 *  clears the interval (the in-flight ticks drain on their own). The first pass
 *  fires after one interval, not immediately, so daemon boot stays cheap. */
export function startMoonlight(deps: MoonlightDeps = {}): () => void {
  const inFlight = new Set<string>();
  const timer = setInterval(() => {
    // Fire-and-forget: a slow pass must not block the interval, and every touch
    // inside is already best-effort/isolated.
    void tickRegisteredWorkspaces(inFlight, deps);
  }, MOONLIGHT_INTERVAL_MS);
  // Don't keep the process alive for the moonlight timer alone - the poll loop
  // owns the daemon's lifetime.
  timer.unref?.();
  return () => clearInterval(timer);
}
