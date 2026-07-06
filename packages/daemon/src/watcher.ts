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
 *   • builds a FULL manifest of the folder (deletions = absence), hashing
 *     INCREMENTALLY: a stat cache (size+mtime+ctime, with a git-index-style
 *     racy-write guard) means an unchanged file is never re-read, so a flush
 *     costs O(changed bytes) — not O(folder bytes) — and never holds file
 *     bytes in memory beyond the one being stream-hashed,
 *   • skips the network round-trip entirely when the manifest digest matches
 *     the last server-acked one (spurious watch events cost one stat walk),
 *   • negotiates a content-addressed upload: POST the manifest (+ small
 *     changed blobs inlined under a total budget), then PUT — a few
 *     concurrently — only the hashes the server says it still needs,
 *     re-reading and re-verifying bytes at send time.
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

const log = logger.child({ mod: "watcher" });

/** Per-file byte cap. At/under ⇒ bytes sync; over ⇒ metadata-only (no bytes). */
const BLOB_CAP = 10 * 1024 * 1024; // 10MB
/** Inline small files in the sync POST (skip the PUT round-trip for the common case). */
const INLINE_CAP = 64 * 1024; // 64KB
/** Aggregate raw-byte budget for inlined blobs in ONE sync POST. Base64 inflates
 *  ~33% and the server's SYNC_BODY_CAP is 32MB — without a total budget, a burst
 *  of small files could 413 the POST and (since a retry rebuilds the identical
 *  body) wedge the loop's sync permanently. Overflow files simply take the
 *  needHashes → PUT path instead. */
export const INLINE_TOTAL_CAP = 1024 * 1024; // 1MB
/** Coalesce a burst of file events into a single sync push. */
const COALESCE_MS = Number(process.env.LOOPANY_SYNC_COALESCE_MS || 1500);
/** After a transient sync failure, re-arm one flush after this delay (no hot-loop). */
const RETRY_MS = Number(process.env.LOOPANY_SYNC_RETRY_MS || 5000);
/** Bounded sync POST — a hung connection must not wedge the flush pipeline. */
const SYNC_TIMEOUT_MS = 30_000;
/** Bounded blob PUT — generous (a 10MB blob on a slow uplink), but never ~5min. */
const BLOB_PUT_TIMEOUT_MS = 120_000;
/** Concurrent blob PUTs per flush (content-addressed, so order is irrelevant). */
const PUT_CONCURRENCY = 4;
/** Racy-write guard (git-index style): a cache entry hashed within this window
 *  of the file's mtime is distrusted and re-hashed — a same-size rewrite inside
 *  coarse mtime granularity would otherwise serve a stale hash forever. */
const RACY_MS = 2000;

/** One loop folder the server asked this machine to watch. */
export interface WatchSpec {
  loopId: string;
  workdir: string | null;
  taskFile: string | null;
}

/** The network seam (injectable for tests): boundedFetch-shaped. */
export type SyncFetch = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

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

/** Stat-cache entry: lets an unchanged file's hash be served without reading it. */
export interface HashCacheEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  hash: string;
  binary: boolean;
  /** When the bytes were hashed — the racy-write guard's reference point. */
  hashedAt: number;
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

/** Stream-hash a file: sha256 + binary sniff (NUL in the first 8KB) + byte
 *  count, without ever buffering the whole file. Null on any read error. */
function hashFile(abs: string): Promise<{ hash: string; binary: boolean; size: number } | null> {
  return new Promise((resolve) => {
    const h = createHash("sha256");
    let binary = false;
    let sniffed = 0;
    let size = 0;
    const rs = fs.createReadStream(abs);
    rs.on("data", (chunk) => {
      const buf = chunk as Buffer;
      h.update(buf);
      size += buf.length;
      if (!binary && sniffed < 8192) {
        const n = Math.min(buf.length, 8192 - sniffed);
        for (let i = 0; i < n; i++) {
          if (buf[i] === 0) {
            binary = true;
            break;
          }
        }
        sniffed += n;
      }
    });
    rs.on("error", () => resolve(null));
    rs.on("end", () => resolve({ hash: h.digest("hex"), binary, size }));
  });
}

export interface ManifestBuild {
  entries: ManifestEntry[];
  /** hash → absolute path of one file carrying those bytes (for on-demand reads). */
  paths: Map<string, string>;
  /** The refreshed stat cache for the next build (vanished paths drop out). */
  cache: Map<string, HashCacheEntry>;
}

/**
 * Walk a loop folder into a full manifest. Hashing is incremental: a file whose
 * size+mtime+ctime match the previous build's cache entry (and whose mtime is
 * safely older than when that entry was hashed — the racy-write guard) reuses
 * the cached hash without being read. No file bytes are retained: callers
 * re-read (and re-verify) bytes on demand when the server actually wants them.
 */
export async function buildManifest(dir: string, prev: Map<string, HashCacheEntry> = new Map()): Promise<ManifestBuild> {
  const entries: ManifestEntry[] = [];
  const paths = new Map<string, string>();
  const cache = new Map<string, HashCacheEntry>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (isIgnoredRel(childRel)) continue;
      if (d.isSymbolicLink()) continue;
      const childAbs = path.join(abs, d.name);
      if (d.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!d.isFile()) continue;
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(childAbs);
      } catch {
        continue;
      }
      if (st.size > BLOB_CAP) {
        entries.push({ path: childRel, hash: null, size: st.size, binary: false, oversize: true });
        continue;
      }
      const hit = prev.get(childRel);
      const trustworthy =
        hit &&
        hit.size === st.size &&
        hit.mtimeMs === st.mtimeMs &&
        hit.ctimeMs === st.ctimeMs &&
        st.mtimeMs + RACY_MS <= hit.hashedAt;
      let entry: HashCacheEntry;
      if (trustworthy) {
        entry = hit;
      } else {
        const hashedAt = Date.now();
        const hashed = await hashFile(childAbs);
        if (!hashed) continue;
        entry = { size: hashed.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, hash: hashed.hash, binary: hashed.binary, hashedAt };
      }
      cache.set(childRel, entry);
      paths.set(entry.hash, childAbs);
      entries.push({ path: childRel, hash: entry.hash, size: entry.size, binary: entry.binary, oversize: false });
    }
  };
  await walk(dir, "");
  return { entries, paths, cache };
}

/** Order-independent digest of a manifest — the "did anything change" key. */
function manifestDigest(entries: ManifestEntry[]): string {
  const canon = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}\0${e.hash ?? ""}\0${e.size}\0${e.binary ? 1 : 0}\0${e.oversize ? 1 : 0}`)
    .join("\n");
  return createHash("sha256").update(canon).digest("hex");
}

/** Read a file and confirm its bytes still hash to `hash` — the manifest may be
 *  moments stale, and bytes must never ship under a hash they don't have. */
async function readVerified(abs: string, hash: string): Promise<Buffer | null> {
  try {
    const buf = await fs.promises.readFile(abs);
    return sha256(buf) === hash ? buf : null;
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
  /** Stat cache from the previous manifest build (incremental hashing). */
  private hashCache = new Map<string, HashCacheEntry>();
  /** Digest of the manifest the server last fully acked — an identical rebuild
   *  (spurious event, timer re-arm) skips the network round-trip entirely. */
  private lastAcked: string | null = null;
  /** True once one sync negotiation succeeded. The FIRST flush (initial
   *  reconciliation) sends no inline bytes: after a daemon restart `synced` is
   *  empty while the server already has almost everything — inlining would
   *  re-upload the folder's whole small-file population for nothing. */
  private negotiated = false;
  private closed = false;

  constructor(
    private readonly loopId: string,
    private readonly dir: string,
    private readonly server: string,
    private readonly token: string,
    private readonly fetchImpl: SyncFetch = boundedFetch,
  ) {}

  start(): void {
    this.fsw = watch(this.dir, {
      ignored: (p: string) => {
        const rel = path.relative(this.dir, p);
        if (rel === "") return false;
        if (rel.startsWith("..")) return true;
        return isIgnoredRel(rel);
      },
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      ignoreInitial: false, // emit the current tree on start → initial reconciliation
      followSymlinks: false,
      depth: 99,
    });
    this.fsw.on("all", () => this.schedule());
    this.fsw.on("error", (err) => log.warn({ loopId: this.loopId, err: msg(err) }, "watch error"));
    watchersByLoop.set(this.loopId, this);
    log.info({ loopId: this.loopId, dir: this.dir }, "watching loop folder");
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
      const { entries, paths, cache } = await buildManifest(this.dir, this.hashCache);
      this.hashCache = cache;
      const digest = manifestDigest(entries);
      if (digest === this.lastAcked) return; // unchanged since the last acked sync — no network
      const runId = activeRuns.get(this.loopId) ?? null;

      // Inline changed small files to save the PUT round-trip — but only after a
      // first negotiation established what the server has, and under a total
      // budget so the POST body stays bounded no matter how many files changed.
      const inline: Array<{ hash: string; encoding: "base64"; data: string }> = [];
      if (this.negotiated) {
        let budget = INLINE_TOTAL_CAP;
        const queued = new Set<string>();
        for (const e of entries) {
          if (e.oversize || !e.hash || e.size > INLINE_CAP || e.size > budget) continue;
          if (this.synced.has(e.hash) || queued.has(e.hash)) continue;
          const abs = paths.get(e.hash);
          const buf = abs ? await readVerified(abs, e.hash) : null;
          if (!buf) continue; // changed underfoot → the needHashes/PUT path picks it up
          inline.push({ hash: e.hash, encoding: "base64", data: buf.toString("base64") });
          queued.add(e.hash);
          budget -= buf.length;
        }
      }

      const res = await this.postSync({ loopId: this.loopId, runId, manifest: entries, blobs: inline });
      if (!res) {
        this.retry = true; // transient failure → re-arm a delayed flush (idle self-heal)
        return;
      }
      this.negotiated = true;
      // Surface a byte-cap rejection on the machine — otherwise a rejected file
      // silently never syncs and the loop owner has no local hint why.
      if (res.capExceeded) {
        log.warn(
          { loopId: this.loopId, bytesUsed: res.bytesUsed, bytesCap: res.bytesCap, rejected: res.rejected ?? [] },
          "server rejected file(s) over the loop's storage cap — their bytes were not synced",
        );
      }

      // PUT the hashes the server still needs, a few at a time. Bytes are read
      // on demand and re-verified at send time — the flush never holds the
      // folder's bytes in memory, only its manifest.
      const need = [...new Set(res.needHashes ?? [])];
      const failed = new Set<string>();
      await forEachLimit(need, PUT_CONCURRENCY, async (hash) => {
        const abs = paths.get(hash);
        const buf = abs ? await readVerified(abs, hash) : null;
        if (!buf || !(await this.putBlob(hash, buf))) failed.add(hash);
      });

      // Mark everything the server now has as synced (exclude PUTs that failed so
      // the next flush retries them).
      this.synced = new Set(entries.map((e) => e.hash).filter((h): h is string => !!h && !failed.has(h)));
      if (failed.size > 0) this.retry = true; // a PUT failed → re-arm so it retries without a new event
      else this.lastAcked = digest;
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
      const res = await this.fetchImpl(`${this.server}/api/machine/sync`, {
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
      const res = await this.fetchImpl(`${this.server}/api/machine/blob/${hash}`, {
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
    private readonly fetchImpl: SyncFetch = boundedFetch,
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
      const existing = this.watchers.get(id);
      if (existing) {
        if (existing.watchDir === dir) continue; // unchanged → leave alone
        void existing.close(); // dir moved → drop the stale watcher
        this.watchers.delete(id);
      }
      if (!fs.existsSync(dir)) continue;
      const w = new LoopWatcher(id, dir, this.server, this.token, this.fetchImpl);
      w.start();
      this.watchers.set(id, w);
    }
  }

  /** The dirs currently watched, by loopId (introspection/test seam). */
  watchedDirs(): Map<string, string> {
    return new Map([...this.watchers].map(([id, w]) => [id, w.watchDir] as const));
  }

  async closeAll(): Promise<void> {
    for (const w of this.watchers.values()) await w.close();
    this.watchers.clear();
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
