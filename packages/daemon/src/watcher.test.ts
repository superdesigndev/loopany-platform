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

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LOOPANY_DIR } from "./config.js";
import { buildManifest, flushLoop, INLINE_TOTAL_CAP, WatchManager, type HashCacheEntry, type SyncFetch } from "./watcher.js";

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
