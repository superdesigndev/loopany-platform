/**
 * Artifact-storage retention / GC tests. The whole point is correctness over
 * aggressiveness: a still-referenced (shared, or snapshot-retained) blob must
 * NEVER be reclaimed, while a blob no live row needs IS reclaimed once nothing
 * pins it. Plus snapshot-window pruning and the per-loop storage cap.
 *
 * Runs entirely on the in-memory blob store + a throwaway SQLite DB (no R2, no
 * network), matching how prod's MemoryBlobStore fallback behaves.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

import { MemoryBlobStore } from "./blobstore.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let retention: typeof import("./retention.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-retention-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  retention = await import("./retention.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.sqlite.exec(
    "DELETE FROM run_snapshots; DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

afterEach(() => {
  delete process.env.LOOPANY_LOOP_BYTES_CAP;
});

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

const scheduler = {
  maybeFlagEvolve(): void {},
  finishEvolution(): void {},
  finishEdit(): void {},
  addLoop(): void {},
  removeLoop(): void {},
  runNow(): void {},
} as any;

function gatewayWithStore(): { gw: InstanceType<typeof gatewayMod.MachineGateway>; blobs: MemoryBlobStore } {
  const blobs = new MemoryBlobStore();
  return { gw: new gatewayMod.MachineGateway(scheduler, blobs), blobs };
}

function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  return { token, machineId, loop };
}

/** Store a blob (bytes + metadata) directly, as a sync would. */
async function putBlob(blobs: MemoryBlobStore, content: string): Promise<string> {
  const hash = sha256(content);
  await blobs.put(hash, Buffer.from(content));
  store.recordBlob(hash, content.length, false);
  return hash;
}

// A negative grace pushes the cutoff into the future so every just-written blob
// counts as "old enough" — letting these tests exercise collection without a wait.
const FORCE = -10_000;

test("GC keeps a blob still referenced by another live file (shared content)", async () => {
  const { loop } = seed();
  const { blobs } = gatewayWithStore();
  const hash = await putBlob(blobs, "shared bytes");

  // Two distinct paths point at the SAME content hash.
  store.upsertArtifactFile({ loopId: loop.id, path: "a.txt", hash, size: 11, binary: false, oversize: false, lastRunId: null });
  store.upsertArtifactFile({ loopId: loop.id, path: "b.txt", hash, size: 11, binary: false, oversize: false, lastRunId: null });

  // Delete one path → it tombstones, but the blob is still referenced by the other.
  store.tombstoneMissingArtifacts(loop.id, ["a.txt"], null);

  const reclaimed = await retention.gcBlobs(blobs, FORCE);
  expect(reclaimed).toBe(0);
  expect(await blobs.has(hash)).toBe(true);
  expect(store.blobExists(hash)).toBe(true);
});

test("GC keeps a blob a retained snapshot still references, then reclaims it once pruned", async () => {
  const { loop, machineId } = seed();
  const { blobs } = gatewayWithStore();
  const hash = await putBlob(blobs, "report v1");

  // The blob was a live file, captured into a run snapshot, then the file deleted.
  store.upsertArtifactFile({ loopId: loop.id, path: "report.md", hash, size: 9, binary: false, oversize: false, lastRunId: null });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: new Date().toISOString() });
  store.putRunSnapshot(run.id, loop.id, { "report.md": { hash, size: 9, binary: false, oversize: false } });
  store.tombstoneMissingArtifacts(loop.id, [], null); // path gone from live set

  // No live artifact_files row references it now — but the snapshot does, so KEEP.
  const r1 = await retention.gcBlobs(blobs, FORCE);
  expect(r1).toBe(0);
  expect(await blobs.has(hash)).toBe(true);

  // Prune the snapshot (window of 0) → nothing references the hash anymore → reclaim.
  expect(store.pruneRunSnapshots(loop.id, 0)).toBe(1);
  const r2 = await retention.gcBlobs(blobs, FORCE);
  expect(r2).toBe(1);
  expect(await blobs.has(hash)).toBe(false);
  expect(store.blobExists(hash)).toBe(false);
});

test("the grace window protects freshly-written (unreferenced) blobs", async () => {
  const { blobs } = gatewayWithStore();
  const hash = await putBlob(blobs, "just written, not yet referenced");

  // Default-ish grace (1h): a brand-new unreferenced blob is NOT collected — it may
  // be a blob a concurrent sync is about to reference.
  const kept = await retention.gcBlobs(blobs, 60 * 60 * 1000);
  expect(kept).toBe(0);
  expect(await blobs.has(hash)).toBe(true);

  // With the grace effectively elapsed, the same unreferenced blob IS reclaimed.
  const reclaimed = await retention.gcBlobs(blobs, FORCE);
  expect(reclaimed).toBe(1);
  expect(await blobs.has(hash)).toBe(false);
});

test("GC deletes bytes before metadata: a blob re-referenced mid-delete drops metadata to self-heal", async () => {
  const { loop } = seed();
  const base = new MemoryBlobStore();
  const content = "racy bytes";
  const hash = sha256(content);
  await base.put(hash, Buffer.from(content));
  store.recordBlob(hash, content.length, false);
  // No live row references it at pass start → it's garbage.

  // A BlobStore whose delete() simulates a concurrent sync racing the byte delete:
  // it re-references the hash (live file row + recreated blobs metadata) DURING the
  // await — the exact TOCTOU window the bytes-before-metadata ordering must survive.
  const racing = {
    has: (h: string) => base.has(h),
    put: (h: string, b: Buffer) => base.put(h, b),
    get: (h: string) => base.get(h),
    async delete(h: string): Promise<void> {
      if (h === hash) {
        store.upsertArtifactFile({ loopId: loop.id, path: "racer.txt", hash, size: content.length, binary: false, oversize: false, lastRunId: null });
        store.recordBlob(hash, content.length, false);
      }
      return base.delete(h);
    },
  };

  const reclaimed = await retention.gcBlobs(racing, FORCE);
  // The bytes were reclaimed (counted), AND the metadata row is dropped
  // unconditionally so blobExists()=false — the live row re-uploads on the next sync
  // (self-heal). The invariant: never a live blobs row left pointing at deleted bytes.
  expect(reclaimed).toBe(1);
  expect(await base.has(hash)).toBe(false);
  expect(store.blobExists(hash)).toBe(false);
  expect(store.getArtifactFile(loop.id, "racer.txt")!.deleted).toBe(false);
});

test("putBlob enforces the per-loop cap against the REAL byte length (sync under-reported the size)", async () => {
  process.env.LOOPANY_LOOP_BYTES_CAP = "100";
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();

  const big = "z".repeat(200); // real bytes exceed the 100B cap…
  const hbig = sha256(big);

  // …but the sync under-reports the size (10B) for a NON-inline file, so it slips
  // past sync's projected-footprint check and lands in needHashes (no bytes yet).
  const s = await gw.sync(token, { loopId: loop.id, manifest: [{ path: "big.bin", hash: hbig, size: 10 }] });
  expect(s.status).toBe(200);
  expect((s.body as any).needHashes).toContain(hbig);
  expect(store.getArtifactFile(loop.id, "big.bin")).toBeDefined();

  // The daemon then PUTs the real (over-cap) bytes → refused at putBlob, with the
  // dangling row dropped so nothing points at a blob the server won't store.
  const p = await gw.putBlob(token, hbig, Buffer.from(big));
  expect(p.status).toBe(413);
  expect((p.body as any).capExceeded).toBe(true);
  expect(await blobs.has(hbig)).toBe(false);
  expect(store.blobExists(hbig)).toBe(false);
  expect(store.getArtifactFile(loop.id, "big.bin")).toBeUndefined();
});

test("putBlob stores a NEW blob that fits the per-loop cap (honest path not falsely rejected)", async () => {
  process.env.LOOPANY_LOOP_BYTES_CAP = "1000";
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();

  const data = "y".repeat(200);
  const h = sha256(data);
  const s = await gw.sync(token, { loopId: loop.id, manifest: [{ path: "f.bin", hash: h, size: data.length }] });
  expect((s.body as any).needHashes).toContain(h);

  const p = await gw.putBlob(token, h, Buffer.from(data));
  expect(p.status).toBe(200);
  expect(await blobs.has(h)).toBe(true);
  expect(store.blobExists(h)).toBe(true);
});

test("snapshot retention prunes the oldest beyond the window, keeps the newest N", async () => {
  const { loop, machineId } = seed();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: new Date().toISOString() });
    store.putRunSnapshot(run.id, loop.id, {});
    ids.push(run.id);
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt for deterministic ordering
  }

  // Keep the 2 most recent → 3 oldest pruned.
  const pruned = store.pruneRunSnapshots(loop.id, 2);
  expect(pruned).toBe(3);
  // Oldest three gone, newest two survive.
  expect(store.getRunSnapshot(ids[0]!)).toBeUndefined();
  expect(store.getRunSnapshot(ids[2]!)).toBeUndefined();
  expect(store.getRunSnapshot(ids[3]!)).toBeDefined();
  expect(store.getRunSnapshot(ids[4]!)).toBeDefined();

  // Idempotent: pruning again at the same window removes nothing.
  expect(store.pruneRunSnapshots(loop.id, 2)).toBe(0);
});

test("pruneSnapshots applies the window across every loop", async () => {
  const { machineId } = seed();
  const l2 = store.createLoop({ userId: "u1", machineId, name: "L2", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  for (const loopId of [l2.id]) {
    for (let i = 0; i < 4; i++) {
      const run = store.addRun({ loopId, userId: "u1", machineId, phase: "done", role: "exec", ts: new Date().toISOString() });
      store.putRunSnapshot(run.id, loopId, {});
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  expect(retention.pruneSnapshots(1)).toBe(3);
});

test("per-loop cap blocks new bytes past the limit and surfaces it", async () => {
  process.env.LOOPANY_LOOP_BYTES_CAP = "100"; // tiny cap for the test
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();

  const a = "a".repeat(60);
  const b = "b".repeat(60);
  const ha = sha256(a);
  const hb = sha256(b);

  // First file (60B) fits under the 100B cap → stored.
  const r1 = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "a.txt", hash: ha, size: a.length }],
    blobs: [{ hash: ha, encoding: "utf8", data: a }],
  });
  expect(r1.status).toBe(200);
  expect((r1.body as any).capExceeded).toBeUndefined();
  expect(await blobs.has(ha)).toBe(true);

  // Second file (another 60B) would push the loop to 120B > 100B cap → rejected.
  const r2 = await gw.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "a.txt", hash: ha, size: a.length },
      { path: "b.txt", hash: hb, size: b.length },
    ],
    blobs: [{ hash: hb, encoding: "utf8", data: b }],
  });
  expect(r2.status).toBe(200);
  expect((r2.body as any).capExceeded).toBe(true);
  expect((r2.body as any).rejected).toEqual(["b.txt"]);
  // The rejected file's bytes were NOT stored and it's not in the live set…
  expect(await blobs.has(hb)).toBe(false);
  expect(store.getArtifactFile(loop.id, "b.txt")).toBeUndefined();
  // …but the already-accepted file is untouched (loop not wedged).
  expect(store.getArtifactFile(loop.id, "a.txt")!.hash).toBe(ha);
});

test("reusing an already-stored hash adds no bytes, so it's allowed even at the cap", async () => {
  process.env.LOOPANY_LOOP_BYTES_CAP = "100";
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();
  const a = "a".repeat(60);
  const ha = sha256(a);

  await gw.sync(token, { loopId: loop.id, manifest: [{ path: "a.txt", hash: ha, size: a.length }], blobs: [{ hash: ha, encoding: "utf8", data: a }] });

  // A second path with the SAME content (dedup ⇒ zero new bytes) is accepted.
  const r = await gw.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "a.txt", hash: ha, size: a.length },
      { path: "copy.txt", hash: ha, size: a.length },
    ],
  });
  expect((r.body as any).capExceeded).toBeUndefined();
  expect(store.getArtifactFile(loop.id, "copy.txt")!.hash).toBe(ha);
  expect(await blobs.has(ha)).toBe(true);
});

test("the per-loop cap counts only NET growth, not in-place overwrites", async () => {
  process.env.LOOPANY_LOOP_BYTES_CAP = "100";
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();

  // v1 (80B) fits under the 100B cap → stored.
  const v1 = "a".repeat(80);
  const hv1 = sha256(v1);
  const r1 = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "report.md", hash: hv1, size: v1.length }],
    blobs: [{ hash: hv1, encoding: "utf8", data: v1 }],
  });
  expect((r1.body as any).capExceeded).toBeUndefined();
  expect(await blobs.has(hv1)).toBe(true);

  // Regenerate the SAME path with new 80B content. The upsert FREES v1's bytes, so
  // the post-sync footprint stays 80B — it must be accepted, NOT double-counted to
  // 160B and falsely rejected (the running-memory model: a large file updated in place).
  const v2 = "b".repeat(80);
  const hv2 = sha256(v2);
  const r2 = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "report.md", hash: hv2, size: v2.length }],
    blobs: [{ hash: hv2, encoding: "utf8", data: v2 }],
  });
  expect((r2.body as any).capExceeded).toBeUndefined();
  expect(store.getArtifactFile(loop.id, "report.md")!.hash).toBe(hv2);
  expect(await blobs.has(hv2)).toBe(true);
});

test("pruneRunSnapshots handles a large backlog without a per-victim bound-variable explosion", async () => {
  const { loop, machineId } = seed();
  const N = 1200;
  for (let i = 0; i < N; i++) {
    const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: new Date().toISOString() });
    store.putRunSnapshot(run.id, loop.id, {});
  }
  // Prune to the window in ONE statement — the delete binds only the survivors (≤20),
  // not 1180 victim ids, so a pre-feature backlog can't trip SQLite's variable limit.
  expect(store.pruneRunSnapshots(loop.id, 20)).toBe(N - 20);
  expect(store.pruneRunSnapshots(loop.id, 20)).toBe(0);
});

test("GC spares a blob a snapshot comes to reference MID-PASS (per-candidate snapshot guard)", async () => {
  const { loop, machineId } = seed();
  const base = new MemoryBlobStore();
  const c1 = "first garbage";
  const c2 = "second garbage";
  const h1 = sha256(c1);
  const h2 = sha256(c2);
  await base.put(h1, Buffer.from(c1));
  store.recordBlob(h1, c1.length, false);
  await base.put(h2, Buffer.from(c2));
  store.recordBlob(h2, c2.length, false);
  // Neither is referenced at pass start → both are garbage in the keep-set computed then.
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: new Date().toISOString() });

  // While the FIRST garbage blob's bytes are being deleted, a report() captures the
  // SECOND garbage hash into a retained snapshot — the GC-check-time race that the
  // artifact_files-only guard would miss, wrongly collecting h2's still-needed bytes.
  const racing = {
    has: (h: string) => base.has(h),
    put: (h: string, b: Buffer) => base.put(h, b),
    get: (h: string) => base.get(h),
    async delete(h: string): Promise<void> {
      if (h === h1) {
        store.putRunSnapshot(run.id, loop.id, { "report.md": { hash: h2, size: c2.length, binary: false, oversize: false } });
      }
      return base.delete(h);
    },
  };

  const reclaimed = await retention.gcBlobs(racing, FORCE);
  // h1 collected; h2 SPARED because the per-candidate guard now also consults snapshots.
  expect(reclaimed).toBe(1);
  expect(await base.has(h1)).toBe(false);
  expect(store.blobExists(h1)).toBe(false);
  expect(await base.has(h2)).toBe(true);
  expect(store.blobExists(h2)).toBe(true);
});

test("per-loop cap base uses VERIFIED blob bytes, not the client-reported size", async () => {
  process.env.LOOPANY_LOOP_BYTES_CAP = "100";
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();

  // Sync 1: an 80B file whose size the daemon UNDER-reports as 10B. Inline bytes are
  // authoritative, so the blob is recorded at its real 80B while the artifact_files
  // row keeps the under-reported 10B.
  const a = "a".repeat(80);
  const ha = sha256(a);
  await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "a.txt", hash: ha, size: 10 }],
    blobs: [{ hash: ha, encoding: "utf8", data: a }],
  });
  expect(await blobs.has(ha)).toBe(true);
  // The cap base reflects the REAL 80B (blobs.size), not the reported 10B — so an
  // under-reporting daemon can't keep the base artificially low.
  expect(store.loopStoredBytes(loop.id)).toBe(80);

  // Sync 2: a NEW 80B file, again under-reported (10B), slips past sync's projected
  // check (80 base + 10 reported = 90 ≤ 100) and lands in needHashes (no bytes yet).
  const b = "b".repeat(80);
  const hb = sha256(b);
  const s = await gw.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "a.txt", hash: ha, size: 10 },
      { path: "b.txt", hash: hb, size: 10 },
    ],
  });
  expect((s.body as any).needHashes).toContain(hb);

  // putBlob measures the real 80B against the AUTHORITATIVE base (a.txt's verified
  // 80B), so 80 + 80 = 160 > 100 → refused. A reported-size base (10B) would have let
  // the loop creep past the cap one under-reported blob at a time.
  const p = await gw.putBlob(token, hb, Buffer.from(b));
  expect(p.status).toBe(413);
  expect((p.body as any).capExceeded).toBe(true);
  expect(await blobs.has(hb)).toBe(false);
  expect(store.blobExists(hb)).toBe(false);
});

test("maintainStorage skips a concurrent pass while one is already running (in-flight guard)", async () => {
  // One garbage blob with the grace forced open so gcBlobs awaits its byte delete.
  process.env.LOOPANY_BLOB_GC_GRACE_MS = "1";
  const base = new MemoryBlobStore();
  const content = "garbage bytes";
  const hash = sha256(content);
  await base.put(hash, Buffer.from(content));
  store.recordBlob(hash, content.length, false);
  await new Promise((r) => setTimeout(r, 5)); // elapse the 1ms grace

  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let deletes = 0;
  const blocking = {
    has: (h: string) => base.has(h),
    put: (h: string, b: Buffer) => base.put(h, b),
    get: (h: string) => base.get(h),
    async delete(h: string): Promise<void> {
      deletes++;
      await gate; // hold the FIRST pass inside its delete await
      return base.delete(h);
    },
  };
  const gw = new gatewayMod.MachineGateway(scheduler, blocking as any);

  try {
    const p1 = gw.maintainStorage(); // enters and blocks in delete()
    await new Promise((r) => setTimeout(r, 5));
    // A second tick fired while the first is in-flight must SKIP, not run a second
    // pass concurrently (which would re-scan + race the same deletes).
    const r2 = await gw.maintainStorage();
    expect(r2).toEqual({ snapshotsPruned: 0, blobsReclaimed: 0 });
    expect(deletes).toBe(1); // only the first pass attempted a delete

    release();
    const r1 = await p1;
    expect(r1.blobsReclaimed).toBe(1);
    expect(await base.has(hash)).toBe(false);
    // After it settles the latch is released → a fresh pass runs normally again.
    const r3 = await gw.maintainStorage();
    expect(r3).toEqual({ snapshotsPruned: 0, blobsReclaimed: 0 });
  } finally {
    delete process.env.LOOPANY_BLOB_GC_GRACE_MS;
  }
});

test("maintainStorage is idempotent and safe with no garbage", async () => {
  const { gw } = gatewayWithStore();
  const r1 = await gw.maintainStorage();
  expect(r1).toEqual({ snapshotsPruned: 0, blobsReclaimed: 0 });
  const r2 = await gw.maintainStorage();
  expect(r2).toEqual({ snapshotsPruned: 0, blobsReclaimed: 0 });
});

test("maintainStorage prunes snapshots then reclaims the blobs they freed", async () => {
  const { loop, machineId } = seed();
  const { gw, blobs } = gatewayWithStore();

  // Two runs, each snapshotting its own (now unreferenced — no live file) blob.
  const old = await putBlob(blobs, "old run content");
  const recent = await putBlob(blobs, "recent run content");
  const r1 = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: new Date().toISOString() });
  store.putRunSnapshot(r1.id, loop.id, { "f.md": { hash: old, size: 15, binary: false, oversize: false } });
  await new Promise((r) => setTimeout(r, 5));
  const r2 = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: new Date().toISOString() });
  store.putRunSnapshot(r2.id, loop.id, { "f.md": { hash: recent, size: 18, binary: false, oversize: false } });

  // Window of 1: prune the older snapshot → its blob `old` becomes collectable.
  // (Use a forced grace via the lower-level call after pruning, since maintainStorage
  // uses the configured grace; here we drive the env knob to elapse the window.)
  process.env.LOOPANY_BLOB_GC_GRACE_MS = "1"; // ~immediate
  process.env.LOOPANY_SNAPSHOT_RETENTION = "1";
  await new Promise((r) => setTimeout(r, 5));
  try {
    const res = await gw.maintainStorage();
    expect(res.snapshotsPruned).toBe(1);
    expect(res.blobsReclaimed).toBe(1);
    expect(await blobs.has(old)).toBe(false); // freed
    expect(await blobs.has(recent)).toBe(true); // still snapshot-referenced
  } finally {
    delete process.env.LOOPANY_BLOB_GC_GRACE_MS;
    delete process.env.LOOPANY_SNAPSHOT_RETENTION;
  }
});
