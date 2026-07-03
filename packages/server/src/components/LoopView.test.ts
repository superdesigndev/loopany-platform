// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
import { LoopView } from './LoopView'
import { getArtifacts } from '../server/loopApi'
import type { RunSummary } from '../types'

// The artifact-list fetch resolves empty so mounted embed/calendar tests can
// observe the post-fetch state without a server.
vi.mock('../server/loopApi', () => ({
  getArtifacts: vi.fn(async () => []),
  getArtifact: vi.fn(async () => ({ text: 'digest body' })),
}))

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

describe('LoopView artifact primitives', () => {
  it('keeps the glob-laden match attr through sanitize (loop-embed reaches its renderer)', () => {
    // Regression twin of the `series` force-keep: `match` carries `*` and `/`,
    // which DOMPurify would otherwise strip, silently blanking the embed. With
    // no artifact fetch yet (static render), the shell shows the requested
    // pattern — proving the attribute survived end-to-end.
    const out = render('<loop-embed match="reports/digest-*.md"></loop-embed>')
    expect(out).toContain('reports/digest-*.md')
    expect(out).toContain('Loading…')
  })

  it('renders loop-calendar and keeps its match attr', () => {
    const out = render('<loop-calendar match="reports/*.md"></loop-calendar>')
    expect(out).toContain('Loading…')
  })

  it('keeps the comma-laden columns attr through sanitize (loop-kanban reaches its renderer)', async () => {
    // `columns="research,in-progress,done"` carries commas DOMPurify would
    // otherwise strip, leaving an empty <loop-kanban> that renders the "needs
    // columns=" hint. The force-keep hook + wantsArtifacts detection must both
    // fire, so the board reaches its renderer and (with an empty list) renders
    // the declared column headers rather than the authoring hint.
    const out = await mount('<loop-kanban columns="research,in-progress,done" match="notes/*.md"></loop-kanban>')
    expect(out).not.toContain('needs columns=')
    expect(out).toContain('in-progress') // a declared column header survived end-to-end
  })

  it('shows the authoring hint when loop-embed has no target attr', () => {
    const out = render('<loop-embed></loop-embed>')
    expect(out).toContain('needs file=')
  })

  it('fires the artifact fetch for an uppercase-authored tag (detection is on the sanitized html)', async () => {
    // DOMPurify lowercases tag names, so <LOOP-EMBED> still reaches the parser
    // swap. The fetch trigger must see the sanitized string too, or the embed
    // sticks at "Loading…" forever.
    const out = await mount('<LOOP-EMBED match="reports/*.md"></LOOP-EMBED>')
    expect(out).not.toContain('Loading…')
    expect(out).toContain('No synced file matches yet')
  })

  it('retries a failed artifact fetch instead of latching an empty list', async () => {
    // One transient network blip on mount used to pin "No synced file matches
    // yet" until the next run settled (the effect deps don't move in between).
    vi.useFakeTimers()
    try {
      const file = { path: 'reports/digest-2026-07-01.md', size: 10, updatedAt: '2026-07-01T08:00:00.000Z', binary: false, oversize: false, meta: null }
      vi.mocked(getArtifacts).mockClear()
      vi.mocked(getArtifacts).mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce([file])
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(createElement(LoopView, { html: '<loop-embed match="reports/*.md"></loop-embed>', runs: RUNS, loopId: 'loop-1' }))
      })
      // Failure keeps the loading state - never the misleading calm empty.
      expect(host.innerHTML).toContain('Loading…')
      expect(host.innerHTML).not.toContain('No synced file matches yet')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(vi.mocked(getArtifacts)).toHaveBeenCalledTimes(2)
      expect(host.innerHTML).toContain('digest-2026-07-01.md')
      await act(async () => root.unmount())
      host.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('excludes the task file from <loop-embed match=> results', async () => {
    // The spec README syncs on every edit, so under a broad glob its sync-day
    // date would outrank yesterday's date-stamped digest. Same rule as the
    // calendar's default set; an exact file= path may still target it.
    const mkFile = (path: string, updatedAt: string) => ({ path, size: 10, updatedAt, binary: false, oversize: false, meta: null })
    vi.mocked(getArtifacts).mockClear()
    vi.mocked(getArtifacts).mockResolvedValue([
      mkFile('README.md', '2026-07-02T09:00:00.000Z'),
      mkFile('digest-2026-07-01.md', '2026-07-01T08:00:00.000Z'),
    ])
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        createElement(LoopView, {
          html: '<loop-embed match="*.md"></loop-embed>',
          runs: RUNS,
          loopId: 'loop-1',
          taskFile: '/Users/me/work/loop/README.md',
        }),
      )
    })
    expect(host.innerHTML).toContain('digest-2026-07-01.md')
    expect(host.innerHTML).toContain('newest of 1 matching')
    await act(async () => root.unmount())
    host.remove()
    vi.mocked(getArtifacts).mockReset()
    vi.mocked(getArtifacts).mockResolvedValue([])
  })

  it('re-fetches artifacts when the newest run settles (not only when a new run id appears)', async () => {
    // A run's files land on its FINAL sync, so keying the fetch on the run id
    // alone would show run N's output only once run N+1 starts.
    const embed = '<loop-embed match="reports/*.md"></loop-embed>'
    const live = { ...mk('2026-06-20T14:00:00.000Z', null), running: true }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    vi.mocked(getArtifacts).mockClear()
    await act(async () => {
      root.render(createElement(LoopView, { html: embed, runs: [live, ...RUNS], loopId: 'loop-1' }))
    })
    expect(vi.mocked(getArtifacts)).toHaveBeenCalledTimes(1)
    const settled = { ...live, running: false }
    await act(async () => {
      root.render(createElement(LoopView, { html: embed, runs: [settled, ...RUNS], loopId: 'loop-1' }))
    })
    expect(vi.mocked(getArtifacts)).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
    host.remove()
  })
})
