import { useLayoutEffect, useRef, useState } from 'react'
import type { ArtifactSummary } from '../types'
import { isTaskPath } from '../lib/fileEntries'
import { fmt } from '../lib/format'
import { matchArtifacts, newestMatch } from '../lib/productDate'
import { ArtifactBody, ViewerHead } from './artifactView'

/**
 * `<loop-embed file="reports/digest-2026-07-01.md">` /
 * `<loop-embed match="reports/digest-*.md">` - a loop's own produced file
 * embedded in its dashboard. `file` targets one exact path; `match` resolves to
 * the NEWEST matching artifact (filename date first, sync time as tiebreak), so
 * "embed the latest digest" keeps working without the agent editing the
 * template every run. `match` never selects the loop's task file - the spec is
 * not a product (same rule as the calendar's default set), and its frequent
 * edit-syncs would pin it as "newest" under a broad glob like `*.md`; an exact
 * `file=` path may still target it. Content renders through the shared
 * artifact viewer (markdown via .taskmd, mono pre for other text, download
 * notice for binary), collapsed at 300px with a fade + "show all" toggle; the
 * `full` attribute opts out of the collapse.
 */

/** Collapsed preview height. A pixel cap, not a line clamp - markdown blocks
 *  (tables, code) have uneven line heights, so pixels are the only stable cut. */
const COLLAPSE_PX = 300

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')

export function LoopEmbed({
  loopId,
  artifacts,
  file,
  match,
  full,
  taskFile,
}: {
  loopId: string
  /** The loop's synced artifact list (null while loading). */
  artifacts: ArtifactSummary[] | null
  file?: string
  match?: string
  full?: boolean
  /** The loop's task-file path - excluded from `match` results (exact `file=` may still target it). */
  taskFile?: string
}) {
  const requested = file ?? match
  const shell = 'min-w-0 overflow-hidden rounded-card border border-hairline bg-surface shadow-card'

  // Authoring hint (an agent iterating on its template sees why nothing shows).
  if (!requested)
    return (
      <div className={shell}>
        <div className="px-5 py-5 font-mono text-label text-disabled">
          &lt;loop-embed&gt; needs file="&lt;path&gt;" or match="&lt;glob&gt;"
        </div>
      </div>
    )

  if (artifacts == null)
    return (
      <div className={shell}>
        <ViewerHead path={requested} />
        <div className="px-5 py-6 text-label text-secondary">Loading…</div>
      </div>
    )

  const matchable = file ? artifacts : artifacts.filter((a) => !isTaskPath(taskFile, a.path))
  const target = file
    ? artifacts.find((a) => norm(a.path) === norm(file))
    : newestMatch(matchable, match)

  // Calm pre-first-sync degrade, same voice as the Files panel. Never an error
  // banner: a missing artifact is a normal state for a young loop.
  if (!target)
    return (
      <div className={shell}>
        <ViewerHead path={requested} />
        <div className="px-5 py-6 text-body text-disabled">
          No synced file matches yet. It appears here after the loop's next run syncs it.
        </div>
      </div>
    )

  const resolution = match ? `newest of ${matchArtifacts(matchable, match).length} matching ${match} · ` : ''
  const meta = `${resolution}synced ${fmt(target.updatedAt)}`

  return (
    <div className={shell}>
      <ViewerHead
        path={target.path}
        meta={meta}
        action={
          <a
            href="#files"
            className="text-caption font-medium text-interactive transition-colors hover:text-display"
          >
            Open in files →
          </a>
        }
      />
      <CollapsibleBody collapse={!full && !target.binary && !target.oversize}>
        <ArtifactBody loopId={loopId} file={target} />
      </CollapsibleBody>
    </div>
  )
}

/**
 * The collapse wrapper: clipping happens on THIS wrapper (overflow-hidden +
 * max-height), never on the text nodes, with a fade overlay above the cut and
 * the toggle in its own footer. The toggle appears only when the content
 * actually overflows the cap (measured post-render, re-checked as the lazy
 * content lands).
 */
export function CollapsibleBody({ collapse, children }: { collapse: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  // No dep array on purpose: the body's height changes when ArtifactBody's
  // lazy fetch lands, which is invisible to props. The setState is guarded, so
  // this settles instead of looping. A LAYOUT effect: the measurement must
  // happen before paint, or a long document flashes at full height for a frame
  // before collapsing.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const over = el.scrollHeight > COLLAPSE_PX + 1
    if (over !== overflowing) setOverflowing(over)
  })

  const collapsed = collapse && !expanded && overflowing
  if (!collapse) return <div className="min-w-0">{children}</div>

  return (
    <>
      <div className="relative min-w-0">
        <div
          ref={ref}
          className={collapsed ? 'overflow-hidden' : ''}
          style={collapsed ? { maxHeight: COLLAPSE_PX } : undefined}
        >
          {children}
        </div>
        {collapsed && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
            style={{ background: 'linear-gradient(to bottom, transparent, var(--color-surface))' }}
          />
        )}
      </div>
      {overflowing && (
        <div className="flex border-t border-hairline px-3.5 py-1.5">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="cursor-pointer border-none bg-transparent p-0 text-caption font-medium text-secondary transition-colors hover:text-display"
          >
            {expanded ? 'Collapse ▴' : 'Show all ▾'}
          </button>
        </div>
      )}
    </>
  )
}
