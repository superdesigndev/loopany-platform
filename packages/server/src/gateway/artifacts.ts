/**
 * Path safety for the artifact READ surfaces.
 *
 * This module used to carry the whole sync ingress vocabulary (size caps, the
 * secret/junk ignore list, byte hashing). Byte ingress retired with the folder
 * watcher, so the only rule left with a live caller is normalizing the untrusted,
 * loop-relative path a reader asks for.
 */

/**
 * Normalize an untrusted, loop-folder-relative path. Returns the cleaned POSIX
 * relative path, or null if it is absolute, escapes the folder (`..`), is empty,
 * or carries a NUL (no real filesystem produces one, so it is hostile wire input
 * by definition — and Postgres text columns reject it).
 * Backslashes are normalized to `/` so a Windows-authored path lands consistently.
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
