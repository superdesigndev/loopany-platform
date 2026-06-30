import { useState } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import type { JobSummary, RunSummary } from '../types'
import { dotColor, dotLabel, dur, fmt, isDone, until } from '../lib/format'
import { runPulseAnim, useHydrated } from './ui'

/*
 * The signature data viz: a segmented bar of cube-sticker blocks (slight 4px
 * corner, hairline gaps) — one block per run, colored by outcome (mono ink for
 * the quiet "no update" baseline, color only for meaning). Up to WINDOW blocks
 * show at once; older/newer overflow collapses into clickable "+N" pagers that
 * are themselves the SAME block shape, so the row reads as one continuous strip
 * with no reserved left whitespace. The NEXT scheduled run is a single hollow
 * dot past a dashed connector. Done/paused loops have no next dot.
 *
 * Paging is lazy: the card seeds the timeline with the newest page; clicking the
 * left "+N" steps a full window (WINDOW) back and, when it runs past the loaded
 * runs, fetches the next older page via onLoadMore before sliding. The "+N"
 * counts reflect the loop's TRUE total (`total`), not just what's loaded.
 */
export const WINDOW = 16 // max blocks per row — also the lazy-load page size
const PAGE = WINDOW // a pager click steps a full window left/right
const RAD = 'rounded-[4px]' // cube-sticker corner (echoes CubeMark RC/CELL ≈ 0.23)
const SEG = `h-5 w-[18px] shrink-0 ${RAD}` // one run block

function RunSeg({ run, onClick }: { run: RunSummary; onClick: () => void }) {
  const body = run.error || run.message || ''
  const meta = run.durationMs ? ` · ${dur(run.durationMs)}` : ''
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClick()
            }}
            aria-label={dotLabel(run)}
            className={`${SEG} cursor-pointer transition-opacity hover:opacity-70`}
            style={{ background: dotColor(run), ...(run.running ? runPulseAnim : {}) }}
          />
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8}>
          <Tooltip.Popup className="pointer-events-none max-w-[340px] rounded-lg border border-wire bg-raised px-3.5 py-2.5 text-[12.5px] leading-snug text-primary">
            <div className="flex items-center gap-1.5 font-medium">
              {/* swatch — matches the run blocks (circle is reserved for the next-dot) */}
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: dotColor(run) }} />
              {dotLabel(run)}
              <span className="ml-auto whitespace-nowrap pl-3 font-mono text-[11px] font-normal text-secondary">
                {fmt(run.ts)}
                {meta}
              </span>
            </div>
            {body && (
              <div
                className={`mt-1.5 max-h-[150px] overflow-hidden whitespace-pre-wrap ${
                  run.error ? 'text-accent' : 'text-secondary'
                }`}
              >
                {body}
              </div>
            )}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

/** An "N more" pager rendered as the SAME cube block as a run — identical 18px
 *  width (bordered, not filled, so it reads as an affordance; the "+" is dropped
 *  to keep the count inside the run-block width). Renders nothing when there's no
 *  overflow — no left-edge whitespace reserved. */
function Pager({ count, onClick, loading }: { count: number; onClick: () => void; loading?: boolean }) {
  if (!count) return null
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`flex h-5 w-[18px] shrink-0 items-center justify-center overflow-hidden border border-wire px-0 font-mono text-[9px] leading-none tracking-[-0.04em] text-disabled transition-colors hover:border-display hover:text-primary ${RAD} ${
        loading ? 'animate-pulse' : 'cursor-pointer'
      }`}
      title={`${count} more — click to reveal`}
    >
      {loading ? '…' : count}
    </button>
  )
}

export function Timeline({
  job,
  runs,
  total,
  onLoadMore,
  onPickRun,
}: {
  job: JobSummary
  /** The loaded runs, chronological (oldest-first). The card owns this list and
   *  grows it on the left via onLoadMore. */
  runs: RunSummary[]
  /** The loop's true run total — drives the "+N" counts beyond what's loaded. */
  total: number
  /** Fetch+prepend the next older page; resolves with how many were added. */
  onLoadMore: () => Promise<number>
  onPickRun: (run: RunSummary) => void
}) {
  const all = runs
  const en = job.enabled
  const done = isDone(job)
  const L = all.length
  // Older runs that exist server-side but aren't fetched yet (never negative —
  // total can briefly lag the seeded page mid-poll).
  const unloaded = Math.max(0, total - L)
  const hydrated = useHydrated()

  // winStart < 0 means "follow the latest"; a click pins an explicit window
  // (an index into the loaded array).
  const [winStart, setWinStart] = useState(-1)
  const [loading, setLoading] = useState(false)
  const maxStart = Math.max(0, L - WINDOW)
  const start = winStart < 0 ? maxStart : Math.min(winStart, maxStart)
  const end = Math.min(start + WINDOW, L)
  const visible = all.slice(start, end)
  const olderHidden = unloaded + start // off the left edge (loaded + not-yet-fetched)
  const newerHidden = L - end // off the right edge (always loaded)
  const atLatest = newerHidden === 0

  const pageBack = async () => {
    const target = start - PAGE
    // Stepping past the loaded left edge: fetch an older page first, then land
    // the window one page left of where it sat (its runs shift right by `added`).
    if (target < 0 && unloaded > 0 && !loading) {
      setLoading(true)
      const added = await onLoadMore().catch(() => 0)
      setLoading(false)
      setWinStart(Math.max(0, start + added - PAGE))
      return
    }
    setWinStart(Math.max(0, target))
  }
  const pageFwd = () => {
    const next = start + PAGE
    setWinStart(next >= maxStart ? -1 : next) // snap back to follow-latest at the edge
  }

  // An in-flight run is just the newest run with `running: true` — it renders as a
  // pulsing RunSeg in `visible` and settles into its finished color in place once
  // the report lands. We only need the flag here to suppress the next-run marker
  // while it executes (the live block already stands in for "what's next").
  const running = !!job.running && atLatest

  // Right edge: at the live edge we show the next-run marker; otherwise the
  // forward "+N" pager for the newer runs currently scrolled out of view.
  const showNext = atLatest && en && !done && !!job.nextRun && !running

  return (
    // Contain the strip to its track. A full WINDOW of fixed-width (shrink-0) run
    // blocks plus the next-run marker can be wider than a narrow rail (e.g. the loop
    // page's ~320px runs rail) — left unbounded those blocks paint past the card's
    // right edge and force a page-level horizontal scrollbar (against the hard
    // no-page-scroll rule). `min-w-0` lets the row shrink below its content and
    // `overflow-x-auto` scrolls any surplus INSIDE its own box, so the strip never
    // widens the card. Behavior is preserved: tooltips/next-run popups portal out of
    // the scroll box, and the +N pagers still page the window.
    <div className="flex min-w-0 items-center gap-[3px] overflow-x-auto">
      <Pager count={olderHidden} onClick={pageBack} loading={loading} />
      {visible.map((r) => (
        <RunSeg key={r.id} run={r} onClick={() => onPickRun(r)} />
      ))}
      {showNext ? (
        <div className="ml-1 flex items-center gap-2">
          <span className="w-12 border-t border-dashed border-wire" />
          <span
            className="size-[11px] shrink-0 rounded-full border border-wire"
            title={hydrated ? `Next scheduled run · ${fmt(job.nextRun)}` : undefined}
          />
          <span className="font-mono text-[10px] tracking-[0.04em] text-disabled">
            {hydrated ? until(job.nextRun) : ''}
          </span>
        </div>
      ) : (
        !atLatest && <Pager count={newerHidden} onClick={pageFwd} />
      )}
    </div>
  )
}
