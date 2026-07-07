import { useId } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { StateField } from '../types'
import { seriesRows, type SeriesPoint } from '../lib/stats'
import { fnum, md, tsShort } from '../lib/format'

/**
 * `<loop-chart series="mrr:MRR:$, paid:Paid">` - the loop's run-history trend,
 * rendered by Recharts in the shadcn/ui-charts grammar, themed entirely by the
 * theme tokens (`--color-chart-1..5` ramp, hairline grid, mono ticks,
 * flat tooltip - no shadows, no decorative color). One series renders as a
 * gradient area; multiple series render as plain lines (overlapping translucent
 * fills go muddy in a monochrome palette). A single-point series renders a dot
 * instead of nothing, so a young loop's dashboard is never blank.
 *
 * `data` is the shared `numericSeries(runs)` map computed once by LoopView.
 */

/** Distinct strokes for multiple series - display ink first, then the signal colors. */
const STROKES = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
]

/**
 * Fixed pixel height: ResponsiveContainer tracks the CONTAINER width while the
 * height stays constant - the fix for the old stretched-viewBox renderer, which
 * scaled like an image (≈4px-fat strokes and a ~340px-tall chart at the loop
 * page's full dashboard width). Also the initial render size before the
 * ResizeObserver measures (and the only size in a non-browser render).
 */
const HEIGHT = 190
const INITIAL = { width: 640, height: HEIGHT }

const TICK = { fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--color-secondary)' }

const TOOLTIP_STYLE = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-wire)',
  borderRadius: 8,
  boxShadow: 'none',
  padding: '6px 10px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
} as const

/** "$12.4k" / "40℃" / "7" - the unit placement the legend has always used. */
const withUnit = (v: number, unit: string): string => (unit === '$' ? `$${fnum(v)}` : `${fnum(v)}${unit}`)

export function LoopChart({
  data,
  series,
}: {
  data: Record<string, SeriesPoint[]>
  series: StateField[]
}) {
  const gradientId = useId()
  if (!series.length) return null
  // A single reported point plots as a labeled dot (the old renderer required
  // >= 2 points and rendered nothing at all for a young loop).
  const plotted = series
    .map((f) => ({ field: f, pts: data[f.key] ?? [] }))
    .filter((s) => s.pts.length >= 1)
  if (!plotted.length) return null

  const keys = plotted.map((s) => s.field.key)
  const rows = seriesRows(data, keys)
  const single = plotted.length === 1
  const unitOf = new Map(plotted.map((s) => [s.field.key, s.field.unit ?? '']))

  const xAxis = (
    <XAxis
      dataKey="__t"
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={28}
      interval="preserveStartEnd"
      tick={TICK}
      tickFormatter={(t: string) => md(t)}
    />
  )
  const yAxis = (
    <YAxis
      width={34}
      tickCount={4}
      tickLine={false}
      axisLine={false}
      tick={TICK}
      tickFormatter={(v: number) => fnum(v)}
    />
  )
  const grid = <CartesianGrid vertical={false} stroke="var(--color-hairline)" />
  const tooltip = (
    <Tooltip
      // No position tween: Recharts' default tooltip carries a
      // `transition: transform 400ms`, so when the active point jumps the box
      // SLIDES between positions. Near the chart's right edge that slide passes
      // through an out-of-bounds spot, and because the dashboard box is
      // `overflow-x-auto` the browser flashes a horizontal scrollbar for the
      // ~400ms tween. Jumping straight to the final (in-viewBox, clamped)
      // position keeps the tooltip fully visible AND never overflows the
      // container - and matches the "fade, don't slide" motion the series use.
      isAnimationActive={false}
      cursor={{ stroke: 'var(--color-wire)', strokeDasharray: '3 3' }}
      contentStyle={TOOLTIP_STYLE}
      labelStyle={{ color: 'var(--color-secondary)', marginBottom: 2 }}
      itemStyle={{ color: 'var(--color-primary)', padding: '1px 0' }}
      labelFormatter={(t) => tsShort(String(t))}
      formatter={(v, name, item) => [
        withUnit(Number(v), unitOf.get(String(item?.dataKey)) ?? ''),
        String(name),
      ]}
    />
  )

  // Per-series props shared by Area/Line. Dots only when a series is a single
  // point (nothing to stroke); animation off - Nothing motion is "fade, don't
  // slide", and the dashboard re-renders on every poll.
  const seriesProps = (s: (typeof plotted)[number], idx: number) => {
    const color = STROKES[idx % STROKES.length]!
    return {
      dataKey: s.field.key,
      name: s.field.label ?? s.field.key,
      type: 'monotone' as const,
      stroke: color,
      strokeWidth: 1.5,
      dot: s.pts.length === 1 ? { r: 3.5, strokeWidth: 0, fill: color } : false,
      activeDot: { r: 3, strokeWidth: 0, fill: color },
      connectNulls: true,
      isAnimationActive: false,
    }
  }

  const margin = { top: 6, right: 12, left: 0, bottom: 0 }

  return (
    <figure className="my-2 min-w-0">
      <div className="min-w-0" style={{ height: HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={INITIAL}>
          {single ? (
            <AreaChart data={rows} margin={margin}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={STROKES[0]} stopOpacity={0.28} />
                  <stop offset="95%" stopColor={STROKES[0]} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              <Area {...seriesProps(plotted[0]!, 0)} fill={`url(#${gradientId})`} />
            </AreaChart>
          ) : (
            <LineChart data={rows} margin={margin}>
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              {plotted.map((s, idx) => (
                <Line {...seriesProps(s, idx)} key={s.field.key} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-label text-[var(--color-secondary)]">
        {plotted.map((s, idx) => {
          const last = s.pts[s.pts.length - 1]
          if (!last) return null
          return (
            <span key={s.field.key} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-[2px] w-3 align-middle"
                style={{ background: STROKES[idx % STROKES.length] }}
              />
              {s.field.label ?? s.field.key}
              <span className="text-[var(--color-display)]">{withUnit(last.v, s.field.unit ?? '')}</span>
            </span>
          )
        })}
      </figcaption>
    </figure>
  )
}
