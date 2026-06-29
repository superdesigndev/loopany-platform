/**
 * Per-run artifact diff (Phase 3). Computed lazily on the SERVER at read time
 * (no stored diffs): load run N's snapshot + the previous run's snapshot and diff
 * the two path → metadata maps. For changed TEXT files we load both blobs and
 * compute a unified line diff with `diff` (jsdiff) — a pure-string library, no
 * process execution, so the server's zero-exec invariant holds. Binary/oversize
 * files emit a size-delta marker only (no inline diff).
 */
import { createTwoFilesPatch } from "diff";

import * as store from "../db/store.js";
import { getGateway } from "./boot.js";
import type { SnapshotEntry, SnapshotManifest } from "../db/schema.js";
import type { RunDiffFile, RunDiffResult } from "../types.js";

/** A file is text-diffable only when it has stored bytes and isn't binary/oversize. */
function isText(e: SnapshotEntry | undefined): boolean {
  return !!e && !e.binary && !e.oversize && !!e.hash;
}

/** Decode a snapshot entry's blob to text, or null when bytes are absent. */
async function textOf(e: SnapshotEntry | undefined): Promise<string | null> {
  if (!e || !e.hash) return null;
  const bytes = await getGateway().readBlob(e.hash);
  return bytes ? bytes.toString("utf8") : null;
}

/** Unified diff between two versions of a path (empty string ⇒ added/removed side). */
function unified(path: string, oldText: string, newText: string): string {
  return createTwoFilesPatch(path, path, oldText, newText, "previous run", "this run");
}

export async function computeRunDiff(runId: string): Promise<RunDiffResult> {
  const run = store.getRun(runId);
  if (!run) return { hasSnapshot: false, files: [] };
  const snap = store.getRunSnapshot(runId);
  // No snapshot ⇒ the run predates the feature → degrade (not an empty diff).
  if (!snap) return { hasSnapshot: false, files: [] };

  const curr: SnapshotManifest = snap.manifest ?? {};
  const prev: SnapshotManifest = store.prevRunSnapshot(run.loopId, run.ts)?.manifest ?? {};

  const paths = [...new Set([...Object.keys(curr), ...Object.keys(prev)])].sort();
  const files: RunDiffFile[] = [];

  for (const path of paths) {
    const c = curr[path];
    const p = prev[path];

    if (c && !p) {
      // Added.
      const file: RunDiffFile = { path, status: "added", binary: !isText(c), sizeDelta: c.size ?? null };
      if (isText(c)) {
        const text = await textOf(c);
        if (text != null) file.diff = unified(path, "", text);
        else file.binary = true; // bytes gone → can't show a diff
      }
      files.push(file);
    } else if (!c && p) {
      // Removed.
      const file: RunDiffFile = { path, status: "removed", binary: !isText(p), sizeDelta: p.size != null ? -p.size : null };
      if (isText(p)) {
        const text = await textOf(p);
        if (text != null) file.diff = unified(path, text, "");
        else file.binary = true;
      }
      files.push(file);
    } else if (c && p) {
      // Present in both — unchanged content ⇒ skip.
      if (c.hash === p.hash && c.oversize === p.oversize) continue;
      const sizeDelta = c.size != null && p.size != null ? c.size - p.size : null;
      const bothText = isText(c) && isText(p);
      const file: RunDiffFile = { path, status: "modified", binary: !bothText, sizeDelta };
      if (bothText) {
        const [oldText, newText] = await Promise.all([textOf(p), textOf(c)]);
        if (oldText != null && newText != null) file.diff = unified(path, oldText, newText);
        else file.binary = true;
      }
      files.push(file);
    }
  }

  return { hasSnapshot: true, files };
}
