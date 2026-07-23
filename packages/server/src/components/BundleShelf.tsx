import type { BundleView, TemplateInfo } from '../types'
import { AgentMarksRow } from './AgentMarks'

/**
 * Split `items` into balanced rows of at most `maxPerRow`, LARGER row on top
 * (ceil-first), so the layout generalizes to any count and matches the product rule:
 * 3 → [3], 5 → [3, 2], 7 → [3, 2, 2]. Pure + data-driven (no hardcoded counts).
 */
export function splitRows<T>(items: T[], maxPerRow: number): T[][] {
  const rowCount = Math.max(1, Math.ceil(items.length / maxPerRow))
  const rows: T[][] = []
  for (let r = 0, at = 0; r < rowCount; r++) {
    const size = Math.ceil((items.length - at) / (rowCount - r))
    rows.push(items.slice(at, at + size))
    at += size
  }
  return rows
}

/**
 * The bundle SHELF — every bundle shown at once (no carousel, no hidden bundles), laid
 * out in balanced rows of up to three fanned clusters. The page reads as one calm
 * choice: pick a bundle to try, pick a single loop inside it to set up alone, or start
 * blank. Light/dark ride the app's `--color-*` tokens; a bundle's `accent` tints its
 * name rule + CTA marks. English only.
 */
export function BundleShelf({
  bundles,
  onPickTemplate,
  onTryBundle,
}: {
  bundles: BundleView[]
  /** A single member loop-card was clicked → set it up alone (the existing
   *  single-template compose path). */
  onPickTemplate: (t: TemplateInfo) => void
  /** A bundle's "try this bundle" CTA → open the bundle compose path. */
  onTryBundle: (b: BundleView) => void
}) {
  const rows = splitRows(bundles, 3)
  return (
    <div className="mt-3 flex flex-col items-center gap-5">
      {rows.map((row, r) => (
        <div key={r} className="flex flex-wrap items-start justify-center gap-4">
          {row.map((b) => (
            <BundleCluster key={b.name} bundle={b} onPickTemplate={onPickTemplate} onTryBundle={onTryBundle} />
          ))}
        </div>
      ))}
      <div className="text-caption text-disabled">Click a bundle to try it, or a single loop to set it up alone.</div>
    </div>
  )
}

/** One bundle: its fanned loop-cards, name + tagline + loop count, and a "try this
 *  bundle" CTA — grouped in a hover-lifting card so the CTA's bundle is unambiguous. */
function BundleCluster({
  bundle,
  onPickTemplate,
  onTryBundle,
}: {
  bundle: BundleView
  onPickTemplate: (t: TemplateInfo) => void
  onTryBundle: (b: BundleView) => void
}) {
  const accent = `var(--color-${bundle.accent})`
  const center = (bundle.members.length - 1) / 2
  return (
    <div className="group flex w-[352px] flex-col items-center rounded-card border border-transparent p-4 transition-colors hover:border-hairline hover:bg-surface">
      {/* The fanned member cards — tilt/lift grow with distance from the cluster's
          center; a click sets up that single loop alone. */}
      <div className="flex items-start justify-center pb-1">
        {bundle.members.map((t, i) => {
          const off = i - center
          return (
            <button
              key={t.name}
              type="button"
              onClick={() => onPickTemplate(t)}
              title={t.desc}
              className="fan-card relative w-[112px] shrink-0 cursor-pointer rounded-card border border-hairline bg-surface p-2 text-left shadow-[0_12px_28px_-16px_rgba(0,0,0,0.25)] outline-none focus-visible:ring-2 focus-visible:ring-interactive"
              style={
                {
                  '--tilt': `${off * 4}deg`,
                  '--lift': `${Math.abs(off) * 5}px`,
                  marginInline: bundle.members.length > 1 ? '-26px' : undefined,
                } as React.CSSProperties
              }
            >
              {t.thumb ? (
                <span
                  className="block overflow-hidden rounded-control bg-raised [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: t.thumb }}
                />
              ) : (
                <span className="flex h-[46px] items-center justify-center rounded-control bg-raised text-secondary">
                  <LoopGlyph />
                </span>
              )}
              <span className="mt-1.5 block truncate text-center text-micro font-semibold text-primary">{t.label}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-3 text-[16px] font-semibold tracking-[-0.01em] text-display">
        {bundle.label}
        <span className="ml-2 align-middle text-caption font-normal text-disabled">
          {bundle.members.length} {bundle.members.length === 1 ? 'loop' : 'loops'}
        </span>
      </div>
      <div className="mt-0.5 text-center text-caption leading-snug text-secondary">{bundle.tagline}</div>

      <button
        type="button"
        onClick={() => onTryBundle(bundle)}
        className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-wire px-3.5 py-1.5 text-caption font-medium text-primary outline-none transition-colors hover:bg-display hover:text-paper focus-visible:ring-2 focus-visible:ring-interactive"
        style={{ ['--tw-ring-color' as string]: accent }}
      >
        <AgentMarksRow />
        Copy prompt · try this bundle
      </button>
    </div>
  )
}

/** A circular-arrow "loop" mark — the per-card fallback when a template ships no thumb. */
function LoopGlyph() {
  return (
    <svg
      aria-hidden
      width="22"
      height="22"
      viewBox="0 0 30 30"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M25.5 15a10.5 10.5 0 1 1-3.1-7.4" />
      <path d="M25.5 3.5v5.2h-5.2" />
    </svg>
  )
}
