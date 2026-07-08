/**
 * Watcher tests, three layers:
 *  1. WatchManager.reconcile — the LOCAL roots jail: workdir/taskFile in the
 *     watch specs are SERVER-SENT, so when LOOPANY_ROOTS is set a folder outside
 *     it is never watched (and therefore never synced out). No network is hit:
 *     watchers are closed before their debounced first flush fires.
 *  2. buildManifest — the incremental stat cache: an unchanged file's hash is
 *     served from the cache without reading bytes; the racy-write guard forces a
 *     re-hash when the entry was hashed too close to the file's mtime.
 *  3. The flush pipeline against an injected in-memory sync server (fetchImpl
 *     seam): first-flush inline suppression, the aggregate inline budget, the
 *     digest skip (no POST when nothing changed), and byte-for-byte convergence
 *     of the server's store.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LOOPANY_DIR } from "./config.js";
import { buildManifest, capManifest, flushLoop, INLINE_TOTAL_CAP, WatchManager, type HashCacheEntry, type SyncFetch } from "./watcher.js";

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

let root: string;
let mgr: WatchManager | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-watch-"));
});
afterEach(async () => {
  await mgr?.closeAll();
  mgr = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("WatchManager.reconcile — local roots jail", () => {
  test("with no local roots every existing folder is watched (unchanged default)", () => {
    const a = path.join(root, "a");
    fs.mkdirSync(a);
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x");
    mgr.reconcile([{ loopId: "l1", workdir: a, taskFile: null }]);
    expect(mgr.watchedDirs().get("l1")).toBe(a);
  });

  test("a folder outside LOOPANY_ROOTS is never watched; one inside is", () => {
    const jail = path.join(root, "jail");
    const inside = path.join(jail, "loop");
    const outside = path.join(root, "outside");
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [jail]);
    mgr.reconcile([
      { loopId: "in", workdir: inside, taskFile: null },
      { loopId: "out", workdir: outside, taskFile: null },
    ]);
    expect(mgr.watchedDirs().get("in")).toBe(inside);
    expect(mgr.watchedDirs().has("out")).toBe(false);
  });

  test("a server-sent taskFile outside the jail is confined too (dirname(taskFile) wins the resolution)", () => {
    const jail = path.join(root, "jail");
    const inside = path.join(jail, "loop");
    const outside = path.join(root, "outside");
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [jail]);
    // workdir looks innocent, but the absolute taskFile drags the watch dir out of jail.
    mgr.reconcile([{ loopId: "sneaky", workdir: inside, taskFile: path.join(outside, "README.md") }]);
    expect(mgr.watchedDirs().has("sneaky")).toBe(false);
  });

  test("a taskFile with unresolved `..` cannot escape the jail via the lexical prefix (traversal)", () => {
    const jail = path.join(root, "jail");
    const outside = path.join(root, "outside");
    fs.mkdirSync(jail, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [jail]);
    // Lexically under the jail ("/…/jail/../outside/…"), but resolving OUTSIDE it —
    // a raw startsWith prefix check would admit this and watch/sync the real folder.
    mgr.reconcile([{ loopId: "traversal", workdir: null, taskFile: `${jail}/../outside/README.md` }]);
    expect(mgr.watchedDirs().has("traversal")).toBe(false);
  });

  test("the daemon-owned scratch dir stays allowed under a jail (its location is local, not server-chosen)", () => {
    const scratchLoop = `watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const scratchDir = path.join(LOOPANY_DIR, "work", scratchLoop);
    fs.mkdirSync(scratchDir, { recursive: true });
    try {
      mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [path.join(root, "jail")]);
      // No workdir/taskFile → resolveLoopDir falls back to the per-loop scratch dir.
      mgr.reconcile([{ loopId: scratchLoop, workdir: null, taskFile: null }]);
      expect(mgr.watchedDirs().get(scratchLoop)).toBe(scratchDir);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("buildManifest — incremental stat cache", () => {
  test("an unchanged file's hash is served from the cache without reading bytes", async () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "hello");
    const st = fs.statSync(file);
    // Craft a trusted cache entry with a SENTINEL hash: matching stats + a hash
    // time safely past the racy window. If buildManifest returns the sentinel,
    // it provably served the cache and never opened the file.
    const sentinel = "f".repeat(64);
    const cache = new Map<string, HashCacheEntry>([
      ["a.txt", { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, hash: sentinel, binary: false, hashedAt: st.mtimeMs + 60_000 }],
    ]);
    const b = await buildManifest(root, cache);
    expect(b.entries).toEqual([{ path: "a.txt", hash: sentinel, size: 5, binary: false, oversize: false }]);
    expect(b.cache.get("a.txt")?.hash).toBe(sentinel); // entry carries forward
  });

  test("the racy-write guard re-hashes an entry hashed too close to the file's mtime", async () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "hello");
    const st = fs.statSync(file);
    // Same stats, but hashedAt sits INSIDE the racy window (< mtime + RACY_MS):
    // a same-size rewrite within coarse mtime granularity could hide behind this
    // entry, so it must be distrusted and the real bytes re-hashed.
    const cache = new Map<string, HashCacheEntry>([
      ["a.txt", { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, hash: "f".repeat(64), binary: false, hashedAt: st.mtimeMs + 1000 }],
    ]);
    const b = await buildManifest(root, cache);
    expect(b.entries[0]?.hash).toBe(sha256(Buffer.from("hello")));
  });

  test("a changed file re-hashes; a deleted file drops out of entries and cache", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    fs.writeFileSync(a, "one");
    fs.writeFileSync(b, "two");
    const first = await buildManifest(root);
    expect(first.entries).toHaveLength(2);

    fs.writeFileSync(a, "one-changed");
    fs.rmSync(b);
    const second = await buildManifest(root, first.cache);
    expect(second.entries).toEqual([
      { path: "a.txt", hash: sha256(Buffer.from("one-changed")), size: 11, binary: false, oversize: false },
    ]);
    expect(second.cache.has("b.txt")).toBe(false);
  });

  test("never-syncable dirs (.worktrees, node_modules, .git, caches) are excluded — a repo/worktree dropped in the loop folder never floods the manifest", async () => {
    fs.writeFileSync(path.join(root, "report.md"), "content");
    for (const d of [".worktrees", "node_modules", ".git", ".cache", "__pycache__", ".venv"]) {
      const sub = path.join(root, d, "deep");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, "junk.js"), "junk");
    }
    const b = await buildManifest(root);
    expect(b.entries.map((e) => e.path)).toEqual(["report.md"]);
  });
});

describe("capManifest — per-loop sync caps", () => {
  const entry = (p: string, size: number) => ({ path: p, hash: sha256(Buffer.from(p)), size, binary: false, oversize: false });
  const oversize = (p: string, size: number) => ({ path: p, hash: null, size, binary: false, oversize: true });

  test("under both caps the manifest is returned untouched (zero-cost common case)", () => {
    const entries = [entry("a", 10), entry("b", 20)];
    const r = capManifest(entries, 100, 1000);
    expect(r.breached).toBe(false);
    expect(r.kept).toBe(entries); // same reference — un-capped behavior is byte-identical
    expect(r.droppedFiles).toBe(0);
  });

  test("over the file-count cap keeps the smallest files (the run's real content) and drops the overflow", () => {
    const entries = [entry("big", 5000), entry("report.md", 10), entry("state.json", 20), entry("mid", 3000)];
    const r = capManifest(entries, 2, 1_000_000);
    expect(r.breached).toBe(true);
    expect(r.droppedFiles).toBe(2);
    expect(r.kept.map((e) => e.path).sort()).toEqual(["report.md", "state.json"]);
  });

  test("over the byte cap sheds the large files while the small content still fits", () => {
    const entries = [entry("report.md", 100), entry("huge", 10_000), entry("state.json", 200)];
    const r = capManifest(entries, 100, 1000); // 1000-byte budget
    expect(r.breached).toBe(true);
    expect(r.kept.map((e) => e.path).sort()).toEqual(["report.md", "state.json"]);
    expect(r.keptBytes).toBe(300);
  });

  test("top-level content is kept over a deeper flood of even-smaller files (depth beats size — the content home survives)", () => {
    // The real content (report.md, 200 bytes) lives at the top; a flood of tiny
    // 1-byte files nests in a checkout subdir. Pure smallest-first would evict
    // report.md; depth-first keeps it.
    const flood = Array.from({ length: 20 }, (_, i) => entry(`checkout/src/f${i}.js`, 1));
    const r = capManifest([entry("report.md", 200), ...flood], 3, 1_000_000);
    expect(r.breached).toBe(true);
    expect(r.kept.map((e) => e.path)).toContain("report.md");
  });

  test("an oversize (metadata-only) entry is byte-cap-exempt but still counts toward the file-count cap", () => {
    // A single legitimate huge artifact (500MB) syncs as metadata only — zero bytes
    // transferred — so it must NOT trip the byte cap alongside normal small content.
    const entries = [oversize("big.zip", 500 * 1024 * 1024), entry("report.md", 100), entry("state.json", 200)];
    const r = capManifest(entries, 100, 1000); // 1000-byte budget, well under 500MB
    expect(r.breached).toBe(false);
    expect(r.kept).toBe(entries); // untouched — byte tally excludes the oversize entry
    expect(r.totalBytes).toBe(300);

    // ...but a genuine file-count flood still trips even when the overflow is oversize.
    const flood = Array.from({ length: 20 }, (_, i) => oversize(`checkout/f${i}.zip`, 500 * 1024 * 1024));
    const capped = capManifest([entry("report.md", 100), ...flood], 3, 1_000_000);
    expect(capped.breached).toBe(true);
    expect(capped.kept.map((e) => e.path)).toContain("report.md");
    expect(capped.kept).toHaveLength(3);
    expect(capped.keptBytes).toBe(100); // oversize kept entries add nothing to keptBytes
  });

  test("selection is deterministic across calls (same files stay dropped — no add/delete churn between flushes)", () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`f${i}`, 100 - i));
    const a = capManifest(entries, 10, 1_000_000);
    const b = capManifest(entries, 10, 1_000_000);
    expect(a.kept.map((e) => e.path)).toEqual(b.kept.map((e) => e.path));
    expect(a.kept).toHaveLength(10);
  });
});

// ---- flush pipeline against an injected in-memory sync server ----

/** In-memory /api/machine/sync + /api/machine/blob/:hash, via the fetchImpl seam. */
function fakeSyncServer() {
  const store = new Map<string, Buffer>();
  const syncs: Array<{ manifest: Array<{ path: string; hash: string | null }>; blobs: Array<{ hash: string; data: string }> }> = [];
  const fetchImpl: SyncFetch = async (url, init) => {
    if (init.method === "POST" && url.endsWith("/api/machine/sync")) {
      const body = JSON.parse(String(init.body));
      syncs.push(body);
      for (const b of body.blobs ?? []) store.set(b.hash, Buffer.from(b.data, "base64"));
      const need = [...new Set((body.manifest ?? []).map((e: { hash: string | null }) => e.hash).filter((h: string | null) => h && !store.has(h)))];
      return new Response(JSON.stringify({ needHashes: need }), { status: 200 });
    }
    const putMatch = init.method === "PUT" && url.match(/\/api\/machine\/blob\/([0-9a-f]{64})$/);
    if (putMatch) {
      store.set(putMatch[1], Buffer.from(init.body as Uint8Array));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { store, syncs, fetchImpl };
}

describe("LoopWatcher flush pipeline (injected sync server)", () => {
  test("first flush inlines nothing (PUT path only); a later small edit inlines exactly the changed blob; an unchanged rebuild skips the POST", async () => {
    const dir = path.join(root, "loop");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.md"), "alpha");
    fs.writeFileSync(path.join(dir, "b.md"), "beta");

    const srv = fakeSyncServer();
    mgr = new WatchManager("https://srv.test", "dk_x", [], srv.fetchImpl);
    mgr.reconcile([{ loopId: "l1", workdir: dir, taskFile: null }]);

    // First flush: initial reconciliation — no inline (the server may already
    // have everything after a daemon restart), bytes travel via needHashes→PUT.
    await flushLoop("l1");
    expect(srv.syncs).toHaveLength(1);
    expect(srv.syncs[0].blobs).toHaveLength(0);
    expect(srv.store.get(sha256(Buffer.from("alpha")))?.toString()).toBe("alpha");
    expect(srv.store.get(sha256(Buffer.from("beta")))?.toString()).toBe("beta");

    // Small edit: only the changed file is inlined (b.md's hash is in `synced`).
    fs.writeFileSync(path.join(dir, "a.md"), "alpha-2");
    await flushLoop("l1");
    expect(srv.syncs).toHaveLength(2);
    expect(srv.syncs[1].blobs.map((b) => b.hash)).toEqual([sha256(Buffer.from("alpha-2"))]);
    expect(srv.store.get(sha256(Buffer.from("alpha-2")))?.toString()).toBe("alpha-2");

    // Nothing changed since the acked sync: the digest matches → no POST at all.
    await flushLoop("l1");
    expect(srv.syncs).toHaveLength(2);
  });

  test("a burst of small files respects the aggregate inline budget; overflow converges via PUT", async () => {
    const dir = path.join(root, "loop");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "seed.md"), "seed");

    const srv = fakeSyncServer();
    mgr = new WatchManager("https://srv.test", "dk_x", [], srv.fetchImpl);
    mgr.reconcile([{ loopId: "l1", workdir: dir, taskFile: null }]);
    await flushLoop("l1"); // negotiate (first flush)

    // 20 × 64KB of unique content = 1.25MB — over the 1MB inline budget.
    const files = Array.from({ length: 20 }, (_, i) => Buffer.alloc(64 * 1024, `file-${i}:`));
    files.forEach((buf, i) => fs.writeFileSync(path.join(dir, `f${i}.bin`), buf));
    await flushLoop("l1");

    // No single POST may carry more raw inline bytes than the budget…
    for (const s of srv.syncs) {
      const rawBytes = s.blobs.reduce((n, b) => n + Buffer.from(b.data, "base64").length, 0);
      expect(rawBytes).toBeLessThanOrEqual(INLINE_TOTAL_CAP);
    }
    // …yet every byte still converges (the overflow took the PUT path).
    for (const buf of files) expect(srv.store.get(sha256(buf))?.equals(buf)).toBe(true);
  });
});

describe("LoopWatcher sync caps — graceful degradation of a flooded loop folder", () => {
  test("over the file-count cap: the smallest real-content files keep syncing, the bulk work product is dropped, and the sync converges in ONE bounded POST (no doomed retry)", async () => {
    // Re-import with a tiny cap so the test doesn't need thousands of files. The
    // caps are read at module load (like the transient-retry consts), so a fresh
    // module instance picks up the env — the static-import tests are unaffected.
    vi.resetModules();
    process.env.LOOPANY_SYNC_MAX_FILES = "3";
    const w = await import("./watcher.js");
    try {
      const dir = path.join(root, "loop");
      fs.mkdirSync(dir);
      // The loop's real content: two tiny files a run legitimately writes.
      fs.writeFileSync(path.join(dir, "report.md"), "r");
      fs.writeFileSync(path.join(dir, "state.json"), "s");
      // A run misbehaved and dropped a repo-checkout-like tree into the folder.
      const checkout = path.join(dir, "checkout");
      fs.mkdirSync(checkout);
      for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(checkout, `f${i}.js`), Buffer.alloc(1000, `x${i}`));

      const srv = fakeSyncServer();
      const m = new w.WatchManager("https://srv.test", "dk_x", [], srv.fetchImpl);
      m.reconcile([{ loopId: "l1", workdir: dir, taskFile: null }]);
      await w.flushLoop("l1");
      await m.closeAll();

      // Exactly ONE bounded sync POST — never a doomed giant that 413s and hot-retries.
      expect(srv.syncs).toHaveLength(1);
      const synced = srv.syncs[0].manifest.map((e) => e.path);
      expect(synced).toHaveLength(3); // capped at MAX_SYNC_FILES
      // The two tiny real-content files are the smallest → always kept and synced.
      expect(synced).toContain("report.md");
      expect(synced).toContain("state.json");
      expect(srv.store.get(sha256(Buffer.from("r")))?.toString()).toBe("r");
      expect(srv.store.get(sha256(Buffer.from("s")))?.toString()).toBe("s");
      // The bulk checkout is shed (only the single file that fit under the cap remains).
      expect(synced.filter((p) => p.startsWith("checkout/"))).toHaveLength(1);
    } finally {
      delete process.env.LOOPANY_SYNC_MAX_FILES;
      vi.resetModules();
    }
  });
});
