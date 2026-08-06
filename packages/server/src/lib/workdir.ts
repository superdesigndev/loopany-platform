/** Server-side wire validation only. Existence, normalization and roots belong to the daemon. */
export const WORKDIR_MAX_LENGTH = 4096;

export type WorkdirValidation = { ok: true; value: string | null } | { ok: false; error: string };

export function validateWorkdir(value: unknown): WorkdirValidation {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "workdir must be an absolute path, ~/ path, or null" };
  const cleaned = value.replace(/\0/g, "").trim();
  if (!cleaned) return { ok: true, value: null };
  if (cleaned.length > WORKDIR_MAX_LENGTH) return { ok: false, error: `workdir is too long (max ${WORKDIR_MAX_LENGTH} characters)` };
  const absolute = cleaned.startsWith("/") || cleaned.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith("\\\\");
  return absolute
    ? { ok: true, value: cleaned }
    : { ok: false, error: "workdir must be absolute (or start with ~/); relative paths are not accepted" };
}
