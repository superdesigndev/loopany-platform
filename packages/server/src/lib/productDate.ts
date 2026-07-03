/**
 * Pure helpers for the dashboard artifact primitives (`<loop-embed>`,
 * `<loop-calendar>`, `<loop-kanban>`): dating a loop's produced files and resolving the
 * `match="…"` glob against the synced artifact list. Framework-free and
 * unit-tested (productDate.test.ts), like fileEntries.ts.
 *
 * Date rule (in priority order): a product's day comes from its FRONT MATTER
 * `date:` when present + parseable (the authoritative source — the loop declared
 * it); else from its FILENAME when parseable (`YYYY-MM-DD`, `YYYY_MM_DD`, or
 * `YYYYMMDD` - e.g. `digest-2026-07-01.md`, `workflow-setup-<date>.md`); else it
 * falls back to the file's sync time (`updatedAt`), which the UI marks as
 * fallback-dated. Sync time ≈ run end in practice (the daemon flushes a final
 * sync before reporting), but it can misattribute a re-synced old file - hence
 * the visible distinction.
 */

import type { ArtifactMeta } from '../types'

export interface ProductDate {
  /** Calendar day, `YYYY-MM-DD`. */
  date: string
  source: 'frontmatter' | 'filename' | 'sync'
}

const basename = (path: string): string => path.split('/').pop() || path

const pad = (n: number): string => String(n).padStart(2, '0')

/** A real calendar date within a sane range (no 2026-13-40, no year 10521). */
function validDate(y: number, m: number, d: number): boolean {
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

// `2026-07-01` / `2026_07_01` (consistent separator) or bare `20260701`,
// not embedded in a longer digit run (a content hash / id must not date a file).
const DATE_RE = /(\d{4})(?:([-_])(\d{2})\2(\d{2})|(\d{2})(\d{2}))/g

/** First valid date found in the file's basename, else null. */
export function parseFilenameDate(path: string): string | null {
  const name = basename(path)
  DATE_RE.lastIndex = 0
  for (let m = DATE_RE.exec(name); m; m = DATE_RE.exec(name)) {
    // Reject matches flanked by more digits (part of a longer number).
    const before = name[m.index - 1]
    const after = name[m.index + m[0].length]
    if ((before && /\d/.test(before)) || (after && /\d/.test(after))) continue
    const y = Number(m[1])
    const mo = Number(m[3] ?? m[5])
    const d = Number(m[4] ?? m[6])
    if (validDate(y, mo, d)) return `${m[1]}-${pad(mo)}-${pad(d)}`
  }
  return null
}

/** Local calendar day of an ISO timestamp (the calendar renders user-local). */
export function localDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * A calendar day from a front-matter `date:` value (stored RAW — validity is
 * decided here). Forgiving about the shape: takes the leading `YYYY-MM-DD` (or
 * `/`/`_` separators, or a full ISO timestamp's date part) and validates it's a
 * real day. Returns null for anything unparseable/invalid (fall through to
 * filename/sync).
 */
export function parseMetaDate(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d{4})[-/_](\d{2})[-/_](\d{2})/.exec(raw)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return validDate(y, mo, d) ? `${m[1]}-${pad(mo)}-${pad(d)}` : null
}

/** Date one artifact: front-matter `date:` first (authoritative), filename next,
 *  sync time as the marked fallback. */
export function productDate(file: { path: string; updatedAt: string; meta?: ArtifactMeta | null }): ProductDate {
  const fromMeta = parseMetaDate(file.meta?.date)
  if (fromMeta) return { date: fromMeta, source: 'frontmatter' }
  const fromName = parseFilenameDate(file.path)
  return fromName ? { date: fromName, source: 'filename' } : { date: localDay(file.updatedAt), source: 'sync' }
}

/**
 * `match` glob → RegExp. `*` matches within a path segment (never `/`); all
 * other characters are literal. A pattern with no `/` matches against the
 * BASENAME (so `*.md` means "any markdown file, anywhere"), a pattern with
 * one matches the whole loop-relative path.
 */
export function globToRegExp(pattern: string): RegExp {
  const rx = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${rx}$`)
}

/** The artifacts a `match` pattern selects (no pattern ⇒ all). */
export function matchArtifacts<T extends { path: string }>(files: T[], pattern?: string): T[] {
  if (!pattern) return files
  const rx = globToRegExp(pattern)
  const onBase = !pattern.includes('/')
  return files.filter((f) => rx.test(onBase ? basename(f.path) : f.path))
}

/**
 * The newest artifact a pattern selects - by product date (filename first)
 * descending, sync time as the tiebreak. This keeps "the newest digest"
 * correct even when an OLD file happens to re-sync last.
 */
export function newestMatch<T extends { path: string; updatedAt: string }>(
  files: T[],
  pattern?: string,
): T | undefined {
  const matched = matchArtifacts(files, pattern)
  let best: T | undefined
  let bestKey = ''
  for (const f of matched) {
    const key = `${productDate(f).date}|${f.updatedAt}`
    if (!best || key > bestKey) {
      best = f
      bestKey = key
    }
  }
  return best
}
