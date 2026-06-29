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
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "chokidar";

import { logger } from "./logger.js";
import { LOOPANY_DIR } from "./config.js";

const log = logger.child({ mod: "watcher" });

/** Per-file byte cap. At/under ⇒ bytes sync; over ⇒ metadata-only (no bytes). */
const BLOB_CAP = 10 * 1024 * 1024; // 10MB
/** Inline small files in the sync POST (skip the PUT round-trip for the common case). */
const INLINE_CAP = 64 * 1024; // 64KB
/** Coalesce a burst of file events into a single sync push. */
const COALESCE_MS = Number(process.env.LOOPANY_SYNC_COALESCE_MS || 1500);
/** After a transient sync failure, re-arm one flush after this delay (no hot-loop). */
const RETRY_MS = Number(process.env.LOOPANY_SYNC_RETRY_MS || 5000);

/** One loop folder the server asked this machine to watch. */
export interface WatchSpec {
  loopId: string;
  workdir: string | null;
  taskFile: string | null;
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

function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
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

/** Resolve the folder to watch for a loop: the loop's own folder, then workdir,
 *  then the daemon scratch dir (mirrors runner.resolveWorkdir's fallbacks). */
function resolveWatchDir(spec: WatchSpec): string | null {
  if (spec.taskFile) {
    const tf = expandTilde(spec.taskFile);
    if (path.isAbsolute(tf)) return path.dirname(tf);
    if (spec.workdir) return path.dirname(path.resolve(expandTilde(spec.workdir), tf));
  }
  if (spec.workdir) return path.resolve(expandTilde(spec.workdir));
  return path.join(LOOPANY_DIR, "work", spec.loopId);
}

interface ManifestEntry {
  path: string;
  hash: string | null;
  size: number;
  binary: boolean;
  oversize: boolean;
}

/** Walk a loop folder into a full manifest + the bytes of each in-cap file. */
function buildManifest(dir: string): { entries: ManifestEntry[]; blobs: Map<string, Buffer> } {
  const entries: ManifestEntry[] = [];
  const blobs = new Map<string, Buffer>();
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
        entries.push({ path: childRel, hash: null, size: st.size, binary: false, oversize: true });
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
      entries.push({ path: childRel, hash, size: buf.length, binary: looksBinary(buf), oversize: false });
    }
  };
  walk(dir, "");
  return { entries, blobs };
}

/** Watches one loop folder and live-syncs it to the server. */
class LoopWatcher {
  private fsw: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private dirty = false;
  /** A transient sync failure asked for a delayed retry (idle folder self-heals). */
  private retry = false;
  /** Hashes we believe the server already has (skip re-inlining). */
  private synced = new Set<string>();
  private closed = false;

  constructor(
    private readonly loopId: string,
    private readonly dir: string,
    private readonly server: string,
    private readonly token: string,
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
    log.info({ loopId: this.loopId, dir: this.dir }, "watching loop folder");
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

  private async flush(): Promise<void> {
    if (this.closed) return;
    if (this.running) {
      this.dirty = true; // a flush is in flight — re-run once it's done
      return;
    }
    this.running = true;
    try {
      const { entries, blobs } = buildManifest(this.dir);
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

  private async postSync(body: unknown): Promise<{ needHashes?: string[] } | null> {
    try {
      const res = await fetch(`${this.server}/api/machine/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        log.warn({ loopId: this.loopId, status: res.status }, "sync non-ok");
        return null;
      }
      return (await res.json()) as { needHashes?: string[] };
    } catch (err) {
      log.warn({ loopId: this.loopId, err: msg(err) }, "sync request failed");
      return null;
    }
  }

  private async putBlob(hash: string, buf: Buffer): Promise<boolean> {
    try {
      const res = await fetch(`${this.server}/api/machine/blob/${hash}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(buf),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
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

  constructor(
    private readonly server: string,
    private readonly token: string,
  ) {}

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
    for (const [id, spec] of want) {
      if (this.watchers.has(id)) continue;
      const dir = resolveWatchDir(spec);
      if (!dir || !fs.existsSync(dir)) continue;
      const w = new LoopWatcher(id, dir, this.server, this.token);
      w.start();
      this.watchers.set(id, w);
    }
  }

  async closeAll(): Promise<void> {
    for (const w of this.watchers.values()) await w.close();
    this.watchers.clear();
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
