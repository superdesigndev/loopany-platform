// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { LoopView } from './LoopView'
import type { RunSummary } from '../types'

// jsdom has no ResizeObserver and no layout, so Recharts' ResponsiveContainer
// would measure 0×0 and render nothing. This stub reports a fixed 640×190 on
// observe — the chart then lays out at a real size.
class RO {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe(el: Element) {
    this.cb(
      [{ target: el, contentRect: { width: 640, height: 190 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Exact production template + runs for loop-mqm5j7q4-0415991c
const HTML =
  '<div><h3>🌡️ homelab iLO 温度</h3>' +
  '<div>CPU {{latest.cpu}}℃ 进风口 {{latest.inlet}}℃</div>' +
  '<loop-chart series="cpu:CPU:℃, inlet:进风口:℃" window="24" points="24" range="24h"></loop-chart>' +
  '</div>'

const mk = (ts: string, state: Record<string, number> | null): RunSummary =>
  ({ id: 'r-' + ts, ts, outcome: 'new', status: null, message: null, state }) as unknown as RunSummary

// Detail order = newest-first
const RUNS: RunSummary[] = [
  mk('2026-06-20T13:30:12.514Z', null),
  mk('2026-06-20T13:00:02.108Z', { cpu: 40, inlet: 31 }),
  mk('2026-06-20T12:00:01.146Z', { cpu: 40, inlet: 31 }),
  mk('2026-06-20T11:05:18.210Z', null),
  mk('2026-06-20T11:00:01.850Z', { cpu: 40, inlet: 30 }),
]

/** Static render — fine for the sanitize/binding surface (no effects needed). */
const render = (html: string, runs: RunSummary[] = RUNS) =>
  renderToStaticMarkup(createElement(LoopView, { html, runs, loopId: 'loop-1' }))

/** Client render under act() — Recharts v3 mounts its SVG via effects. */
async function mount(html: string, runs: RunSummary[] = RUNS): Promise<string> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(LoopView, { html, runs, loopId: 'loop-1' }))
  })
  const out = host.innerHTML
  await act(async () => root.unmount())
  host.remove()
  return out
}

describe('LoopView <loop-chart>', () => {
  it('renders a multi-series chart from the real template + runs', async () => {
    const out = await mount(HTML)
    // Regression: DOMPurify used to strip the colon/comma-laden `series` value,
    // leaving an empty <loop-chart> that rendered nothing. The Recharts chart
    // draws at its initialDimension, one line per series.
    expect(out).toContain('<svg')
    expect(out.match(/recharts-line-curve/g)).toHaveLength(2) // one stroked curve per series
    expect(out).toContain('进风口') // legend label survived sanitize
    expect(out).toContain('40℃') // {{latest.cpu}} binding resolved
  })

  it('renders a single-point series as a dot instead of nothing', async () => {
    const out = await mount('<loop-chart series="cpu:CPU:℃"></loop-chart>', [
      mk('2026-06-20T13:00:02.108Z', { cpu: 40 }),
    ])
    expect(out).toContain('<svg')
    expect(out).toContain('recharts-area') // single series → gradient area chart
    expect(out).toContain('recharts-dot') // the lone point is a visible dot
  })

  it('drops a stale <loop-sparkline> tag without crashing (retired primitive)', () => {
    // The sparkline primitive was retired in favor of <loop-chart>. Old dashboards
    // may still contain the tag; the sanitizer strips the now-unallowlisted element
    // and the surrounding template renders normally — no crash, no error banner.
    const out = render(
      '<div><h3>temps</h3><loop-sparkline key="cpu"></loop-sparkline>' +
        '<loop-chart series="cpu:CPU:℃"></loop-chart></div>',
    )
    expect(out).toContain('temps') // surrounding markup survives
    expect(out).not.toContain('loop-sparkline') // the unknown tag is gone
  })
})

describe('LoopView retired artifact primitives', () => {
  it('silently drops artifact-backed tags while preserving metrics panels', () => {
    const out = render(
      '<section><h3>score</h3></section>' +
      '<loop-embed match="reports/*.md"></loop-embed>' +
      '<loop-calendar></loop-calendar>' +
      '<loop-kanban columns="open,done"></loop-kanban>',
    )
    expect(out).toContain('score')
    expect(out).not.toMatch(/loop-(embed|calendar|kanban)/)
    expect(out).not.toContain('data source is retired')
  })
})
