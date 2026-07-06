import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactSummary } from '../types'
import { fmt } from '../lib/format'
import { isTaskPath } from '../lib/fileEntries'
import { localDay, matchArtifacts, productDate, type ProductDate } from '../lib/productDate'
import { ArtifactBody } from './artifactView'
import { Modal, ModalHead } from './Modal'

/**
 * `<loop-calendar match="reports/*.md">` - the loop's products on a month
 * grid. Each product lands on the day parsed from its FILENAME (ISO-ish
 * patterns), falling back to its sync time (marked with a dashed chip - sync
 * time can misattribute a re-synced old file, so the fallback is visible, not
 * silent). Clicking a product reviews its full body in the shared Modal
 * (focus trap, Esc, scroll lock come from Base UI Dialog - the kanban card
 * pattern); close returns to the grid. `match` is optional - the default is
 * every synced artifact except the task file.
 *
 * Monday-start (ISO), mono day numbers top-right, today inverted. Chips carry
 * the product's basename (max 2 per day + a "+N" overflow); under ~620px of
 * CONTAINER width they collapse to plain dots (measured, not a viewport media
 * query - the dashboard box can be narrow on a wide screen).
 */

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DOT_MODE_BELOW = 620
const CHIPS_PER_DAY = 2

interface Product {
  file: ArtifactSummary
  date: ProductDate['date']
  source: ProductDate['source']
}

const monthOf = (day: string): string => day.slice(0, 7) // YYYY-MM

const basename = (path: string): string => path.split('/').pop() || path

/** Human label for how a product got its day (front matter is authoritative). */
function dateSourceLabel(source: ProductDate['source']): string {
  if (source === 'frontmatter') return 'dated by front matter'
  if (source === 'filename') return 'dated by filename'
  return 'dated by sync time (no date in front matter/filename)'
}

const monthIndex = (ym: string): number => {
  const [y, m] = ym.split('-').map(Number)
  return y! * 12 + m!
}

/**
 * The shown month clamped back into the data: an exact hit stays; a month
 * whose products all vanished (poll refresh) snaps to the nearest remaining
 * one; no pick defaults to the newest month. `months` must be non-empty.
 */
function clampMonth(months: string[], shown: string | null): string {
  if (shown && months.includes(shown)) return shown
  let best = months[months.length - 1]!
  if (shown) {
    const target = monthIndex(shown)
    for (const m of months) {
      if (Math.abs(monthIndex(m) - target) < Math.abs(monthIndex(best) - target)) best = m
    }
  }
  return best
}

const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  return `${new Date(y!, m! - 1, 1).toLocaleString(undefined, { month: 'long' })} ${y}`
}

/** Chip text: basename without extension or a trailing date (digest-2026-07-01.md → "digest"). */
function chipName(path: string): string {
  const base = path.split('/').pop() || path
  const noExt = base.replace(/\.[a-z0-9]+$/i, '')
  return noExt.replace(/[-_]?\d{4}([-_]?)\d{2}\1\d{2}$/, '') || noExt
}

/** Measured width of a container element (0 until first measure). */
function useContainerWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w != null) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

export function LoopCalendar({
  loopId,
  artifacts,
  match,
  taskFile,
}: {
  loopId: string
  /** The loop's synced artifact list (null while loading). */
  artifacts: ArtifactSummary[] | null
  match?: string
  /** The loop's task-file path - excluded from the default (no-match) product set. */
  taskFile?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useContainerWidth(rootRef)
  const dotMode = width > 0 && width < DOT_MODE_BELOW

  // Products: the matched artifacts, dated. Without an explicit match the task
  // file (the loop's spec, not a product) is excluded.
  const products = useMemo<Product[]>(() => {
    const files = matchArtifacts(artifacts ?? [], match)
    const kept = match ? files : files.filter((f) => !isTaskPath(taskFile, f.path))
    return kept.map((f) => ({ file: f, ...productDate(f) }))
  }, [artifacts, match, taskFile])

  const byDay = useMemo(() => {
    const m = new Map<string, Product[]>()
    for (const p of products) {
      const list = m.get(p.date) ?? []
      list.push(p)
      m.set(p.date, list)
    }
    for (const list of m.values()) list.sort((a, b) => (a.file.path < b.file.path ? -1 : 1))
    return m
  }, [products])

  // Month bounds follow the data; clampMonth defaults to the newest month.
  const months = useMemo(() => [...new Set(products.map((p) => monthOf(p.date)))].sort(), [products])
  const [shown, setShown] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<Product | null>(null)

  // Repair the review pick when the product set changes (poll refresh): a
  // vanished artifact's modal closes instead of pointing at stale data.
  useEffect(() => {
    if (reviewing && !products.some((p) => p.file.path === reviewing.file.path)) setReviewing(null)
  }, [products, reviewing])

  // The ref'd root wraps EVERY state (loading/empty/grid): the width observer
  // attaches once on mount, so the observed element must exist on the very
  // first render - the artifact list is null then, and a ref-less loading
  // return would leave dot mode permanently stuck at width 0.
  if (artifacts == null)
    return (
      <div ref={rootRef} className="min-w-0">
        <div className="py-4 text-label text-secondary">Loading…</div>
      </div>
    )

  if (!products.length)
    return (
      <div ref={rootRef} className="min-w-0">
        <div className="rounded-card border border-hairline px-5 py-8 text-center text-body text-disabled">
          No products yet. Files the loop writes appear here after its next run syncs them.
        </div>
      </div>
    )

  const month = clampMonth(months, shown)
  const mi = months.indexOf(month)
  const today = localDay(new Date().toISOString())

  const [y, m] = month.split('-').map(Number)
  const lead = (new Date(y!, m! - 1, 1).getDay() + 6) % 7 // Monday-start offset
  const dayCount = new Date(y!, m!, 0).getDate()
  const trail = (7 - ((lead + dayCount) % 7)) % 7
  const monthCount = products.filter((p) => monthOf(p.date) === month).length

  const navBtn =
    'inline-flex h-6 w-[26px] cursor-pointer items-center justify-center rounded-control border border-wire bg-transparent text-body text-primary transition-colors hover:border-display hover:text-display disabled:cursor-default disabled:opacity-35'

  return (
    <div ref={rootRef} className="min-w-0">
      {/* month header */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <button
          type="button"
          className={navBtn}
          disabled={mi <= 0}
          onClick={() => setShown(months[mi - 1]!)}
          aria-label="previous month"
        >
          ‹
        </button>
        <button
          type="button"
          className={navBtn}
          disabled={mi >= months.length - 1}
          onClick={() => setShown(months[mi + 1]!)}
          aria-label="next month"
        >
          ›
        </button>
        <span className="text-body font-semibold text-primary">{monthLabel(month)}</span>
        <span className="ml-auto text-caption font-medium text-disabled">
          {monthCount} product{monthCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* month grid - 7 minmax(0,1fr) tracks; cells own min-w-0 so a long chip
          truncates inside its cell instead of widening the row/page */}
      <div className="grid min-w-0 grid-cols-7 border-l border-t border-hairline">
        {DOW.map((d) => (
          <div
            key={d}
            className="border-b border-r border-hairline px-2 py-1 text-right text-micro font-medium text-disabled"
          >
            {d}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead${i}`} className="border-b border-r border-hairline" />
        ))}
        {Array.from({ length: dayCount }, (_, i) => {
          const day = `${month}-${String(i + 1).padStart(2, '0')}`
          const fs = byDay.get(day) ?? []
          const isToday = day === today
          return (
            <div
              key={day}
              className={`relative min-w-0 border-b border-r border-hairline bg-surface px-1.5 pb-1.5 ${
                dotMode ? 'min-h-[46px] pt-5' : 'min-h-[74px] pt-6'
              }`}
            >
              <span
                className={`absolute right-1.5 top-1 font-mono text-micro ${
                  isToday ? 'rounded-full bg-display px-1 text-paper' : 'text-disabled'
                }`}
              >
                {i + 1}
              </span>
              {fs.slice(0, CHIPS_PER_DAY).map((p) => (
                <ProductChip
                  key={p.file.path}
                  product={p}
                  dot={dotMode}
                  onPick={() => setReviewing(p)}
                />
              ))}
              {fs.length > CHIPS_PER_DAY && (
                <button
                  type="button"
                  onClick={() => setReviewing(fs[CHIPS_PER_DAY]!)}
                  className="mt-0.5 block cursor-pointer border-none bg-transparent p-0 px-1 font-mono text-[9.5px] text-disabled transition-colors hover:text-display"
                >
                  +{fs.length - CHIPS_PER_DAY}
                </button>
              )}
            </div>
          )
        })}
        {Array.from({ length: trail }, (_, i) => (
          <div key={`trail${i}`} className="border-b border-r border-hairline" />
        ))}
      </div>

      {/* legend */}
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-secondary">
          <span className="inline-block h-2.5 w-3.5 rounded-[3px] border border-hairline bg-raised" /> Dated by filename
        </span>
        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-secondary">
          <span className="inline-block h-2.5 w-3.5 rounded-[3px] border border-dashed border-wire bg-raised" /> Fallback:
          dated by sync time
        </span>
      </div>

      {/* review - the picked product's full body in the shared Modal */}
      {reviewing && (
        <Modal open onClose={() => setReviewing(null)}>
          <ModalHead
            title={reviewing.file.meta?.title?.trim() || basename(reviewing.file.path)}
            sub={
              <span className="font-mono">
                {reviewing.file.path} · {dateSourceLabel(reviewing.source)} · synced{' '}
                {fmt(reviewing.file.updatedAt)}
              </span>
            }
          />
          <div className="mt-4 min-w-0">
            <ArtifactBody loopId={loopId} file={reviewing.file} />
          </div>
        </Modal>
      )}
    </div>
  )
}

/** One product on a day cell: a named chip, or a plain dot in narrow containers. */
function ProductChip({
  product,
  dot,
  onPick,
}: {
  product: Product
  dot: boolean
  onPick: () => void
}) {
  const fallback = product.source === 'sync'
  const title = product.file.path + (fallback ? ' · dated by sync time' : '')
  if (dot)
    return (
      <button
        type="button"
        onClick={onPick}
        title={title}
        aria-label={product.file.path}
        className={`mr-1 mt-1 inline-block size-2 cursor-pointer rounded-full border-none p-0 ${
          fallback ? 'bg-disabled' : 'bg-secondary'
        }`}
      />
    )
  return (
    <button
      type="button"
      onClick={onPick}
      title={title}
      className={`mt-1 block w-full min-w-0 cursor-pointer truncate rounded-full border border-hairline bg-raised px-1.5 py-0.5 text-left font-mono text-micro text-primary transition-colors hover:border-display ${
        fallback ? 'border-dashed' : ''
      }`}
    >
      {chipName(product.file.path)}
    </button>
  )
}
