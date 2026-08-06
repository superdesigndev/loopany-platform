import { useMemo, useState, type ReactNode } from 'react'
import parse, { domToReact, Element, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser'

import { parseSeries } from '../../lib/binding'
import { sanitizeLoopUi } from '../../lib/loopUi'
import type { RunSummary } from '../../types'
import type { LoopRunRow, LoopStateField } from './api'

const PALETTE = ['var(--blue)', 'var(--green)', 'var(--violet)', 'var(--amber)', 'var(--red)']

function reportRuns(runs: LoopRunRow[]): RunSummary[] {
  return runs.map((run) => ({
    id: run.id,
    loopId: '',
    ts: run.startedAt ?? '',
    running: run.state === 'running' || run.state === 'queued',
    role: run.role,
    outcome: run.outcome ?? 'silent',
    status: run.status,
    message: run.summary,
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    usage: null,
    error: run.error,
    state: run.metrics,
    control: null,
    sessionId: run.sessionId,
    artifacts: run.artifacts,
    progress: run.progress,
  }))
}

export interface TrendPoint {
  t: string
  v: number
}

export function metricPoints(runs: LoopRunRow[], key: string): TrendPoint[] {
  return runs
    .flatMap((run) => {
      const value = run.metrics?.[key]
      return typeof value === 'number' && Number.isFinite(value) && run.startedAt ? [{ t: run.startedAt, v: value }] : []
    })
    .sort((a, b) => a.t.localeCompare(b.t))
}

export function trendPath(points: TrendPoint[], width = 600, height = 118): { d: string; dots: { x: number; y: number }[] } {
  if (!points.length) return { d: '', dots: [] }
  const values = points.map((point) => point.v)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const dots = points.map((point, index) => ({
    x: points.length === 1 ? width / 2 : (index / (points.length - 1)) * width,
    y: height - ((point.v - min) / span) * height,
  }))
  return { d: dots.map((dot, index) => `${index ? 'L' : 'M'} ${dot.x.toFixed(2)} ${dot.y.toFixed(2)}`).join(' '), dots }
}

function withUnit(value: number, unit = ''): string {
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
  return unit === '$' ? `$${formatted}` : `${formatted}${unit}`
}

function MetricChart({ field, runs, color }: { field: LoopStateField; runs: LoopRunRow[]; color: string }) {
  const points = metricPoints(runs, field.key)
  const geometry = trendPath(points)
  const latest = points.at(-1)
  return (
    <figure className="ws-metric-chart">
      <figcaption>
        <span>{field.label ?? field.key}</span>
        <strong>{latest ? withUnit(latest.v, field.unit) : '—'}</strong>
      </figcaption>
      {points.length ? (
        <>
          <svg viewBox="0 0 600 132" role="img" aria-label={`${field.label ?? field.key} trend, ${points.length} reports`} preserveAspectRatio="none">
            <line x1="0" y1="30" x2="600" y2="30" />
            <line x1="0" y1="74" x2="600" y2="74" />
            <line x1="0" y1="118" x2="600" y2="118" />
            <path d={geometry.d} style={{ stroke: color }} />
            {geometry.dots.map((dot, index) => (
              <circle key={points[index]!.t} cx={dot.x} cy={dot.y} r={points.length === 1 ? 4 : 2.5} style={{ fill: color }}>
                <title>{`${new Date(points[index]!.t).toLocaleString()}: ${withUnit(points[index]!.v, field.unit)}`}</title>
              </circle>
            ))}
          </svg>
          <div className="ws-chart-range">
            <time>{new Date(points[0]!.t).toLocaleDateString()}</time>
            <span>{points.length} report{points.length === 1 ? '' : 's'}</span>
            <time>{new Date(points.at(-1)!.t).toLocaleDateString()}</time>
          </div>
        </>
      ) : (
        <p className="ws-chart-empty">No numeric reports for <code>{field.key}</code> yet.</p>
      )}
    </figure>
  )
}

export function MetricTrends({ fields, runs }: { fields: LoopStateField[]; runs: LoopRunRow[] }) {
  if (!fields.length) return null
  return (
    <div className="ws-metric-grid">
      {fields.map((field, index) => <MetricChart key={field.key} field={field} runs={runs} color={PALETTE[index % PALETTE.length]!} />)}
    </div>
  )
}

function DashboardTabs({ labels, panels }: { labels: string[]; panels: ReactNode[] }) {
  const tabs = labels.slice(0, panels.length)
  const [active, setActive] = useState(0)
  if (!tabs.length) return null
  const current = Math.min(active, tabs.length - 1)
  return (
    <div className="ws-dashboard-tabs">
      <div role="tablist">
        {tabs.map((label, index) => (
          <button key={`${index}:${label}`} type="button" role="tab" aria-selected={current === index} onClick={() => setActive(index)}>{label}</button>
        ))}
      </div>
      <div role="tabpanel">{panels[current]}</div>
    </div>
  )
}

/**
 * Workspace-native renderer for the loop's sanitized metrics `ui` body.
 */
export function LoopDashboard({ html, runs }: { html: string; runs: LoopRunRow[] }) {
  const summaries = useMemo(() => reportRuns(runs), [runs])
  const clean = useMemo(() => sanitizeLoopUi(html, summaries), [html, summaries])
  const options: HTMLReactParserOptions = useMemo(() => ({
    replace: (node) => {
      if (!(node instanceof Element)) return undefined
      const attrs = node.attribs ?? {}
      if (node.name === 'loop-chart') return <MetricTrends fields={parseSeries(attrs.series)} runs={runs} />
      if (node.name === 'loop-tabs') {
        const labels = (attrs.tabs ?? '').split(',').map((label) => label.trim()).filter(Boolean)
        const panels = node.children
          .filter((child): child is Element => child instanceof Element && child.name === 'section')
          .map((section) => domToReact(section.children as DOMNode[], options))
        return <DashboardTabs labels={labels} panels={panels} />
      }
      return undefined
    },
  }), [runs])

  return <div className="ws-dashboard">{parse(clean, options)}</div>
}
