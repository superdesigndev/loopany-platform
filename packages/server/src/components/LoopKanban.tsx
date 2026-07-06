import { useState } from 'react'
import type { ArtifactSummary } from '../types'
import { isTaskPath } from '../lib/fileEntries'
import { fmt } from '../lib/format'
import { matchArtifacts, productDate, type ProductDate } from '../lib/productDate'
import { ArtifactBody, isMarkdown } from './artifactView'
import { Modal, ModalHead } from './Modal'

/**
 * `<loop-kanban columns="research,in-progress,done" match="notes/*.md">` - a
 * COLLECTION VIEW over the loop's front-matter-typed markdown products, rendered
 * as a board. There is NO board file: each artifact IS a card, grouped into the
 * column whose name equals the artifact's front-matter `type`. A card "moves"
 * when a run edits that artifact's `type` in place (the per-run diff shows the
 * move).
 *
 * - `columns` (REQUIRED): comma-separated, explicit order = flow direction, one
 *   board column each.
 * - Overflow: any typed artifact whose `type` matches no declared column lands
 *   in an automatic trailing "Other" column, so a typo stays visible and a card
 *   is never silently dropped. The overflow column is omitted when empty.
 * - `match` (optional glob, same convention as loop-embed/loop-calendar): scopes
 *   which artifacts participate; default = every markdown product with a `type`.
 *   Untyped artifacts never appear, and the task file is always excluded (its
 *   status is the TASK chip, not a kanban type).
 * - Cards: minimal - title (fallback filename) + a small date when the product
 *   is actually dated. Sorted date desc, then sync-time desc.
 * - Click a card to review its full body in the shared Modal (focus trap, Esc,
 *   scroll lock come from Base UI Dialog); close returns to the board.
 *
 * Layout: the board row scrolls INSIDE its own pane (`min-w-0 overflow-x-auto`),
 * columns are `shrink-0` fixed-width - a wide board never widens the dashboard
 * box or forces a page-level horizontal scrollbar (the Timeline strip rule).
 */

const OVERFLOW_LABEL = 'Other'
/** Bucket key for the automatic overflow column. A unique Symbol (not the display
 *  string) so it can never collide with an author-declared column named 'Other'. */
const OVERFLOW_KEY: unique symbol = Symbol('kanban-overflow')
/** React key for the overflow row. Column names are comma-split, so a name can
 *  never contain a comma - this sentinel cannot collide with a declared column. */
const OVERFLOW_REACT_KEY = 'overflow,'

interface Card {
  file: ArtifactSummary
  title: string
  date: ProductDate
}

const basename = (path: string): string => path.split('/').pop() || path

/** Sort key: product date desc, then sync time desc (newest work first). Both
 *  parts are lexically ordered (YYYY-MM-DD / ISO), so a plain string compare on
 *  the descending key ranks them. */
const sortKey = (c: Card): string => `${c.date.date}|${c.file.updatedAt}`

export function LoopKanban({
  loopId,
  artifacts,
  columns,
  match,
  taskFile,
}: {
  loopId: string
  /** The loop's synced artifact list (null while loading). */
  artifacts: ArtifactSummary[] | null
  /** Comma-separated column names; order = flow direction. Required. */
  columns?: string
  match?: string
  /** The loop's task-file path - always excluded (it isn't a typed product). */
  taskFile?: string
}) {
  const [reviewing, setReviewing] = useState<Card | null>(null)
  const cols = [
    ...new Set(
      (columns ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
  const shell = 'min-w-0'

  // Authoring hint - an agent iterating on its template sees why nothing shows.
  if (!cols.length)
    return (
      <div className={`${shell} rounded-card border border-hairline bg-surface shadow-card`}>
        <div className="px-5 py-5 font-mono text-label text-disabled">
          &lt;loop-kanban&gt; needs columns="&lt;a,b,c&gt;"
        </div>
      </div>
    )

  if (artifacts == null)
    return (
      <div className={shell}>
        <div className="py-4 text-label text-secondary">Loading…</div>
      </div>
    )

  // Cards = the matched markdown products that carry a `type`, task file excluded.
  const cards: Card[] = matchArtifacts(artifacts, match)
    .filter((a) => isMarkdown(a.path) && !!a.meta?.type && !isTaskPath(taskFile, a.path))
    .map((file) => ({ file, title: file.meta?.title?.trim() || basename(file.path), date: productDate(file) }))

  // Group into declared columns (exact `type` match); unmatched types overflow.
  const declared = new Set(cols)
  const grouped = new Map<string | symbol, Card[]>()
  for (const card of cards) {
    const type = card.file.meta!.type!.trim()
    const key: string | symbol = declared.has(type) ? type : OVERFLOW_KEY
    const list = grouped.get(key) ?? []
    list.push(card)
    grouped.set(key, list)
  }
  for (const list of grouped.values()) list.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1))

  const board = cols.map((name) => ({ name, cards: grouped.get(name) ?? [], overflow: false }))
  const overflow = grouped.get(OVERFLOW_KEY) ?? []
  if (overflow.length) board.push({ name: OVERFLOW_LABEL, cards: overflow, overflow: true })

  return (
    // The board row is the ONLY horizontal-scroll container: min-w-0 lets it
    // shrink below its content, overflow-x-auto keeps a wide board inside the
    // pane, and the columns are shrink-0 fixed-width tracks. Vertically the
    // board is capped too: a tall column scrolls its OWN card list (min-h-0 +
    // overflow-y-auto below) under a sticky-feeling header, so a 20-card
    // backlog never stretches the dashboard box.
    <div className={`${shell} flex max-h-[420px] gap-3 overflow-x-auto pb-1`}>
      {board.map((col) => (
        <div key={col.overflow ? OVERFLOW_REACT_KEY : col.name} className="flex min-h-0 w-[248px] shrink-0 flex-col">
          <div className="mb-2 flex shrink-0 items-center gap-2 border-b border-hairline pb-1.5">
            <span
              className={`text-label font-semibold ${
                col.overflow ? 'text-disabled' : 'text-primary'
              }`}
            >
              {col.name}
            </span>
            <span className="text-caption text-disabled">{col.cards.length}</span>
          </div>
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pb-1 pr-0.5">
            {col.cards.length === 0 ? (
              <div className="rounded-control border border-dashed border-hairline px-2.5 py-3 text-center text-caption text-disabled">
                Empty
              </div>
            ) : (
              col.cards.map((card) => (
                <KanbanCard key={card.file.path} card={card} onOpen={() => setReviewing(card)} />
              ))
            )}
          </div>
        </div>
      ))}
      {reviewing && (
        <Modal open onClose={() => setReviewing(null)}>
          <ModalHead
            title={reviewing.title}
            sub={
              <span className="font-mono">
                {reviewing.file.path}
                {reviewing.date.source !== 'sync' && ` · ${reviewing.date.date}`} · synced{' '}
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

/** One artifact as a card: title + small date, click to review it in the modal. */
function KanbanCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const dated = card.date.source !== 'sync'
  return (
    <div className="min-w-0 overflow-hidden rounded-control border border-hairline bg-surface shadow-card transition-colors hover:border-wire">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 cursor-pointer flex-col items-start gap-1 border-none bg-transparent px-2.5 py-2 text-left"
      >
        <span className="w-full min-w-0 truncate text-meta text-primary" title={card.file.path}>
          {card.title}
        </span>
        {dated && (
          <span className="font-mono text-micro text-disabled">{card.date.date}</span>
        )}
      </button>
    </div>
  )
}
