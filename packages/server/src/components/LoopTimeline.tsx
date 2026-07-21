import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'

import type { TimelineData, TimelineLoop, TimelineMark } from '../types'
import { listTimeline } from '../server/loopApi'
import { dotColor, dotLabel, dur, money } from '../lib/format'
import { runPulseAnim, selectCls, useHydrated } from './ui'

/*
 * The cross-loop timeline: ONE form at every zoom — row = loop, x = time.
 *
 * Deliberately NOT a merged calendar. A run is a POINT event a few minutes long,
 * so a Gantt bar has no length to read and a shared day-cell turns into a pile of
 * overlapping chips. Lanes over a shared time axis give the same contention read
 * as a calendar — simultaneous fires line up VERTICALLY across lanes — without
 * the mess, and they scale to any number of loops.
 *
 * Colour stays on STATUS (`dotColor`, shared with the loop card's run strip);
 * loop identity is the row label. Hue is a bounded resource (~5-8 usable slots)
 * and loops are unbounded, so identity takes position + label instead.
 *
 * Everything right of the now-line is a PROJECTED cron fire, not a run.
 */

export type Zoom = 'day' | 'week' | 'month'

const HOUR = 3_600_000
const DAY = 86_400_000

/** Zoom → the window it requests, relative to `now`. Day is the DEFAULT: it
 *  answers "what's happening today, and what's about to". */
export function windowFor(zoom: Zoom, now: Date): { from: Date; to: Date } {
  if (zoom === 'day') {
    const from = new Date(now)
    from.setHours(0, 0, 0, 0)
    return { from, to: new Date(from.getTime() + DAY) }
  }
  if (zoom === 'week') {
    return { from: new Date(now.getTime() - 5 * DAY), to: new Date(now.getTime() + 2 * DAY) }
  }
  return { from: new Date(now.getTime() - 29 * DAY), to: new Date(now.getTime() + 3 * DAY) }
}

/** Minimum on-screen width (px) of a mark, so a 2-minute run stays clickable
 *  even when a month window makes its true duration sub-pixel. */
const MIN_MARK_PX: Record<Zoom, number> = { day: 6, week: 8, month: 5 }

/** The lane geometry — name column, elastic track, window-total column. Shared by
 *  the axis row and every lane so the two can never fall out of alignment. */
const laneGrid =
  'grid gap-3 [grid-template-columns:var(--lane-name)_1fr_var(--lane-tot)] [--lane-name:190px] [--lane-tot:58px] max-sm:[--lane-name:110px] max-sm:[--lane-tot:48px]'

const pad = (n: number) => String(n).padStart(2, '0')
const dayLabel = (t: number) => {
  const d = new Date(t)
  return `${d.toLocaleString(undefined, { month: 'short' })} ${d.getDate()}`
}
const timeLabel = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** How a tick label sits over its position: edge ticks ANCHOR rather than centre,
 *  else half the label hangs off the track (day zoom always ticks at exactly 100%). */
function tickTransform(pct: number): string {
  if (pct >= 99) return 'translateX(-100%)'
  if (pct <= 1) return 'none'
  return 'translateX(-50%)'
}

/** Axis ticks for the window. */
function ticksFor(zoom: Zoom, from: number, to: number): Array<{ pct: number; label: string }> {
  const span = to - from
  const out: Array<{ pct: number; label: string }> = []
  if (zoom === 'day') {
    for (let h = 0; h <= 24; h += 3) {
      const t = from + h * HOUR
      out.push({ pct: ((t - from) / span) * 100, label: `${pad(h % 24)}:00` })
    }
    return out
  }
  const stepDays = zoom === 'month' ? 7 : 1
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  for (let t = d.getTime(); t <= to; t += stepDays * DAY) {
    if (t < from) continue
    out.push({ pct: ((t - from) / span) * 100, label: dayLabel(t) })
  }
  return out
}

/** Vertical gridlines: hours at day zoom, days otherwise (Mondays emphasised so a
 *  weekly cadence is readable at a glance). */
function gridFor(zoom: Zoom, from: number, to: number): Array<{ pct: number; strong: boolean }> {
  const span = to - from
  const out: Array<{ pct: number; strong: boolean }> = []
  if (zoom === 'day') {
    for (let h = 3; h < 24; h += 3) out.push({ pct: ((h * HOUR) / span) * 100, strong: false })
    return out
  }
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  for (let t = d.getTime(); t <= to; t += DAY) {
    if (t < from) continue
    out.push({ pct: ((t - from) / span) * 100, strong: new Date(t).getDay() === 1 })
  }
  return out
}

type Hover = { mark: TimelineMark; loop: TimelineLoop; x: number; y: number }

/**
 * Which lanes to draw, and how many were held back.
 *
 * A loop with neither a run nor a projected fire inside the window contributes
 * an unbroken empty track — pure noise at day zoom, where most loops simply
 * aren't due. Hidden by DEFAULT, but always counted: a silently dropped loop is
 * exactly the "is anything dead?" signal this view exists to surface, so the
 * caller can offer them in one click.
 *
 * Pure so the rule is testable without mounting the view.
 */
export function visibleLanes(
  loops: TimelineLoop[],
  marks: TimelineMark[],
  showIdle: boolean,
): { lanes: TimelineLoop[]; idleCount: number } {
  const busy = new Set(marks.map((m) => m.loopId))
  const active = loops.filter((l) => busy.has(l.id))
  return { lanes: showIdle ? loops : active, idleCount: loops.length - active.length }
}

const backLink = 'ml-auto text-label text-secondary hover:underline'

/**
 * The whole timeline PAGE — header, back link, view. Both routes (`/timeline` in
 * open mode and `/t/<id>/timeline` under the gate) render this and differ only in
 * whether a team is in scope, so the chrome lives here rather than being copied
 * into two route files that would drift.
 */
export function TimelinePage({ teamId }: { teamId?: string }) {
  return (
    <main className="mx-auto min-w-0 max-w-[1180px] px-8 pb-16 pt-10 max-sm:px-4">
      <div className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-display">Timeline</h1>
        <p className="text-label text-secondary">Every loop&apos;s runs and upcoming fires on one axis.</p>
        {teamId ? (
          <Link to="/t/$teamId" params={{ teamId }} className={backLink}>
            ← Back to loops
          </Link>
        ) : (
          <Link to="/" className={backLink}>
            ← Back to loops
          </Link>
        )}
      </div>
      {/* Re-key on the team so a /t/A → /t/B navigation re-seeds the fetch state
          (same route, new param ⇒ no natural remount), like DashboardView. */}
      <LoopTimeline key={teamId} teamId={teamId} />
    </main>
  )
}

export function LoopTimeline({ teamId }: { teamId?: string }) {
  const [zoom, setZoom] = useState<Zoom>('day')
  const [costMode, setCostMode] = useState(false)
  /** null ⇒ every device. Loops are bound to one machine, so this is a plain
   *  equality filter on the lane list. */
  const [machineId, setMachineId] = useState<string | null>(null)
  /** Reveal lanes with nothing in the window (hidden by default — see the lane memo). */
  const [showIdle, setShowIdle] = useState(false)
  const [data, setData] = useState<TimelineData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const hydrated = useHydrated()

  // The window is derived from a pinned `now` per fetch (not per render) so the
  // lanes don't jitter between paints.
  const [now, setNow] = useState(() => new Date())
  const win = useMemo(() => windowFor(zoom, now), [zoom, now])

  const load = useCallback(
    async (at: Date) => {
      const w = windowFor(zoom, at)
      try {
        const d = await listTimeline({
          data: { teamId, from: w.from.toISOString(), to: w.to.toISOString() },
        })
        setData(d)
        setError(null)
      } catch (e) {
        // Fetch-then-set: keep whatever is on screen rather than blanking the
        // view on a transient blip (same discipline as the dashboard poll).
        setError(String(e))
      }
    },
    [teamId, zoom],
  )

  // Load once, then keep refreshing. Slower than the dashboard's 3-10s: a month
  // window is a lot of rows, and a schedule view doesn't need second-level
  // freshness.
  useEffect(() => {
    const refresh = () => {
      const at = new Date()
      setNow(at)
      void load(at)
    }
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [load])

  const from = win.from.getTime()
  const to = win.to.getTime()
  const span = to - from
  const pct = (t: number) => ((t - from) / span) * 100
  const ticks = useMemo(() => ticksFor(zoom, from, to), [zoom, from, to])
  const grid = useMemo(() => gridFor(zoom, from, to), [zoom, from, to])

  const byLoop = useMemo(() => {
    const m = new Map<string, TimelineMark[]>()
    for (const mk of data?.marks ?? []) {
      const list = m.get(mk.loopId)
      if (list) list.push(mk)
      else m.set(mk.loopId, [mk])
    }
    return m
  }, [data])

  const maxCost = useMemo(() => {
    let max = 0
    for (const mk of data?.marks ?? []) if (mk.costUsd != null && mk.costUsd > max) max = mk.costUsd
    return max || 1
  }, [data])

  const nowPct = now.getTime() >= from && now.getTime() <= to ? pct(now.getTime()) : null
  const machines = data?.machines ?? []
  // Filtering is client-side over already-loaded lanes, so switching device is
  // instant and needs no refetch. A selection that vanishes from the payload
  // (its last loop deleted or rebound) resolves back to "all" rather than
  // silently rendering an empty board.
  const device = machineId != null && machines.some((m) => m.id === machineId) ? machineId : null

  /**
   * Lanes + the header tally, both scoped to the selected device — a filtered
   * board showing the unfiltered team total would contradict what's on screen.
   * Sums the way the server does: null costs excluded, never counted as zero.
   *
   * EMPTY LANES ARE HIDDEN BY DEFAULT. A loop with neither a run nor a projected
   * fire inside the window contributes an unbroken empty track, which is pure
   * noise at day zoom (where most loops simply aren't due). They stay countable
   * and one click away rather than vanishing — a silently dropped loop is
   * exactly the "is anything dead?" signal this view exists to surface.
   */
  const { loops, idleCount, shown } = useMemo(() => {
    const all = data?.loops ?? []
    const scoped = device == null ? all : all.filter((l) => l.machineId === device)
    if (!data) return { loops: scoped, idleCount: 0, shown: { runCount: 0, costUsd: 0 } }

    const { lanes, idleCount: idle } = visibleLanes(scoped, data.marks, showIdle)

    // The unfiltered total is already computed server-side; only recompute when
    // a device filter actually narrows the set.
    if (device == null) return { loops: lanes, idleCount: idle, shown: data.totals }
    const ids = new Set(scoped.map((l) => l.id))
    let runCount = 0
    let costUsd = 0
    for (const m of data.marks) {
      if (m.kind !== 'run' || !ids.has(m.loopId)) continue
      runCount++
      if (m.costUsd != null) costUsd += m.costUsd
    }
    return { loops: lanes, idleCount: idle, shown: { runCount, costUsd: Math.round(costUsd * 1e4) / 1e4 } }
  }, [data, device, showIdle])

  return (
    <section className="min-w-0">
      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-control border border-wire" role="group" aria-label="Zoom">
          {(['day', 'week', 'month'] as Zoom[]).map((z) => (
            <button
              key={z}
              type="button"
              aria-pressed={zoom === z}
              onClick={() => {
                setHover(null)
                setZoom(z)
              }}
              className={`cursor-pointer border-r border-hairline px-3.5 py-1.5 text-label capitalize last:border-r-0 ${
                zoom === z ? 'bg-display font-semibold text-paper' : 'text-secondary hover:bg-raised'
              }`}
            >
              {z}
            </button>
          ))}
        </div>
        <span className="font-mono text-caption text-secondary">
          {dayLabel(from)} → {dayLabel(to)}
        </span>
        {/* Device filter. Options come from the loops in scope, so it can never
            offer a machine that would empty the board. Hidden at one machine —
            a filter with a single choice is just noise. */}
        {machines.length > 1 && (
          <label className="inline-flex items-center gap-2 text-label text-secondary">
            <span className="sr-only">Filter by device</span>
            <select
              value={device ?? ''}
              onChange={(e) => {
                setHover(null)
                setMachineId(e.target.value || null)
              }}
              className={selectCls + ' w-auto py-1.5 text-label'}
            >
              <option value="">All devices ({data?.loops.length ?? 0})</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.loopCount})
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-4">
          {data && (
            <span className="font-mono text-caption text-secondary">
              {shown.runCount} runs · {money(shown.costUsd) || '$0.00'}
            </span>
          )}
          <label className="inline-flex cursor-pointer items-center gap-2 text-label text-secondary">
            <input type="checkbox" checked={costMode} onChange={(e) => setCostMode(e.target.checked)} />
            Cost mode
          </label>
        </div>
      </div>

      {error && (
        <p className="mb-3 text-label text-accent">Couldn&apos;t refresh the timeline — showing the last good data.</p>
      )}
      {data?.truncated && (
        <p className="mb-3 text-label text-secondary">
          This window has more runs than the view loads — some marks are not shown. Zoom in for a complete picture.
        </p>
      )}

      {/* axis */}
      <div className={`mb-1.5 items-end ${laneGrid}`}>
        <div />
        <div className="relative h-3.5 min-w-0">
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute whitespace-nowrap font-mono text-[9.5px] text-disabled"
              style={{ left: `${t.pct}%`, transform: tickTransform(t.pct) }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div />
      </div>

      {/* lanes */}
      <div className="flex min-w-0 flex-col gap-[3px]">
        {loops.map((loop) => {
          const marks = byLoop.get(loop.id) ?? []
          // Marks arrive oldest-first, so the last real one is the lane's current state.
          const lastReal = marks.findLast((m) => m.kind === 'run')
          const total = data?.totals.byLoop[loop.id]
          return (
            // `group` + a full-row tint on hover: lanes are only 22px tall and
            // the label sits ~200px from its marks, so tracing a mark back to
            // its loop by eye is genuinely hard without it. Uses a bg tint
            // rather than a border so the row height never shifts.
            <div
              key={loop.id}
              className={`group items-center rounded-[6px] py-px transition-colors hover:bg-[color:var(--color-display)]/[0.045] ${laneGrid}`}
            >
              {/* lane label — identity lives here, not in colour */}
              <div className="flex min-w-0 items-center gap-2 pl-1">
                <span
                  className="h-3.5 w-[3px] shrink-0 rounded-[2px]"
                  style={{ background: lastReal ? dotColor(lastReal) : 'var(--color-hairline)' }}
                />
                <Link
                  to="/loops/$loopId"
                  params={{ loopId: loop.id }}
                  className="truncate text-label font-medium text-primary group-hover:text-display group-hover:underline"
                  title={loop.name}
                >
                  {loop.name}
                </Link>
                {/* Readable cadence, NOT the raw cron: at day zoom the chart shows
                    one day, so cadence is the thing the picture cannot say. */}
                <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] text-disabled group-hover:text-secondary max-sm:hidden">
                  {loop.enabled ? loop.cadence : 'paused'}
                </span>
              </div>

              {/* track */}
              <div className="relative h-[22px] min-w-0 overflow-hidden rounded-[5px] bg-raised transition-colors group-hover:bg-[color:var(--color-wire)]/40">
                {grid.map((g, i) => (
                  <span
                    key={i}
                    className={`absolute inset-y-0 w-px ${g.strong ? 'bg-wire' : 'bg-hairline'}`}
                    style={{ left: `${g.pct}%` }}
                  />
                ))}
                {marks.map((m, i) => (
                  <Mark
                    key={m.runId ?? `p${i}`}
                    mark={m}
                    loop={loop}
                    leftPct={pct(Date.parse(m.ts))}
                    span={span}
                    minPx={MIN_MARK_PX[zoom]}
                    costMode={costMode}
                    maxCost={maxCost}
                    hydrated={hydrated}
                    onHover={setHover}
                  />
                ))}
                {/* The now-line is drawn INSIDE each track, not as one overlay
                    across the grid — an overlay has to re-derive the label
                    column's width in a calc(), which silently drifts at the
                    breakpoint where that column narrows. */}
                {nowPct != null && (
                  <span
                    className="pointer-events-none absolute inset-y-0 z-[2] w-[2px] bg-accent opacity-70"
                    style={{ left: `min(${nowPct}%, calc(100% - 2px))` }}
                  />
                )}
              </div>

              <div className="text-right font-mono text-caption text-secondary">
                {total != null ? money(total) : '—'}
              </div>
            </div>
          )
        })}
      </div>

      {loops.length === 0 && (
        <p className="py-8 text-center text-label text-secondary">
          {!data
            ? 'Loading…'
            : idleCount > 0
              ? `Nothing ran or is due in this window — ${idleCount} ${idleCount === 1 ? 'loop is' : 'loops are'} idle here.`
              : 'No loops in this team yet.'}
        </p>
      )}

      {/* Idle lanes are hidden, never silently dropped: say how many and offer
          them in one click, so "where did that loop go?" always has an answer. */}
      {idleCount > 0 && (
        <button
          type="button"
          onClick={() => setShowIdle((v) => !v)}
          className="mt-2 cursor-pointer text-label text-secondary underline-offset-2 hover:text-primary hover:underline"
        >
          {showIdle
            ? `Hide ${idleCount} idle ${idleCount === 1 ? 'loop' : 'loops'}`
            : `Show ${idleCount} idle ${idleCount === 1 ? 'loop' : 'loops'} (nothing in this window)`}
        </button>
      )}

      {/* legend */}
      <div className="mt-3 flex flex-wrap gap-3 border-t border-hairline pt-3">
        {[
          ['Resolved', 'var(--color-run-resolved)'],
          ['New', 'var(--color-run-new)'],
          ['No update', 'var(--color-run-nothing)'],
          ['Error', 'var(--color-run-error)'],
          ['Skipped', 'var(--color-run-silent)'],
        ].map(([label, c]) => (
          <span key={label} className="flex items-center gap-1.5 text-caption text-secondary">
            <i className="block size-2.5 rounded-[3px]" style={{ background: c }} />
            {label}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-caption text-secondary">
          <i className="block size-2.5 rounded-[3px] border border-dashed border-wire" />
          Projected
        </span>
        <span className="flex items-center gap-1.5 text-caption text-secondary">
          <i className="block h-2.5 w-[2px] bg-accent" />
          Now
        </span>
      </div>

      {hover && <Tip hover={hover} />}
    </section>
  )
}

/** A mark's fill. Cost mode shades by spend against the window's dearest run;
 *  a projection (or an unknown cost in cost mode) is left hollow and drawn as a
 *  dashed outline instead, so "nothing to report" never looks like a value. */
function markBackground(mark: TimelineMark, costMode: boolean, maxCost: number): string {
  if (mark.kind === 'projected') return 'transparent'
  if (!costMode) return dotColor(mark)
  if (mark.costUsd == null) return 'transparent'
  return `color-mix(in srgb, var(--color-display) ${Math.round(12 + (mark.costUsd / maxCost) * 80)}%, transparent)`
}

function Mark({
  mark,
  loop,
  leftPct,
  span,
  minPx,
  costMode,
  maxCost,
  hydrated,
  onHover,
}: {
  mark: TimelineMark
  loop: TimelineLoop
  leftPct: number
  span: number
  minPx: number
  costMode: boolean
  maxCost: number
  hydrated: boolean
  onHover: (h: Hover | null) => void
}) {
  // True duration, floored in px so a short run stays hittable, and clamped so an
  // in-flight run at the window edge can't overrun the track.
  const widthPct = Math.min(Math.max(((mark.durationMs ?? 0) / span) * 100, 0.35), Math.max(100 - leftPct, 0.35))
  const background = markBackground(mark, costMode, maxCost)
  const hollow = background === 'transparent'

  const body = (
    <span
      className={`absolute inset-y-[3px] cursor-pointer rounded-[3px] hover:z-10 hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-display ${
        hollow ? 'border border-dashed border-wire' : ''
      }`}
      style={{
        // cap left so left + the px floor still fits inside the track
        left: `min(${leftPct}%, calc(100% - ${minPx}px))`,
        width: `${widthPct}%`,
        minWidth: `${minPx}px`,
        maxWidth: '100%',
        background,
        ...(mark.running && hydrated ? runPulseAnim : {}),
      }}
      onMouseEnter={(e) => onHover({ mark, loop, x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => onHover({ mark, loop, x: e.clientX, y: e.clientY })}
      onMouseLeave={() => onHover(null)}
      // A projection has no outcome, so `dotLabel` already reads "Scheduled".
      aria-label={`${loop.name} · ${dotLabel(mark)}`}
    />
  )

  // A projected fire has no run to open.
  if (!mark.runId) return body
  return (
    <Link to="/loops/$loopId/runs/$runId" params={{ loopId: mark.loopId, runId: mark.runId }}>
      {body}
    </Link>
  )
}

/** Cursor-following detail popup. Marks carry no text of their own, so lanes stay
 *  dense no matter how many runs land in the window. */
function Tip({ hover }: { hover: Hover }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: hover.x + 14, top: hover.y + 16 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = hover.x + 14
    let top = hover.y + 16
    if (left + w > window.innerWidth - 10) left = hover.x - w - 14
    if (top + h > window.innerHeight - 10) top = hover.y - h - 14
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [hover.x, hover.y])

  const m = hover.mark
  const ghost = m.kind === 'projected'
  const at = Date.parse(m.ts)
  const detail = m.error || m.message || ''
  return (
    <div
      ref={ref}
      className="glass-strong pointer-events-none fixed z-50 max-w-[320px] rounded-control px-3.5 py-2.5 text-meta leading-snug text-primary"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <span
          className={`size-2 shrink-0 rounded-[2px] ${ghost ? 'border border-dashed border-wire' : ''}`}
          style={{ background: ghost ? 'transparent' : dotColor(m) }}
        />
        {hover.loop.name}
        <span className="ml-auto whitespace-nowrap pl-3 font-mono text-caption font-normal text-secondary">
          {/* A projection has no outcome, so `dotLabel` already reads "Scheduled". */}
          {dotLabel(m)}
        </span>
      </div>
      <div className="mt-1 flex gap-3 font-mono text-caption text-secondary">
        <span>
          {dayLabel(at)} {timeLabel(at)}
        </span>
        <span>{ghost ? 'not yet run' : dur(m.durationMs) || '—'}</span>
        <span>{m.costUsd == null ? '—' : money(m.costUsd)}</span>
      </div>
      <div className="mt-0.5 font-mono text-caption text-disabled">
        {hover.loop.cadence}
        {ghost ? ' · projected from cron' : ' · click to open the run'}
      </div>
      {detail && <div className="mt-1.5 border-t border-hairline pt-1.5 text-caption text-secondary">{detail}</div>}
    </div>
  )
}
