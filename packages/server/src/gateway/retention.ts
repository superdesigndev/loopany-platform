/**
 * Artifact-storage retention + garbage collection — the policy that keeps R2
 * (and the in-memory dev/test store) from growing monotonically.
 *
 * The artifact pipeline is content-addressed: blob BYTES are keyed by sha256 and
 * deduped across every loop/run. When a path is deleted or its content changes,
 * the OLD blob is no longer pointed at by the current file row — but nothing was
 * reclaiming it, so R2 grew forever. This module closes that gap with two pieces:
 *
 *   1. pruneSnapshots() — bound the per-loop run-snapshot history to a window, so
 *      old snapshots stop pinning the blobs they referenced for diffs.
 *   2. gcBlobs()        — delete blob bytes no LIVE row needs: a blob is collected
 *      only when NO artifact_files row AND NO retained run_snapshot references its
 *      hash. CORRECTNESS over aggressiveness — a still-referenced blob is never
 *      deleted; a leaked blob is only a cost bug the next pass reclaims.
 *
 * Concurrency: gcBlobs is safe to run alongside active syncs. Three guards combine —
 * a grace window (a blob whose metadata row is younger than the window is never
 * collected, so a blob a sync just wrote/referenced is untouchable), a point
 * re-check of each candidate immediately before its bytes are deleted (so a blob
 * re-referenced before we touch it keeps both its bytes and metadata), and a
 * bytes-before-metadata delete ordering: each candidate's bytes are reclaimed
 * FIRST, then its metadata row is dropped unconditionally — so blobExists() goes
 * false and any sync that re-references the hash (even one that raced the byte
 * delete) re-uploads the bytes (self-healing). We never leave a live blobs row
 * pointing at deleted bytes.
 */
import { logger } from "../logger.js";
import * as store from "../db/store.js";
import { blobGcGraceMs, snapshotRetention } from "../env.js";
import type { BlobStore } from "./blobstore.js";

const log = logger.child({ mod: "retention" });

export interface MaintainResult {
  snapshotsPruned: number;
  blobsReclaimed: number;
}

/**
 * Prune every loop's run snapshots down to the configured retention window
 * (most-recent-N). Returns the total number pruned. This is what makes an old
 * snapshot's now-unreferenced blobs collectable by gcBlobs().
 */
export function pruneSnapshots(keep: number = snapshotRetention()): number {
  let pruned = 0;
  for (const loopId of store.loopIdsWithSnapshots()) {
    pruned += store.pruneRunSnapshots(loopId, keep);
  }
  return pruned;
}

/**
 * Reclaim unreferenced blob bytes. Returns the number of blobs collected.
 *
 * Algorithm:
 *   1. Compute the live keep-set (all hashes any artifact_files row / retained
 *      snapshot references) and the grace-windowed candidate list — both reads are
 *      synchronous (interleave-free under the single-threaded event loop).
 *   2. Garbage = candidates not in the keep-set.
 *   3. For each garbage hash, in order:
 *      a. Pre-delete guard: if a sync re-referenced it since the keep-set was
 *         computed, skip it — leaving both its bytes AND metadata row intact
 *         (a consistent live blob, nothing to heal).
 *      b. Otherwise delete the BYTES (the await), then drop the metadata row
 *         UNCONDITIONALLY. Bytes-before-metadata is the data-loss fix: if a sync
 *         raced the byte delete (re-referencing the hash + recreating the blobs
 *         row mid-await), dropping the metadata still leaves blobExists()=false,
 *         so that file re-uploads its bytes on the next sync. We never leave a
 *         live blobs row pointing at deleted bytes.
 */
export async function gcBlobs(blobStore: BlobStore, graceMs: number = blobGcGraceMs()): Promise<number> {
  const refs = store.liveBlobRefs();
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  const candidates = store.blobHashesOlderThan(cutoff);
  const garbage = candidates.filter((h) => !refs.has(h));

  let reclaimed = 0;
  for (const hash of garbage) {
    // Pre-delete guard: re-referenced before we touched it → keep bytes + metadata.
    if (store.blobIsReferenced(hash)) continue;
    try {
      // Bytes first…
      await blobStore.delete(hash);
      // …then metadata, unconditionally. If a sync raced the await and re-referenced
      // the hash, dropping the (possibly sync-recreated) blobs row forces blobExists()
      // false so the bytes self-heal on the next sync; if not, this is plain cleanup.
      const raced = store.blobIsReferenced(hash);
      store.deleteBlob(hash);
      if (raced) {
        log.warn({ hash }, "gc: blob re-referenced mid-delete — dropped metadata to force re-upload");
      } else {
        reclaimed++;
      }
    } catch (err) {
      // A failed byte-delete leaves BOTH the bytes and the metadata row intact, so a
      // later pass simply retries — no live row ever points at deleted bytes.
      log.warn({ hash, err: err instanceof Error ? err.message : String(err) }, "gc: blob byte-delete failed");
    }
  }
  return reclaimed;
}

/**
 * One full storage-maintenance pass: prune snapshots, then GC the blobs they
 * freed (plus any already-unreferenced). Order matters — pruning first lets the
 * same pass reclaim the blobs it just unpinned. Idempotent and safe with no
 * garbage (returns zeros).
 */
export async function maintainStorage(blobStore: BlobStore): Promise<MaintainResult> {
  const snapshotsPruned = pruneSnapshots();
  const blobsReclaimed = await gcBlobs(blobStore);
  if (snapshotsPruned || blobsReclaimed) {
    log.info({ snapshotsPruned, blobsReclaimed }, "storage maintenance");
  }
  return { snapshotsPruned, blobsReclaimed };
}
