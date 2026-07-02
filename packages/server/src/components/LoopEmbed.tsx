import { useEffect, useRef, useState } from 'react'
import type { ArtifactSummary } from '../types'
import { fmt } from '../lib/format'
import { matchArtifacts, newestMatch } from '../lib/productDate'
import { ArtifactBody, ViewerHead } from './artifactView'

/**
 * `<loop-embed file="reports/digest-2026-07-01.md">` /
 * `<loop-embed match="reports/digest-*.md">` - a loop's own produced file
 * embedded in its dashboard. `file` targets one exact path; `match` resolves to
 * the NEWEST matching artifact (filename date first, sync time as tiebreak), so
 * "embed the latest digest" keeps working without the agent editing the
 * template every run. Content renders through the shared artifact viewer
 * (markdown via .taskmd, mono pre for other text, download notice for binary),
 * collapsed at 300px with a fade + "show all" toggle; the `full` attribute
 * opts out of the collapse.
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
}: {
  loopId: string
  /** The loop's synced artifact list (null while loading). */
  artifacts: ArtifactSummary[] | null
  file?: string
  match?: string
  full?: boolean
}) {
  const requested = file ?? match
  const shell = 'min-w-0 overflow-hidden rounded-[10px] border border-hairline bg-surface'

  // Authoring hint (an agent iterating on its template sees why nothing shows).
  if (!requested)
    return (
      <div className={shell}>
        <div className="px-5 py-5 font-mono text-[12px] text-disabled">
          &lt;loop-embed&gt; needs file="&lt;path&gt;" or match="&lt;glob&gt;"
        </div>
      </div>
    )

  if (artifacts == null)
    return (
      <div className={shell}>
        <ViewerHead path={requested} />
        <div className="px-5 py-6 font-mono text-[12px] tracking-[0.08em] text-secondary">[ loading ]</div>
      </div>
    )

  const target = file
    ? artifacts.find((a) => norm(a.path) === norm(file))
    : newestMatch(artifacts, match)

  // Calm pre-first-sync degrade, same voice as the Files panel. Never an error
  // banner: a missing artifact is a normal state for a young loop.
  if (!target)
    return (
      <div className={shell}>
        <ViewerHead path={requested} />
        <div className="px-5 py-6 text-[13px] text-disabled">
          No synced file matches yet. It appears here after the loop's next run syncs it.
        </div>
      </div>
    )

  const resolution = match ? `newest of ${matchArtifacts(artifacts, match).length} matching ${match} · ` : ''
  const meta = `${resolution}synced ${fmt(target.updatedAt)}`

  return (
    <div className={shell}>
      <ViewerHead
        path={target.path}
        meta={meta}
        action={
          <a
            href="#files"
            className="font-mono text-[10.5px] tracking-[0.04em] text-interactive transition-colors hover:text-display"
          >
            open in files →
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
  // this settles instead of looping.
  useEffect(() => {
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
            className="cursor-pointer border-none bg-transparent p-0 font-mono text-[10.5px] tracking-[0.06em] text-secondary transition-colors hover:text-display"
          >
            {expanded ? 'collapse ▴' : 'show all ▾'}
          </button>
        </div>
      )}
    </>
  )
}
