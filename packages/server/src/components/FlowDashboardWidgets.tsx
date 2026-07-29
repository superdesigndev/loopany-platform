import type { Widget } from '../lib/templateFlow'

/**
 * The FlowSpec dashboard widgets, drawn to match the REAL dashboard primitives
 * (LoopKanban / LoopChart / LoopCalendar / report embed) — extracted from `LoopFlow`
 * (the compose modal's Dashboard tab, today's one consumer) so any future surface
 * that previews a FlowSpec dashboard renders the SAME widgets rather than a fork.
 *
 * Deliberately HOOK-FREE and measurement-free, so it stays SSR-safe (the gradient id
 * derives from the series itself instead of useId/useMemo).
 */
export function FlowDashboard({ widgets }: { widgets: Widget[] }) {
  return (
    <div className="min-w-0">
      {widgets.map((w, i) => (
        <div key={i} className={`min-w-0 ${i > 0 ? 'mt-6' : ''}`}>
          {w.type === 'kanban' ? (
            <KanbanWidget w={w} />
          ) : w.type === 'metric' ? (
            <MetricWidget w={w} />
          ) : w.type === 'calendar' ? (
            <CalendarWidget w={w} />
          ) : (
            <EmbedWidget w={w} />
          )}
        </div>
      ))}
    </div>
  )
}

const CAL_DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] // Monday-start, like LoopCalendar

/** A month grid of report days, matching LoopCalendar's look: Monday-start weekday
 *  headers, mono day numbers top-right, hairline grid, an interactive-ink dot on days
 *  that produced a report. grid-cols-7 fills the column and reflows (min-w-0). */
function CalendarWidget({ w }: { w: Extract<Widget, { type: 'calendar' }> }) {
  const marked = new Set(w.reportDays)
  const trail = (7 - ((w.firstWeekday + w.days) % 7)) % 7
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-meta font-medium text-secondary">{w.heading}</span>
        <span className="font-mono text-caption text-disabled">{w.monthLabel}</span>
        <span className="ml-auto font-mono text-caption text-disabled">
          {w.reportDays.length} report{w.reportDays.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="grid min-w-0 grid-cols-7 border-l border-t border-hairline">
        {CAL_DOW.map((d) => (
          <div key={d} className="border-b border-r border-hairline px-1.5 py-1 text-right text-micro font-medium text-disabled">
            {d}
          </div>
        ))}
        {Array.from({ length: w.firstWeekday }, (_, i) => (
          <div key={`lead${i}`} className="border-b border-r border-hairline bg-raised" />
        ))}
        {Array.from({ length: w.days }, (_, i) => {
          const day = i + 1
          return (
            <div key={day} className="relative min-h-[34px] min-w-0 border-b border-r border-hairline bg-surface px-1 pb-1 pt-4">
              <span className="absolute right-1 top-0.5 font-mono text-micro text-disabled">{day}</span>
              {marked.has(day) && (
                <span title={`report · day ${day}`} className="absolute bottom-1 left-1 inline-block size-1.5 rounded-full" style={{ background: 'var(--color-interactive)' }} />
              )}
            </div>
          )
        })}
        {Array.from({ length: trail }, (_, i) => (
          <div key={`trail${i}`} className="border-b border-r border-hairline bg-raised" />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-caption font-medium text-secondary">
        <span className="inline-block size-1.5 rounded-full" style={{ background: 'var(--color-interactive)' }} /> Day with a report
      </div>
    </div>
  )
}

function KanbanWidget({ w }: { w: Extract<Widget, { type: 'kanban' }> }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-meta font-medium text-secondary">
        {w.heading} {w.sub && <span className="font-mono text-caption text-disabled">{w.sub}</span>}
      </div>
      {/* The board is the only horizontal-scroll container: fixed-width columns
          shrink-0 so a wide (3-column) board scrolls inside its pane, never widening
          the page — mirrors the real LoopKanban. */}
      <div className="flex min-w-0 gap-3 overflow-x-auto pb-1">
        {w.columns.map(([name, cards]) => (
          <div key={name} className="flex w-[190px] shrink-0 flex-col">
            <div className="mb-2 flex items-center gap-2 border-b border-hairline pb-1.5">
              <span className="text-label font-semibold text-primary">{name}</span>
              <span className="text-caption text-disabled">{cards.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {cards.map(([id, title, when]) => (
                <div key={id} className="min-w-0 overflow-hidden rounded-control border border-hairline bg-surface shadow-card transition-colors hover:border-wire">
                  <div className="flex flex-col gap-1 px-2.5 py-2">
                    <span className="truncate text-meta text-primary">{title}</span>
                    <span className="truncate font-mono text-micro text-disabled">
                      {id} · {when}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmbedWidget({ w }: { w: Extract<Widget, { type: 'embed' }> }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-meta font-medium text-secondary">{w.heading}</div>
      <div className="rounded-card border border-hairline bg-surface p-3.5 shadow-card">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-meta font-semibold text-display">{w.title}</div>
            <div className="font-mono text-micro text-disabled">{w.date}</div>
          </div>
          <span className="shrink-0 rounded-full border border-hairline bg-raised px-2 py-0.5 font-mono text-micro text-secondary">report</span>
        </div>
        <div className="mt-3 flex flex-col gap-1.5 border-t border-hairline pt-3">
          {w.lines.map((l, i) =>
            i === 0 ? (
              <div key={i} className="text-meta font-medium text-primary">
                {l}
              </div>
            ) : (
              <div key={i} className="flex gap-2 text-caption text-secondary">
                <span className="text-disabled">—</span>
                <span className="min-w-0">{l}</span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  )
}

function MetricWidget({ w }: { w: Extract<Widget, { type: 'metric' }> }) {
  const s = w.series
  const now = s[s.length - 1] ?? 0
  const start = s[0] ?? 0
  const delta = now - start
  const good = w.betterDown ? delta < 0 : delta > 0
  return (
    <div className="min-w-0 rounded-card border border-hairline bg-surface p-3.5 shadow-card">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-label font-semibold text-primary">{w.label}</span>
        <span className="ml-auto font-mono text-body font-semibold text-display">{now}</span>
        {delta !== 0 && (
          <span className="font-mono text-caption" style={{ color: good ? 'var(--color-success)' : 'var(--color-accent)' }}>
            {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}
          </span>
        )}
      </div>
      <AreaTrend series={s} />
      {w.note && <p className="mt-2 font-mono text-caption text-secondary">{w.note}</p>}
    </div>
  )
}

/** A single-series area trend, drawn like LoopChart: horizontal grid, mono axis
 *  ticks, gradient fill in the chart-1 (display) ink. The gradient id derives from
 *  the series itself (pure — no useId/useMemo, this renders during SSR). */
function AreaTrend({ series }: { series: number[] }) {
  const gid = `lpf-grad-${Math.round(series.reduce((a, b) => a + b, 0))}-${series.length}`
  const W = 320
  const H = 150
  const padL = 26
  const padR = 8
  const padT = 10
  const padB = 18
  const dmin = Math.min(...series)
  const dmax = Math.max(...series)
  const span = Math.max(1, dmax - dmin)
  let lo = Math.floor(dmin - span * 0.15)
  const hi = Math.ceil(dmax + span * 0.15)
  if (dmin >= 0 && lo < 0) lo = 0 // counts / percentages never go negative
  const X = (i: number) => padL + (i * (W - padL - padR)) / (series.length - 1)
  const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB)
  const f = (n: number) => Math.round(n * 100) / 100
  const line = 'M' + series.map((v, i) => `${f(X(i))} ${f(Y(v))}`).join(' L ')
  const area = `${line} L ${f(X(series.length - 1))} ${H - padB} L ${f(X(0))} ${H - padB} Z`
  const ticks = [lo, Math.round((lo + hi) / 2), hi]
  const last = series.length - 1
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="block" role="img" aria-label="metric trend">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-chart-1)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--color-chart-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={padL} y1={f(Y(v))} x2={W - padR} y2={f(Y(v))} stroke="var(--color-hairline)" strokeWidth={1} />
          <text x={padL - 6} y={f(Y(v)) + 3} textAnchor="end" fontFamily="var(--font-mono)" fontSize={9} fill="var(--color-disabled)">
            {v}
          </text>
        </g>
      ))}
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="var(--color-chart-1)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={f(X(last))} cy={f(Y(series[last] ?? 0))} r={3} fill="var(--color-chart-1)" stroke="var(--color-surface)" strokeWidth={1.5} />
      <text x={padL} y={H - 5} fontFamily="var(--font-mono)" fontSize={9} fill="var(--color-disabled)">
        older
      </text>
      <text x={W - padR} y={H - 5} textAnchor="end" fontFamily="var(--font-mono)" fontSize={9} fill="var(--color-disabled)">
        now
      </text>
    </svg>
  )
}
