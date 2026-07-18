/**
 * Server-side artifact-sync helpers: path safety, the secret/junk ignore list,
 * size caps, and byte hashing. The daemon applies the same ignore rules before
 * transmitting; the server re-applies them defensively (defense in depth — it
 * must not store a secret even if a daemon sends one).
 */
import { createHash } from "node:crypto";

/** Per-file byte cap. At or under ⇒ bytes sync; over ⇒ metadata-only (no bytes). */
export const BLOB_CAP = 10 * 1024 * 1024; // 10MB
/** Hard ceiling on a sync POST body (manifest + any inlined blobs). */
export const SYNC_BODY_CAP = 32 * 1024 * 1024; // 32MB

export function sha256Buf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A 64-char lowercase hex sha256. */
export function isValidHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
}

/** Heuristic binary sniff: any NUL byte in the first 8KB ⇒ binary (download-only). */
export function looksBinary(bytes: Buffer): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Normalize an untrusted, loop-folder-relative path. Returns the cleaned POSIX
 * relative path, or null if it is absolute, escapes the folder (`..`), is empty,
 * or carries a NUL (no real filesystem produces one, so it is hostile wire input
 * by definition - and Postgres text columns reject it, so letting it through
 * would 500 the whole sync on the artifact_files write).
 * Backslashes are normalized to `/` so a Windows daemon's paths land consistently.
 */
export function safeRelPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  if (raw.includes("\u0000")) return null; // NUL: impossible on a real FS, rejected by pg
  const unix = raw.replace(/\\/g, "/").trim();
  if (unix.startsWith("/")) return null; // absolute
  // Normalize `./` and collapse, then reject any remaining traversal.
  const parts: string[] = [];
  for (const seg of unix.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null; // escapes the loop folder
    parts.push(seg);
  }
  if (!parts.length) return null;
  const cleaned = parts.join("/");
  return cleaned.length <= 1024 ? cleaned : null;
}

// Directory names whose entire subtree is excluded from sync — VCS metadata,
// dependency trees, git worktrees, and build/tool caches. A loop folder is a
// synced CONTENT home, not a scratch workspace, so a repo clone / worktree /
// build tree dropped in it is rejected even if a daemon transmits it (defense in
// depth; the daemon's own watcher excludes the same set — keep the two in sync).
const IGNORE_DIRS = new Set([
  ".git",
  ".loopany",
  ".DS_Store",
  "node_modules",
  ".worktrees",
  ".cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".gradle",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".yarn",
  ".pnpm-store",
]);

/**
 * Should this (already loop-relative, normalized) path be ignored entirely?
 * Excludes VCS/deps/daemon dirs and credential-bearing files (secrets must never
 * be stored even if a daemon transmits them).
 */
export function isIgnoredPath(rel: string): boolean {
  const segs = rel.split("/");
  for (const seg of segs) {
    if (IGNORE_DIRS.has(seg)) return true;
  }
  const base = segs[segs.length - 1] ?? "";
  if (base === ".DS_Store") return true;
  if (base === ".env" || base.startsWith(".env.")) return true; // .env, .env.local, …
  if (base.endsWith(".pem")) return true;
  if (base.startsWith("id_rsa")) return true; // id_rsa, id_rsa.pub
  if (base.startsWith("id_ed25519")) return true;
  if (base === ".npmrc" || base === ".netrc" || base === "credentials") return true;
  return false;
}
