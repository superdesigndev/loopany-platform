/**
 * Loop artifact watcher (Phase 1 of live-sync). The daemon watches each loop's
 * own folder continuously — between runs and across restarts — and live-syncs
 * changed files to the server, which stores them content-addressed in R2.
 *
 * The watch SET is server-authoritative: the poll response carries `watch:[…]`
 * for every loop bound to this machine, and `WatchManager.reconcile()` opens a
 * watcher for each (closing any that vanished). Each `LoopWatcher`:
 *   • resolves the loop's folder (dirname(taskFile) → workdir → scratch),
 *   • ignores .git/node_modules/.loopany/secrets/.DS_Store,
 *   • debounces with chokidar's awaitWriteFinish + a coalescing flush window,
 *   • sha256-hashes the folder into a FULL manifest (deletions = absence),
 *   • negotiates a content-addressed upload: POST the manifest (+ small inline
 *     blobs), then PUT only the hashes the server says it still needs.
 *
 * Files at/under BLOB_CAP sync their bytes; larger files sync as metadata only.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "chokidar";

import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";
import { resolveLoopDir } from "./loopdir.js";
import { isScratchDir, isWithinResolvedRoots, resolveRoots } from "./roots.js";
import { resolveSyncRoots, type SyncPathEntry, type SyncRoot } from "./syncroots.js";

const log = logger.child({ mod: "watcher" });

/** Per-file byte cap. At/under ⇒ bytes sync; over ⇒ metadata-only (no bytes). */
const BLOB_CAP = 10 * 1024 * 1024; // 10MB
/** Inline small files in the sync POST (skip the PUT round-trip for the common case). */
const INLINE_CAP = 64 * 1024; // 64KB
/** Coalesce a burst of file events into a single sync push. */
const COALESCE_MS = Number(process.env.LOOPANY_SYNC_COALESCE_MS || 1500);
/** After a transient sync failure, re-arm one flush after this delay (no hot-loop). */
const RETRY_MS = Number(process.env.LOOPANY_SYNC_RETRY_MS || 5000);
/** Bounded sync POST — a hung connection must not wedge the flush pipeline. */
const SYNC_TIMEOUT_MS = 30_000;
/** Bounded blob PUT — generous (a 10MB blob on a slow uplink), but never ~5min. */
const BLOB_PUT_TIMEOUT_MS = 120_000;

/** One loop folder the server asked this machine to watch. */
export interface WatchSpec {
  loopId: string;
  workdir: string | null;
  taskFile: string | null;
  /** Extra folders to watch + sync (prefixed); see syncroots.ts. */
  syncPaths?: SyncPathEntry[] | null;
}

// ---- active-run attribution (mirrors progress.ts) ----
// The runner marks a loop's run in-flight so syncs during a run carry its runId
// (Phase 3 attribution seam). Idle-time edits sync with runId = null.
const activeRuns = new Map<string, string>();
export function markRunActive(loopId: string, runId: string): void {
  activeRuns.set(loopId, runId);
}
export function markRunDone(loopId: string): void {
  activeRuns.delete(loopId);
}

// Live watcher registry (by loopId) so the runner can force a final, run-tagged
// sync of a loop's end-state right before it reports (Phase 3) — guaranteeing the
// run snapshot captures even a late write that slipped the debounce window.
const watchersByLoop = new Map<string, LoopWatcher>();

/** Immediately flush the loop's watcher (if any), awaiting the sync round-trip.
 *  Best-effort + a no-op when the loop isn't being watched. */
export async function flushLoop(loopId: string): Promise<void> {
  await watchersByLoop.get(loopId)?.flushNow();
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** NUL byte in the first 8KB ⇒ binary (download-only; not inlined as text). */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const IGNORE_DIRS = new Set([".git", "node_modules", ".loopany"]);

/** Should this loop-relative path (POSIX or OS separators) be excluded entirely? */
function isIgnoredRel(rel: string): boolean {
  const segs = rel.split(/[/\\]/);
  for (const seg of segs) if (IGNORE_DIRS.has(seg)) return true;
  const base = segs[segs.length - 1] ?? "";
  if (base === ".DS_Store") return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base.endsWith(".pem")) return true;
  if (base.startsWith("id_rsa") || base.startsWith("id_ed25519")) return true;
  if (base === ".npmrc" || base === ".netrc" || base === "credentials") return true;
  return false;
}

interface ManifestEntry {
  path: string;
  hash: string | null;
  size: number;
  binary: boolean;
  oversize: boolean;
}

/** The sync endpoint's reply: outstanding hashes to PUT, plus the per-loop
 *  byte-cap signal (paths whose NEW bytes the server refused to store). */
interface SyncResponse {
  needHashes?: string[];
  capExceeded?: boolean;
  bytesUsed?: number;
  bytesCap?: number;
  rejected?: string[];
}

/** Walk the loop's watch roots into ONE full manifest + the bytes of each
 *  in-cap file. A single merged manifest is required: the server tombstones
 *  absent paths, so per-root syncs would delete each other's files. Extra
 *  roots' paths carry their prefix (`signals/FB-1.md`); the loop folder's own
 *  tree stays unprefixed. */
function buildManifest(roots: SyncRoot[]): { entries: ManifestEntry[]; blobs: Map<string, Buffer> } {
  const entries: ManifestEntry[] = [];
  const blobs = new Map<string, Buffer>();
  // The manifest prefix of the root currently being walked ("" for the loop
  // folder). Ignore rules run on the ROOT-relative path so a prefix name can
  // never mask (or trip) the secrets/junk list.
  let pfx = "";
  const walk = (abs: string, rel: string): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (isIgnoredRel(childRel)) continue;
      if (d.isSymbolicLink()) continue;
      const childAbs = path.join(abs, d.name);
      if (d.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!d.isFile()) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(childAbs);
      } catch {
        continue;
      }
      if (st.size > BLOB_CAP) {
        entries.push({ path: pfx + childRel, hash: null, size: st.size, binary: false, oversize: true });
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(childAbs);
      } catch {
        continue;
      }
      const hash = sha256(buf);
      blobs.set(hash, buf);
      entries.push({ path: pfx + childRel, hash, size: buf.length, binary: looksBinary(buf), oversize: false });
    }
  };
  for (const root of roots) {
    pfx = root.prefix ? `${root.prefix}/` : "";
    walk(root.absDir, "");
  }
  return { entries, blobs };
}

/** Watches one loop folder and live-syncs it to the server. */
class LoopWatcher {
  private fsw: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private dirty = false;
  /** The in-flight flush, so callers (flushNow) can await it instead of racing it. */
  private current: Promise<void> | null = null;
  /** A transient sync failure asked for a delayed retry (idle folder self-heals). */
  private retry = false;
  /** Hashes we believe the server already has (skip re-inlining). */
  private synced = new Set<string>();
  private closed = false;

  /** All watch roots: the loop folder (prefix "") + any resolved syncPaths. */
  private readonly roots: SyncRoot[];

  constructor(
    private readonly loopId: string,
    private readonly dir: string,
    private readonly server: string,
    private readonly token: string,
    extraRoots: SyncRoot[] = [],
  ) {
    this.roots = [{ absDir: dir, prefix: "" }, ...extraRoots];
  }

  start(): void {
    this.fsw = watch(
      this.roots.map((r) => r.absDir),
      {
        ignored: (p: string) => {
          // Resolve the event against the root that contains it; the ignore
          // rules run on that root-relative path (same base as the manifest).
          for (const r of this.roots) {
            const rel = path.relative(r.absDir, p);
            if (rel === "") return false;
            if (!rel.startsWith("..")) return isIgnoredRel(rel);
          }
          return true; // outside every root
        },
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        ignoreInitial: false, // emit the current tree on start → initial reconciliation
        followSymlinks: false,
        depth: 99,
      },
    );
    this.fsw.on("all", () => this.schedule());
    this.fsw.on("error", (err) => log.warn({ loopId: this.loopId, err: msg(err) }, "watch error"));
    watchersByLoop.set(this.loopId, this);
    log.info(
      { loopId: this.loopId, dir: this.dir, extraRoots: this.roots.slice(1).map((r) => `${r.absDir} → ${r.prefix}/`) },
      "watching loop folder",
    );
  }

  /** Force an immediate flush (bypassing the debounce timer) and await it — the
   *  runner calls this before reporting so the run's snapshot captures end-state.
   *  Awaits any in-flight flush first (so we never snapshot mid-sync), then runs
   *  one more bounded pass to capture a write that slipped into the in-flight one. */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.current; // block on a flush already running (null ⇒ resolves now)
    // That flush's tail may have re-armed a debounced/retry flush; drop it and run
    // one guaranteed fresh pass so the run snapshot reflects the folder's end-state.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Debounce: coalesce a burst of events into one flush. */
  private schedule(delay = COALESCE_MS): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Start a flush (or join the in-flight one). Returns the in-flight promise so
   *  flushNow can await it; debounced callers fire-and-forget via `void`. */
  private flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.dirty = true; // a flush is in flight — re-run once it's done
      return this.current ?? Promise.resolve();
    }
    this.running = true;
    this.current = this.runFlush();
    return this.current;
  }

  private async runFlush(): Promise<void> {
    try {
      const { entries, blobs } = buildManifest(this.roots);
      const runId = activeRuns.get(this.loopId) ?? null;

      // Inline changed small files to save the PUT round-trip.
      const inline: Array<{ hash: string; encoding: "base64"; data: string }> = [];
      for (const e of entries) {
        if (e.oversize || !e.hash || this.synced.has(e.hash)) continue;
        const buf = blobs.get(e.hash);
        if (buf && buf.length <= INLINE_CAP) inline.push({ hash: e.hash, encoding: "base64", data: buf.toString("base64") });
      }

      const manifest = entries.map((e) => ({ path: e.path, hash: e.hash, size: e.size, binary: e.binary, oversize: e.oversize }));
      const res = await this.postSync({ loopId: this.loopId, runId, manifest, blobs: inline });
      if (!res) {
        this.retry = true; // transient failure → re-arm a delayed flush (idle self-heal)
        return;
      }
      // Surface a byte-cap rejection on the machine — otherwise a rejected file
      // silently never syncs and the loop owner has no local hint why.
      if (res.capExceeded) {
        log.warn(
          { loopId: this.loopId, bytesUsed: res.bytesUsed, bytesCap: res.bytesCap, rejected: res.rejected ?? [] },
          "server rejected file(s) over the loop's storage cap — their bytes were not synced",
        );
      }

      const need = new Set(res.needHashes ?? []);
      const failed = new Set<string>();
      for (const hash of need) {
        const buf = blobs.get(hash);
        if (!buf) {
          failed.add(hash);
          continue;
        }
        if (!(await this.putBlob(hash, buf))) failed.add(hash);
      }
      // Mark everything the server now has as synced (exclude PUTs that failed so
      // the next flush retries them).
      this.synced = new Set(entries.map((e) => e.hash).filter((h): h is string => !!h && !failed.has(h)));
      if (failed.size > 0) this.retry = true; // a PUT failed → re-arm so it retries without a new event
    } catch (err) {
      log.warn({ loopId: this.loopId, err: msg(err) }, "sync flush failed");
      this.retry = true;
    } finally {
      this.running = false;
      this.current = null;
      if (this.dirty) {
        this.dirty = false;
        this.retry = false;
        this.schedule();
      } else if (this.retry) {
        this.retry = false;
        this.schedule(RETRY_MS);
      }
    }
  }

  private async postSync(body: unknown): Promise<SyncResponse | null> {
    try {
      const res = await boundedFetch(`${this.server}/api/machine/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, SYNC_TIMEOUT_MS);
      if (!res.ok) {
        log.warn({ loopId: this.loopId, status: res.status }, "sync non-ok");
        return null;
      }
      return (await res.json()) as SyncResponse;
    } catch (err) {
      log.warn({ loopId: this.loopId, err: msg(err) }, "sync request failed");
      return null;
    }
  }

  private async putBlob(hash: string, buf: Buffer): Promise<boolean> {
    try {
      const res = await boundedFetch(`${this.server}/api/machine/blob/${hash}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(buf),
      }, BLOB_PUT_TIMEOUT_MS);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** The resolved folder this watcher is bound to (compared on reconcile). */
  get watchDir(): string {
    return this.dir;
  }

  /** Identity of the FULL root set (dirs + prefixes) — reconcile replaces the
   *  watcher when this changes (a syncPaths edit or a `.loopany-sync.json`
   *  change must reshape the watch, exactly like a taskFile move). */
  get rootsKey(): string {
    return this.roots.map((r) => `${r.prefix} ${r.absDir}`).join("\n");
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    // Only drop the registry entry if it still points at THIS watcher (a dir-move
    // reconcile may have already replaced it with a fresh one for the same loop).
    if (watchersByLoop.get(this.loopId) === this) watchersByLoop.delete(this.loopId);
    if (this.fsw) await this.fsw.close().catch(() => {});
    this.fsw = null;
  }
}

/**
 * Reconciles the set of loop watchers against the server-authoritative `watch`
 * list on each poll: opens watchers for newly-seen loops, closes vanished ones.
 * Idempotent — calling it every poll keeps watching continuous and restart-safe.
 */
export class WatchManager {
  private readonly watchers = new Map<string, LoopWatcher>();
  /** The daemon's LOCAL roots jail (LOOPANY_ROOTS), pre-resolved ONCE — reconcile
   *  runs on every ~3s poll and must not re-resolve the same fixed list per loop.
   *  Empty ⇒ unrestricted. */
  private readonly roots: string[];

  constructor(
    private readonly server: string,
    private readonly token: string,
    roots: string[] = [],
  ) {
    this.roots = resolveRoots(roots);
  }

  reconcile(specs: WatchSpec[]): void {
    const want = new Map(specs.map((s) => [s.loopId, s] as const));
    // Close watchers for loops no longer in the set.
    for (const [id, w] of [...this.watchers]) {
      if (!want.has(id)) {
        void w.close();
        this.watchers.delete(id);
      }
    }
    // Open watchers for newly-seen loops whose folder currently exists (a folder
    // that doesn't exist yet is retried on the next poll — it isn't recorded).
    // A loop's taskFile/workdir are mutable server-side, so re-resolve the dir of
    // an already-watched loop and reopen when it moved (else edits in the new
    // folder never sync and the server's view goes permanently stale).
    for (const [id, spec] of want) {
      const dir = resolveLoopDir(spec);
      // LOCAL jail: workdir/taskFile are SERVER-SENT, so when LOOPANY_ROOTS is
      // set we never watch (and therefore never sync out) a folder outside it —
      // a hostile server must not be able to exfiltrate e.g. ~/.ssh. The
      // daemon's own scratch dir stays allowed (its location is fixed locally).
      if (this.roots.length && !isWithinResolvedRoots(dir, this.roots) && !isScratchDir(dir)) {
        log.warn({ loopId: id, dir }, "loop folder is outside LOOPANY_ROOTS — not watching");
        continue;
      }
      if (!fs.existsSync(dir)) {
        const existing = this.watchers.get(id);
        if (existing) {
          void existing.close(); // dir moved to a not-yet-existing path → stop the stale watcher
          this.watchers.delete(id);
        }
        continue;
      }
      // Extra sync roots (server-sent syncPaths ∪ the folder's .loopany-sync.json)
      // resolve on EVERY poll — cheap (a stat per entry), and it's what picks up a
      // .loopany-sync.json edit within a poll cycle. Each root passes the same
      // jail as the loop folder (inside resolveSyncRoots).
      const extras = resolveSyncRoots(id, spec.syncPaths, dir, spec.workdir, this.roots);
      const key = [{ absDir: dir, prefix: "" }, ...extras].map((r) => `${r.prefix} ${r.absDir}`).join("\n");
      const existing = this.watchers.get(id);
      if (existing) {
        if (existing.rootsKey === key) continue; // unchanged → leave alone
        void existing.close(); // dir moved / root set changed → drop the stale watcher
        this.watchers.delete(id);
      }
      const w = new LoopWatcher(id, dir, this.server, this.token, extras);
      w.start();
      this.watchers.set(id, w);
    }
  }

  /** The dirs currently watched, by loopId (introspection/test seam). */
  watchedDirs(): Map<string, string> {
    return new Map([...this.watchers].map(([id, w]) => [id, w.watchDir] as const));
  }

  /** Each loop's FULL root-set identity (introspection/test seam) — the same
   *  key reconcile compares, so tests can assert extra sync roots landed. */
  watchedRoots(): Map<string, string> {
    return new Map([...this.watchers].map(([id, w]) => [id, w.rootsKey] as const));
  }

  async closeAll(): Promise<void> {
    for (const w of this.watchers.values()) await w.close();
    this.watchers.clear();
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
