import type { RunSummary } from '../types'

/** Merge two chronological (oldest-first) run lists, dedup by id (the first
 *  occurrence wins, so pass the fresher list first), re-sorted by ts ascending.
 *  Shared by the dashboard cards and the loop detail page, which both seed the
 *  timeline with the newest page and grow it leftward with lazily-paged older runs. */
export function mergeRuns(primary: RunSummary[], secondary: RunSummary[]): RunSummary[] {
  const seen = new Set<string>()
  const out: RunSummary[] = []
  for (const r of [...primary, ...secondary]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return out
}
