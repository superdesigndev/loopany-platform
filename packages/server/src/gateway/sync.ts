/**
 * Artifact sync - the byte-ingress half of the machine gateway, split out of
 * `MachineGateway` (which keeps poll/report/CLI/retention). Same wire surface,
 * framework-agnostic like the rest of the gateway (`{ status, body }` results):
 *
 *   POST /api/machine/sync        (Bearer device token) → manifest reconcile
 *   PUT  /api/machine/blob/:hash  (Bearer device token) → negotiated blob upload
 *
 * plus `readBlob` (the download seam the artifact/diff readers resolve bytes
 * through). Boot constructs ONE BlobStore and hands the SAME instance to this
 * class and to `MachineGateway` (whose `maintainStorage` GC deletes the bytes
 * written here).
 */
import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { Loop } from "../db/schema.js";
import { createBlobStore, type BlobStore } from "./blobstore.js";
import { BLOB_CAP, isIgnoredPath, isValidHash, looksBinary, safeRelPath, sha256Buf } from "./artifacts.js";
import { artifactMeta } from "../server/frontmatter.js";
import { pickTaskPath } from "../lib/fileEntries.js";
import { loopBytesCap } from "../env.js";
import { machineIdFromToken } from "./tokens.js";
import { clipText, nowIso, WIRE_TEXT_CAP, type HttpResult } from "./http.js";

// Same `mod` tag as the rest of the gateway - these log lines predate the split.
const log = logger.child({ mod: "gateway" });

export class ArtifactSync {
  constructor(
    /** Artifact blob byte store (R2 in prod; injectable in-memory store for tests). */
    private readonly blobStore: BlobStore = createBlobStore(),
  ) {}

  // ---- POST /api/machine/sync ----

  /**
   * Live artifact sync (Bearer DEVICE token — the durable machine identity, NOT
   * the run lease which is retired at run end; live sync runs continuously,
   * including between runs and on idle-time human edits). The daemon posts the
   * FULL current manifest of a loop's folder plus optional inline bytes for small
   * files; the server stores verified blobs in R2, reconciles `artifact_files`
   * (vanished paths become tombstones), and replies with the hashes it still
   * needs — content-addressed dedupe means an unchanged folder uploads nothing.
   */
  async sync(
    deviceToken: string,
    body: {
      loopId?: unknown;
      runId?: unknown;
      manifest?: unknown;
      blobs?: unknown;
    },
  ): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    const machine = await store.getMachine(machineId);
    if (!machine) return { status: 401, body: { error: "unknown machine (token not registered)" } };

    const loopId = typeof body.loopId === "string" ? body.loopId : "";
    if (!loopId) return { status: 400, body: { error: "loopId required" } };
    const loop = await store.getLoop(loopId);
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    // runId attribution (Phase 3 seam): honored only when it names a run on this loop.
    let runId: string | null = null;
    if (typeof body.runId === "string" && body.runId) {
      const run = await store.getRun(body.runId);
      if (run && run.loopId === loopId) runId = body.runId;
    }

    // Verified inline bytes, indexed by hash (small files sent in the POST to skip
    // the PUT round-trip). Anything failing integrity/cap is silently dropped → it
    // simply lands in needHashes and arrives via PUT instead.
    const inline = new Map<string, Buffer>();
    if (Array.isArray(body.blobs)) {
      for (const b of body.blobs) {
        const hash = (b as { hash?: unknown }).hash;
        const data = (b as { data?: unknown }).data;
        const enc: BufferEncoding = (b as { encoding?: unknown }).encoding === "utf8" ? "utf8" : "base64";
        if (!isValidHash(hash) || typeof data !== "string") continue;
        let bytes: Buffer;
        try {
          bytes = Buffer.from(data, enc);
        } catch {
          continue;
        }
        if (bytes.length > BLOB_CAP) continue;
        if (sha256Buf(bytes) !== hash) continue; // integrity / anti-poisoning
        inline.set(hash, bytes);
      }
    }

    const manifest = Array.isArray(body.manifest) ? body.manifest : [];
    const keepPaths: string[] = [];
    const seenPaths = new Set<string>();
    const needHashes = new Set<string>();
    const toStore = new Map<string, Buffer>();
    // Byte-backed accepted paths → hash, for the task-file content refresh below.
    const pathHashes = new Map<string, string>();

    // Per-loop storage cap (runaway guard). We track a PROJECTED footprint as we
    // reconcile: the loop's already-stored bytes plus any NEW bytes this sync would
    // add (a file pointing at a hash the server doesn't yet have). When accepting a
    // new file would push it past the cap we reject THAT file — skip its bytes + its
    // row — so existing files and deletions still reconcile (the loop never gets
    // wedged), and surface the cap on the response (mirrors the per-file oversize
    // signal). Reusing an already-stored hash adds no bytes, so it's always allowed.
    const bytesCap = loopBytesCap();
    let projectedBytes = await store.loopStoredBytes(loopId);
    // Per-path breakdown of that same footprint (one upfront query, not two point
    // queries per manifest file) — consulted for the overwrite "freed" credit below.
    const priorSizes = await store.liveArtifactSizes(loopId);
    const rejectedPaths: string[] = [];
    let capExceeded = false;

    for (const raw of manifest) {
      const rel = safeRelPath((raw as { path?: unknown })?.path);
      if (!rel) continue; // absolute / traversal / empty → reject
      if (isIgnoredPath(rel)) continue; // secret/junk → never store (defense in depth)
      if (seenPaths.has(rel)) continue;
      seenPaths.add(rel);

      const rawSize = Number((raw as { size?: unknown })?.size);
      const sizeOk = Number.isFinite(rawSize) && rawSize >= 0;
      const binary = !!(raw as { binary?: unknown })?.binary;
      const hash = (raw as { hash?: unknown })?.hash;
      const oversize = !!(raw as { oversize?: unknown })?.oversize || (sizeOk && rawSize > BLOB_CAP);

      if (oversize) {
        // Metadata-only: genuinely over the per-file cap (path + size, no bytes).
        await store.upsertArtifactFile({
          loopId,
          path: rel,
          hash: null,
          size: sizeOk ? rawSize : null,
          binary,
          oversize: true,
          lastRunId: runId,
        });
        keepPaths.push(rel);
        continue;
      }

      if (!isValidHash(hash)) {
        // In-cap entry with a missing/invalid content hash (the real daemon never
        // sends this). We can't represent a real file without bytes, so drop it
        // entirely rather than mislabel it oversize.
        continue;
      }

      const inlined = inline.get(hash);
      // Does accepting this file add NEW bytes to storage? It doesn't if the server
      // already has the blob (global content-addressed dedupe) or we're already
      // taking it this same sync. Only NEW bytes count toward the per-loop cap.
      // Size source, conservatively: inline bytes (authoritative) → the reported
      // size → BLOB_CAP for a non-inline file with a missing/invalid size. NEVER 0:
      // a 0 estimate would let an under-reported size slip past the cap here and
      // arrive uncapped via PUT (the daemon always sends a size, so this only bites
      // a buggy/hostile client, which we want to bound, not trust). putBlob re-checks
      // against the real byte length regardless.
      const fileSize = inlined?.length ?? (sizeOk ? rawSize : BLOB_CAP);
      const addsNewBytes = !((await store.blobExists(hash)) || toStore.has(hash) || needHashes.has(hash));
      if (addsNewBytes) {
        // Cap only the NET growth: overwriting an existing live, byte-backed row at
        // `rel` FREES its currently-counted bytes (the upsert below replaces it), so
        // a loop regenerating one large file in place (the running-memory model)
        // never falsely trips the cap. Only genuinely new paths / size increases count.
        // The freed credit uses the VERIFIED stored length (blobs.size — the same
        // basis loopStoredBytes counts), falling back to the reported size only for
        // a pending row: an OVER-reported prior size must not mint free headroom.
        // (liveArtifactSizes carries only live, byte-backed rows, so a tombstoned /
        // oversize / hash-less prior contributes 0 — same rule as before.)
        const freed = priorSizes.get(rel) ?? 0;
        const projectedAfter = projectedBytes + fileSize - freed;
        if (projectedAfter > bytesCap) {
          // Per-loop storage cap reached → refuse THIS new file's bytes. Skip the row
          // too (never leave an artifact pointing at a blob we won't store). Existing
          // files + deletions below still reconcile, so the loop is never wedged.
          capExceeded = true;
          rejectedPaths.push(rel);
          continue;
        }
        projectedBytes = projectedAfter;
      }

      if (inlined) toStore.set(hash, inlined);
      else if (!(await store.blobExists(hash))) needHashes.add(hash);

      await store.upsertArtifactFile({
        loopId,
        path: rel,
        hash,
        // Verified inline byte length beats the client-reported size when in hand.
        size: inlined ? inlined.length : sizeOk ? rawSize : null,
        binary: binary || (inlined ? looksBinary(inlined) : false),
        oversize: false,
        lastRunId: runId,
      });
      keepPaths.push(rel);
      pathHashes.set(rel, hash);
    }

    // Persist the inline blobs (bytes-first, then metadata row). Parse the product's
    // front matter ONCE here, where the bytes first arrive — content-addressed, so a
    // dedup re-reference (blob already recorded) reuses the stored meta rather than
    // re-parsing (the conflict no-op keeps it), and a binary blob is never parsed.
    for (const [hash, bytes] of toStore) {
      await this.blobStore.put(hash, bytes);
      if (await store.blobExists(hash)) continue; // dedup: meta already computed for this hash
      const binary = looksBinary(bytes);
      await store.recordBlob(hash, bytes.length, binary, binary ? null : artifactMeta(bytes.toString("utf8")));
    }

    // Task-file live refresh: when this manifest carries the loop's task file and
    // its bytes are in hand (inline this request, or already stored — dedup), mirror
    // them onto loops.taskFileContent, the column the Files panel's task pane
    // renders. report() used to be the ONLY writer, which left a brand-new loop's
    // README invisible until its first run finished; this closes that gap and also
    // reflects idle-time human edits within a flush. Bytes still pending a PUT are
    // handled by putBlob's mirror below.
    await this.refreshTaskFileContent(loop, pathHashes, async (hash) =>
      toStore.get(hash) ?? inline.get(hash) ?? ((await store.blobExists(hash)) ? await this.blobStore.get(hash) : null),
    );

    // Deletions = absence from the full manifest → tombstone the vanished paths.
    // Cap-rejected paths are NOT tombstoned: keep their prior row (the last accepted
    // version) intact rather than dropping the file just because new bytes were
    // refused — so they're added to the keep set for the deletion reconciliation.
    const tombstoned = await store.tombstoneMissingArtifacts(loopId, [...keepPaths, ...rejectedPaths], runId);

    log.info(
      { machineId, loopId, files: keepPaths.length, inlined: toStore.size, need: needHashes.size, tombstoned, rejected: rejectedPaths.length },
      "sync: reconciled",
    );
    if (capExceeded) {
      log.warn({ machineId, loopId, used: projectedBytes, cap: bytesCap, rejected: rejectedPaths.length }, "sync: per-loop storage cap reached");
    }
    return {
      status: 200,
      body: {
        ok: true,
        needHashes: [...needHashes],
        // Storage-cap signal (mirrors the per-file oversize path): when set, the
        // daemon learns its newest bytes were refused and the loop is at capacity.
        ...(capExceeded
          ? { capExceeded: true, bytesUsed: projectedBytes, bytesCap, rejected: rejectedPaths }
          : {}),
      },
    };
  }

  /** Mirror the loop's task-file bytes onto `loops.taskFileContent` (+ stamp
   *  `taskFileSyncedAt`) when the synced manifest's best task-file match has its
   *  bytes available. Path selection reuses `pickTaskPath` — the exact matcher the
   *  Files panel dedups with — so server and UI can never disagree about which
   *  synced file IS the task file. Binary bytes and unchanged content are no-ops. */
  private async refreshTaskFileContent(
    loop: Loop,
    pathHashes: Map<string, string>,
    bytesFor: (hash: string) => Promise<Buffer | null | undefined>,
  ): Promise<void> {
    if (!loop.taskFile) return;
    const best = pickTaskPath(loop.taskFile, [...pathHashes.keys()]);
    if (!best) return;
    const bytes = await bytesFor(pathHashes.get(best)!);
    if (!bytes || looksBinary(bytes)) return;
    const text = clipText(bytes.toString("utf8"), WIRE_TEXT_CAP);
    if (text === loop.taskFileContent) return; // unchanged → no row churn per flush
    await store.updateLoop(loop.id, { taskFileContent: text, taskFileSyncedAt: nowIso() });
  }

  // ---- PUT /api/machine/blob/:hash ----

  /**
   * Upload one content-addressed blob's raw bytes (Bearer device token). The
   * server recomputes sha256(body) and rejects any mismatch before storing —
   * integrity + anti-poisoning, so a blob's bytes always match its key.
   */
  async putBlob(deviceToken: string, hash: string, bytes: Buffer): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    if (!(await store.getMachine(machineId))) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    if (!isValidHash(hash)) return { status: 400, body: { error: "invalid hash (expect sha256 hex)" } };
    if (bytes.length > BLOB_CAP) return { status: 413, body: { error: "blob exceeds size cap" } };
    if (sha256Buf(bytes) !== hash) return { status: 400, body: { error: "hash mismatch (sha256(body) !== :hash)" } };
    // Upload gate: only accept bytes the sync handshake actually asked THIS machine
    // for — i.e. a hash a live artifact_files row on one of its loops points at
    // (the row sync wrote when it returned the hash in needHashes). Any other PUT
    // (an arbitrary self-hashed blob nothing references) is refused, so a device
    // token can't be used as an uncapped R2 write channel. A re-PUT of a still-
    // referenced hash stays accepted (idempotent — daemon retries are safe).
    if (!(await store.machineReferencesBlob(machineId, hash))) {
      return { status: 403, body: { error: "hash was not requested for this machine (sync a manifest first)" } };
    }

    // Per-loop storage cap, authoritative re-check (defense in depth). sync() caps
    // from the daemon-reported size; a NEW blob (one the server doesn't already
    // have) arriving here is re-measured against its REAL byte length for every
    // loop that already references the hash (the rows a prior sync wrote when it
    // returned this hash in needHashes). If storing would push a referencing loop
    // past its cap, refuse the bytes AND drop that loop's dangling rows so nothing
    // points at a blob we won't store — a later sync re-reconciles (self-healing).
    if (!(await store.blobExists(hash))) {
      const cap = loopBytesCap();
      // Pre-await the per-loop sizes into an array BEFORE filtering — a filter callback
      // can't await, so `store.loopStoredBytesExcludingHash(...) + bytes.length` would
      // otherwise be `Promise + number`.
      const referencing = await store.loopsReferencingHash(hash);
      const sizes = await Promise.all(referencing.map((loopId) => store.loopStoredBytesExcludingHash(loopId, hash)));
      const overLoops = referencing.filter((_loopId, i) => sizes[i]! + bytes.length > cap);
      if (overLoops.length) {
        for (const loopId of overLoops) await store.dropArtifactFilesForHash(loopId, hash);
        log.warn({ machineId, hash, bytes: bytes.length, loops: overLoops.length }, "putBlob: per-loop storage cap reached — refused");
        return { status: 413, body: { error: "blob would exceed per-loop storage cap", capExceeded: true } };
      }
    }

    await this.blobStore.put(hash, bytes);
    // Parse front matter once at this ingress point too (same content-addressed
    // reuse: a re-PUT of an already-recorded hash no-ops and keeps its meta; binary
    // bytes are never parsed).
    const binary = looksBinary(bytes);
    await store.recordBlob(hash, bytes.length, binary, binary ? null : artifactMeta(bytes.toString("utf8")));
    // Late-arriving task-file bytes: a task file over the daemon's inline cap rides
    // this PUT (sync couldn't mirror it — no bytes in hand, and no follow-up sync is
    // guaranteed on an idle folder). Mirror onto each referencing loop whose task
    // file this blob backs, via the same refresh path sync uses.
    if (!binary) {
      for (const loopId of await store.loopsReferencingHash(hash)) {
        const loop = await store.getLoop(loopId);
        if (!loop?.taskFile) continue;
        const rows = (await store.listArtifacts(loopId)).filter((r) => r.hash);
        await this.refreshTaskFileContent(
          loop,
          new Map(rows.map((r) => [r.path, r.hash!] as const)),
          async (h) => (h === hash ? bytes : null), // only THIS blob's bytes are new
        );
      }
    }
    return { status: 200, body: { ok: true } };
  }

  /** Read a stored blob's bytes (Phase 2 download seam; null when absent). */
  readBlob(hash: string): Promise<Buffer | null> {
    if (!isValidHash(hash)) return Promise.resolve(null);
    return this.blobStore.get(hash);
  }
}
