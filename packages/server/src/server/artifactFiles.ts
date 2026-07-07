/**
 * Server-side reads over a loop's live-synced artifacts (Phase 2). Pure helpers
 * (no request/session context) so they're shared by the lazy server fns
 * (`getArtifacts` / `getArtifact` in loopApi) AND the download route, and are
 * directly unit-testable against the in-memory blob store — authorization is the
 * caller's job (the server fn via `ownedLoop`, the route via `loopInScope`).
 *
 * The bytes live in the gateway's BlobStore (R2 in prod, in-memory in dev/tests);
 * here we only read them — never write — so the feature is strictly read-only and
 * the server's zero-exec invariant holds (it decodes text, never interprets it).
 */
import * as store from "../db/store.js";
import { safeRelPath } from "../gateway/artifacts.js";
import { getArtifactSync } from "./boot.js";
import { toArtifactSummary } from "./adapters.js";
import type { ArtifactContent, ArtifactSummary } from "../types.js";

/** The loop's current (non-deleted) file set as compact UI rows, path-sorted, each
 *  carrying its blob's front-matter meta (one indexed join, no per-file fetch). */
export async function listLoopArtifacts(loopId: string): Promise<ArtifactSummary[]> {
  return (await store.listArtifactsWithMeta(loopId)).map(toArtifactSummary);
}

/**
 * One file's content for inline display: decoded text for a text file, or a
 * binary/oversize marker (the UI then offers the download route). Returns an
 * error marker for an unknown/tombstoned path or a blob whose bytes aren't
 * stored yet (a pending upload) — never throws.
 */
export async function readLoopArtifact(loopId: string, rawPath: string): Promise<ArtifactContent> {
  const rel = safeRelPath(rawPath);
  if (!rel) return { error: "invalid path" };
  const row = await store.getArtifactFile(loopId, rel);
  if (!row || row.deleted) return { error: "file not found" };
  // Genuinely binary or oversize → download-only marker (the UI offers the route).
  if (row.binary || row.oversize) {
    return { binary: true, size: row.size ?? null, oversize: row.oversize };
  }
  // A text file whose bytes haven't been recorded yet (transient mid-sync): a
  // distinct pending marker, not a binary dead-end with no download link.
  if (!row.hash) return { error: "file not synced yet" };
  const bytes = await (await getArtifactSync()).readBlob(row.hash);
  if (!bytes) return { error: "file not found" }; // blob bytes not (yet) stored
  return { text: bytes.toString("utf8") };
}

/** What the download route needs to stream one artifact's raw bytes. */
export interface ArtifactBytes {
  status: number;
  bytes?: Buffer;
  binary?: boolean;
  /** Basename for the Content-Disposition filename. */
  filename?: string;
}

/**
 * Resolve a loop-relative path to its stored bytes for the download route.
 * Path-safe (rejects absolute/`..`/escaping → 400). Oversize/tombstoned/absent
 * → 404 (no bytes to serve). The bytes stream straight from the BlobStore.
 */
export async function readLoopArtifactBytes(loopId: string, rawPath: string): Promise<ArtifactBytes> {
  const rel = safeRelPath(rawPath);
  if (!rel) return { status: 400 };
  const row = await store.getArtifactFile(loopId, rel);
  if (!row || row.deleted || !row.hash) return { status: 404 }; // tombstone/oversize ⇒ no bytes
  const bytes = await (await getArtifactSync()).readBlob(row.hash);
  if (!bytes) return { status: 404 };
  return { status: 200, bytes, binary: row.binary, filename: rel.split("/").pop() || "file" };
}
