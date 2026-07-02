/**
 * Numeric helpers for the trend chart. Pure functions, covered by stats.test.ts.
 * Anything fancier (win-probability, lift, verdicts for an A/B loop) is computed
 * by the exec agent each run and reported as plain numeric metrics — the render
 * layer only plots series + substitutes `{{latest.*}}` scalars.
 */
import type { Json, RunSummary } from '../types'

export interface SeriesPoint {
  t: string
  v: number
}

/** Per-run numeric state snapshots → one series per numeric field (chronological). */
export function numericSeries(runsNewestFirst: RunSummary[]): Record<string, SeriesPoint[]> {
  const chron = (runsNewestFirst ?? []).slice().reverse()
  const series: Record<string, SeriesPoint[]> = {}
  for (const r of chron) {
    const obj =
      r.state && typeof r.state === 'object' && !Array.isArray(r.state)
        ? (r.state as Record<string, Json>)
        : {}
    const merged: Record<string, Json> = { ...obj }
    if (typeof r.sample === 'number' && merged.sample === undefined) merged.sample = r.sample
    for (const k in merged) {
      const v = merged[k]
      if (typeof v === 'number' && isFinite(v)) (series[k] ??= []).push({ t: r.ts, v })
    }
  }
  return series
}

/**
 * One Recharts data row: the run timestamp plus each requested metric present
 * at it. The timestamp field is `__t` (not `t`) so a loop whose declared state
 * key is literally `t` can't overwrite it.
 */
export interface SeriesRow {
  __t: string
  [key: string]: string | number
}

/**
 * Merge per-key series into the row-oriented array Recharts consumes
 * (`[{__t, k1, k2}, …]`, chronological). Rows are the union of the requested
 * keys' timestamps - a run that reported only some keys leaves the others
 * absent on that row (the chart bridges the gap via `connectNulls`).
 */
export function seriesRows(data: Record<string, SeriesPoint[]>, keys: string[]): SeriesRow[] {
  const ts = new Set<string>()
  for (const k of keys) for (const p of data[k] ?? []) ts.add(p.t)
  const sorted = [...ts].sort() // ISO timestamps - lexical order IS chronological
  const idx = new Map(sorted.map((t, i) => [t, i]))
  const rows: SeriesRow[] = sorted.map((t) => ({ __t: t }))
  for (const k of keys) for (const p of data[k] ?? []) rows[idx.get(p.t)!]![k] = p.v
  return rows
}

/** Min/max of a value set, with a non-zero span (`hi - lo || 1`) for safe scaling. */
export function bounds(values: number[]): { lo: number; hi: number; sp: number } {
  let lo = Infinity,
    hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return { lo, hi, sp: hi - lo || 1 }
}

/**
 * Build an SVG polyline `d` from points on a linear scale shared by the trend
 * renderers (LoopChart, LoopSparkline). `len` is the index span (≥ the longest
 * series so multiple lines align); `padX`/`padY` inset the drawable box.
 */
export function svgLine(
  pts: SeriesPoint[],
  o: { w: number; h: number; lo: number; hi: number; len: number; padX?: number; padY?: number },
): string {
  const padX = o.padX ?? 0,
    padY = o.padY ?? 0
  const sp = o.hi - o.lo || 1
  const X = (i: number) => padX + (o.w - 2 * padX) * (o.len > 1 ? i / (o.len - 1) : 0)
  const Y = (v: number) => padY + (o.h - 2 * padY) * (1 - (v - o.lo) / sp)
  return pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')
}
