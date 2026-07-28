import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TemplateInfo } from '../types'
import { FLOWS, type Card, type FlowSpec, type NodeDef, type Widget } from '../lib/templateFlow'

/**
 * Template-modal preview — the right column of the (wide) template modal, beside
 * the paste prompt. Two tabs give the mental model at a glance:
 *   • Loop flow — how the loop runs: a vertical cycle (scheduled tick → steps, the
 *     ones done in an isolated git worktree grouped in a box → daily/weekly repeat).
 *   • Dashboard — what it leaves behind, drawn to match the real dashboard widgets
 *     (LoopKanban / LoopChart / LoopEmbed) so the preview reads like the actual
 *     product surface the loop builds.
 *
 * A template declares its nodes (+ which run in the worktree) and its dashboard
 * WIDGETS; `buildGeometry` lays the vertical diagram out (positions, wires, the
 * return leg, the worktree box) so a new template is pure data — no coordinates.
 *
 * The flow's token rides the SVG wire and lights each step in turn (imperative rAF,
 * so it never re-renders React); the `.lpf-*` classes + the reduced-motion guard
 * live in app.css. Pure SVG/HTML + theme vars — no Recharts — so it's safe to import
 * into the eagerly-loaded ComposeModal without weighting the base bundle.
 *
 * The SPECS themselves live in `lib/templateFlow.tsx` (pure data, shared with the
 * public detail page's static diagram, so the two can never describe different flows).
 * Templates without a spec render nothing, so the modal falls back to its plain
 * single-column snippet screen.
 */

// ── Geometry (vertical layout generator) ─────────────────────────────────────
const VIEW_W = 344
const NODE_X = 68
const NODE_W = 248
const NODE_H = 64 // fits a two-line detail comfortably (setup gates get more, via hOf)
const CX = NODE_X + NODE_W / 2 // 192
const TOP = 6
const LANE_X = 30
const WT_X = 48
const WT_W = 280
const WT_PAD_TOP = 18
const WT_PAD_BOT = 16

type Positioned = NodeDef & { kind: 'tick' | 'step' | 'setup' | 'finish'; x: number; y: number; w: number; h: number }
type Geometry = { nodes: Positioned[]; wires: string[]; route: string; worktree: { x: number; y: number; w: number; h: number } | null; returnWireIndex: number; finishWireIndex: number; viewW: number; viewH: number }

// Setup gates carry a longer, two-line detail, so they get a taller box; the
// generator threads each node's own height through spacing / wires / the box.
const hOf = (d: NodeDef) => (d.setup ? 78 : NODE_H)

function buildGeometry(defs: NodeDef[]): Geometry {
  const tickIndex = defs.findIndex((d) => !d.setup) // first non-setup node = the tick
  const finishIndex = defs.findIndex((d) => d.finish) // -1 when the loop is open
  const closed = finishIndex >= 0
  const nodes: Positioned[] = []
  let y = TOP
  defs.forEach((d, i) => {
    if (i > 0) {
      const prevWt = !!defs[i - 1]!.wt
      const curWt = !!d.wt
      const gap = !prevWt && curWt ? 48 : prevWt && curWt ? 30 : 36
      y += hOf(defs[i - 1]!) + gap
    }
    const kind = d.finish ? 'finish' : d.setup ? 'setup' : i === tickIndex ? 'tick' : 'step'
    nodes.push({ ...d, kind, x: NODE_X, y, w: NODE_W, h: hOf(d) })
  })

  const wt = nodes.filter((n) => n.wt)
  const worktree = wt.length
    ? { x: WT_X, y: wt[0]!.y - WT_PAD_TOP, w: WT_W, h: wt[wt.length - 1]!.y + wt[wt.length - 1]!.h + WT_PAD_BOT - (wt[0]!.y - WT_PAD_TOP) }
    : null

  // Forward wires between every consecutive node (setup → tick and check → finish included).
  const wires: string[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    wires.push(`M${CX} ${nodes[i]!.y + nodes[i]!.h} L${CX} ${nodes[i + 1]!.y - 4}`)
  }
  // The solid forward exit into a closed loop's green terminus (check → finish).
  const finishWireIndex = closed ? finishIndex - 1 : -1

  const tickNode = nodes[tickIndex]!
  const tickMidY = tickNode.y + tickNode.h / 2
  // The last CYCLIC node: "Check" for a closed loop, else the last node.
  const cycleEnd = closed ? finishIndex - 1 : nodes.length - 1
  const cycleLast = nodes[cycleEnd]!

  const returnWireIndex = wires.length
  let route: string
  let viewH: number
  if (closed) {
    // Dashed loop-back exits the last cyclic node's LEFT edge, up the lane, into the
    // tick's left edge — "keep looping UNTIL the goal is met" — freeing the bottom
    // edge for the solid forward exit into the green finish terminus.
    const midY = cycleLast.y + cycleLast.h / 2
    wires.push(
      `M${NODE_X} ${midY} L${LANE_X + 6} ${midY} Q${LANE_X} ${midY} ${LANE_X} ${midY - 6} L${LANE_X} ${tickMidY + 6} Q${LANE_X} ${tickMidY} ${LANE_X + 6} ${tickMidY} L${NODE_X - 4} ${tickMidY}`,
    )
    const centers = nodes.slice(tickIndex, finishIndex).map((n) => `${CX} ${n.y + n.h / 2}`).join(' L ')
    route = `M${centers} L${LANE_X} ${midY} L${LANE_X} ${tickMidY} L${NODE_X - 4} ${tickMidY}`
    const finishNode = nodes[finishIndex]!
    viewH = finishNode.y + finishNode.h + 14
  } else {
    const laneY = cycleLast.y + cycleLast.h + 28
    // last step → down → left lane → up → into the tick's left edge (the repeat).
    wires.push(
      `M${CX} ${cycleLast.y + cycleLast.h} L${CX} ${laneY - 6} Q${CX} ${laneY} ${CX - 6} ${laneY} L${LANE_X + 6} ${laneY} Q${LANE_X} ${laneY} ${LANE_X} ${laneY - 6} L${LANE_X} ${tickMidY + 6} Q${LANE_X} ${tickMidY} ${LANE_X + 6} ${tickMidY} L${NODE_X - 4} ${tickMidY}`,
    )
    const centers = nodes.slice(tickIndex).map((n) => `${CX} ${n.y + n.h / 2}`).join(' L ')
    route = `M${centers} L${CX} ${laneY} L${LANE_X} ${laneY} L${LANE_X} ${tickMidY} L${NODE_X - 4} ${tickMidY}`
    viewH = laneY + 14
  }

  return { nodes, wires, route, worktree, returnWireIndex, finishWireIndex, viewW: VIEW_W, viewH }
}

// ── Component ────────────────────────────────────────────────────────────────
export function LoopFlow({ template }: { template: TemplateInfo }) {
  const spec = FLOWS[template.name]
  const [tab, setTab] = useState<'flow' | 'dashboard'>('flow')
  if (!spec) return null

  return (
    <div className="min-w-0">
      <div className="mb-4 inline-flex rounded-full border border-hairline bg-raised p-0.5 text-label">
        <TabBtn active={tab === 'flow'} onClick={() => setTab('flow')}>
          Loop flow
        </TabBtn>
        <TabBtn active={tab === 'dashboard'} onClick={() => setTab('dashboard')}>
          Dashboard
        </TabBtn>
      </div>
      {tab === 'flow' ? <FlowDiagram spec={spec} /> : <Dashboard spec={spec} />}
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-full px-3.5 py-1.5 font-medium transition-colors ${
        active ? 'bg-surface text-display shadow-card' : 'text-secondary hover:text-display'
      }`}
    >
      {children}
    </button>
  )
}

function FlowDiagram({ spec }: { spec: FlowSpec }) {
  const geo = useMemo(() => buildGeometry(spec.nodes), [spec])
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const route = root.querySelector<SVGPathElement>('.lpf-route')
    const pulse = root.querySelector<SVGCircleElement>('.lpf-pulse')
    const comet = root.querySelector<SVGPathElement>('.lpf-comet')
    if (!route || !pulse || !comet) return

    const total = route.getTotalLength()
    const SAMPLES = 600
    const samp: [number, number, number][] = []
    for (let i = 0; i <= SAMPLES; i++) {
      const L = (total * i) / SAMPLES
      const p = route.getPointAtLength(L)
      samp.push([L, p.x, p.y])
    }
    const lenAt = (x: number, y: number) => {
      let best = 0
      let bd = Infinity
      for (const s of samp) {
        const d = (s[1] - x) ** 2 + (s[2] - y) ** 2
        if (d < bd) {
          bd = d
          best = s[0]
        }
      }
      return best
    }
    const nodeEls = new Map<string, HTMLElement>()
    root.querySelectorAll<HTMLElement>('[data-lpf]').forEach((el) => nodeEls.set(el.dataset.lpf!, el))
    const order = geo.nodes
      .filter((n) => n.kind !== 'setup' && n.kind !== 'finish') // one-time gate / terminus aren't in the cycle
      .map((n) => ({ len: lenAt(n.x + n.w / 2, n.y + n.h / 2), el: nodeEls.get(n.id)! }))
      .filter((n) => n.el)
      .sort((a, b) => a.len - b.len)

    const SPEED = 210 / 1000
    const DWELL = 520
    const segs: { type: 'dwell' | 'move' | 'return'; from?: number; to?: number; at?: (typeof order)[number]; dur: number; restart?: boolean }[] = []
    const first = order[0]!
    const lastN = order[order.length - 1]!
    segs.push({ type: 'dwell', at: first, dur: DWELL })
    for (let i = 0; i < order.length - 1; i++) {
      const a = order[i]!
      const b = order[i + 1]!
      segs.push({ type: 'move', from: a.len, to: b.len, dur: Math.max(360, (b.len - a.len) / SPEED) })
      segs.push({ type: 'dwell', at: b, dur: DWELL })
    }
    segs.push({ type: 'return', from: lastN.len, to: total, dur: Math.max(720, (total - lastN.len) / SPEED) })
    segs.push({ type: 'dwell', at: first, dur: 160, restart: true })

    const COMET = 52
    comet.setAttribute('stroke-dasharray', `${COMET} ${total}`)
    const place = (L: number) => {
      const c = Math.max(0, Math.min(total, L))
      const p = route.getPointAtLength(c)
      pulse.setAttribute('cx', p.x.toFixed(2))
      pulse.setAttribute('cy', p.y.toFixed(2))
      comet.setAttribute('stroke-dashoffset', (-(L - COMET * 0.5)).toFixed(2))
    }
    const clearActive = () => order.forEach((n) => n.el.classList.remove('active'))
    const resetPass = () => order.forEach((n) => n.el.classList.remove('visited'))
    const activate = (n: (typeof order)[number]) => {
      clearActive()
      n.el.classList.add('active', 'visited')
    }

    let si = 0
    let t0 = performance.now()
    let raf = 0
    const frame = (now: number) => {
      let seg = segs[si]!
      const e = now - t0
      if (e >= seg.dur) {
        if ((seg.type === 'move' || seg.type === 'return') && seg.to != null) place(seg.to)
        si = (si + 1) % segs.length
        t0 = now
        seg = segs[si]!
        if (seg.restart) resetPass()
        if (seg.type === 'dwell' && seg.at) {
          activate(seg.at)
          place(seg.at.len)
        }
        if (seg.type === 'return') clearActive()
      } else if ((seg.type === 'move' || seg.type === 'return') && seg.from != null && seg.to != null) {
        const k = e / seg.dur
        const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
        place(seg.from + (seg.to - seg.from) * ease)
      } else if (seg.at) {
        place(seg.at.len)
      }
      raf = requestAnimationFrame(frame)
    }
    activate(first)
    place(first.len)
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [geo])

  return (
    <div ref={rootRef}>
      <div className="overflow-x-auto">
        <div className="relative mx-auto" style={{ width: geo.viewW, height: geo.viewH }}>
          <svg className="absolute inset-0" width={geo.viewW} height={geo.viewH} viewBox={`0 0 ${geo.viewW} ${geo.viewH}`} aria-hidden="true">
            <defs>
              {/* Fixed-size arrowhead (userSpaceOnUse) — otherwise it scales with the stroke. */}
              <marker id="lpf-arw" markerUnits="userSpaceOnUse" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                <path d="M1.2 1.2 L7 4 L1.2 6.8 Z" fill="var(--color-interactive)" />
              </marker>
              <marker id="lpf-arw-good" markerUnits="userSpaceOnUse" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                <path d="M1.2 1.2 L7 4 L1.2 6.8 Z" fill="var(--color-success)" />
              </marker>
              <filter id="lpf-glow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="2.4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <path className="lpf-route" fill="none" d={geo.route} />
            </defs>
            {geo.wires.map((d, i) => {
              const isFinish = i === geo.finishWireIndex
              return (
                <path
                  key={i}
                  className={isFinish ? 'lpf-wire finish' : 'lpf-wire'}
                  d={d}
                  fill="none"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeDasharray={i === geo.returnWireIndex ? '6 6' : undefined}
                  markerEnd={isFinish ? 'url(#lpf-arw-good)' : 'url(#lpf-arw)'}
                />
              )
            })}
            <path className="lpf-comet" d={geo.route} fill="none" strokeWidth={2.5} strokeLinecap="round" filter="url(#lpf-glow)" opacity={0.9} />
            <circle className="lpf-pulse" r={3.8} filter="url(#lpf-glow)" />
          </svg>

          {geo.worktree && (
            <div
              className="absolute rounded-[14px] border border-dashed"
              style={{ left: geo.worktree.x, top: geo.worktree.y, width: geo.worktree.w, height: geo.worktree.h, borderColor: 'var(--color-interactive)', background: 'var(--color-interactive-soft)' }}
            >
              <span
                className="absolute px-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em]"
                style={{ top: -9, left: 16, background: 'var(--color-surface)', color: 'var(--color-interactive)' }}
              >
                {spec.worktreeLabel}
              </span>
            </div>
          )}

          {geo.nodes.map((n) => (
            <div key={n.id} data-lpf={n.id} className={`lpf-node${n.kind === 'tick' ? ' tick' : ''}`} style={{ left: n.x, top: n.y, width: n.w, height: n.h }}>
              <div className="lpf-k">
                <span className="g">{n.glyph}</span>
                {n.kicker}
              </div>
              <div className="lpf-t">{n.title}</div>
              <div className="lpf-d">{n.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Dashboard widgets ────────────────────────────────────────────────────────
function Dashboard({ spec }: { spec: FlowSpec }) {
  return (
    <div className="min-w-0">
      <p className="mb-4 text-body leading-snug text-secondary">Loopany sets up a dashboard to track results.</p>
      {spec.dashboard.map((w, i) => (
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
 *  that produced a report. grid-cols-7 fills the ~360px column and reflows (min-w-0). */
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
          the modal — mirrors the real LoopKanban. */}
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
 *  ticks, gradient fill in the chart-1 (display) ink. */
function AreaTrend({ series }: { series: number[] }) {
  const gid = useMemo(() => `lpf-grad-${Math.round(series.reduce((a, b) => a + b, 0))}-${series.length}`, [series])
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
