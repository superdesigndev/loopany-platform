import { Link } from '@tanstack/react-router'
import type { BundleView, TemplateInfo } from '../types'
import { MicroIndicators, categoryTagStyle } from './TemplateRatingChips'

/**
 * The ONE text-first template card, shared by the public market grid
 * (`TemplatesPage`, `/templates`) and the dashboard's catalog preview strip
 * (`TemplatesPreview`). Extracted so the two surfaces cannot drift: title, one-line
 * intro, category tag, the monospace prompt-preview texture, the compact 3-indicator
 * rating row, and the whole-card navigation to `/templates/<slug>`.
 *
 * `compact` is the dashboard variant: a shorter prompt-preview block and a fixed card
 * height, so the preview grid's rows are uniform and the section's bottom fade cuts at
 * a predictable place at every viewport width. The fixed height leaves no slack, so the
 * compact title is clamped to ONE line - a longer label (or a type-scale tweak) then
 * ellipsises instead of silently pushing the rating row and the Create link out of the
 * card. Everything else is identical markup.
 */

/** One template flattened with its category, for the market grid + filter. */
export interface MarketItem {
  template: TemplateInfo
  categoryName: string
  categoryLabel: string
  accent: BundleView['accent']
}

/** One bundle's members flattened to market items, in the bundle's own display order. */
export function bundleItems(b: BundleView): MarketItem[] {
  return b.members.map((template) => ({ template, categoryName: b.name, categoryLabel: b.label, accent: b.accent }))
}

/** Bundles partition the whole registry, so this IS the flat catalog (in bundle order). */
export function flattenBundles(bundles: BundleView[]): MarketItem[] {
  return bundles.flatMap(bundleItems)
}

export function TemplateCard({ item, compact, className }: { item: MarketItem; compact?: boolean; className?: string }) {
  const { template: t, categoryLabel, accent } = item
  return (
    <article
      className={`market-card group relative flex min-w-0 flex-col rounded-card border border-hairline bg-surface p-4 transition-colors hover:border-wire hover:shadow-[0_14px_30px_-20px_rgba(0,0,0,0.28)] ${
        compact ? 'h-[218px] overflow-hidden' : ''
      } ${className ?? ''}`}
    >
      {/* Header: category tag + suggested schedule. */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium" style={categoryTagStyle(accent)}>
          {categoryLabel}
        </span>
        {t.rating && <span className="min-w-0 truncate text-micro text-disabled">{t.rating.schedule}</span>}
      </div>

      {/* Title is the stretched link — the WHOLE card navigates to the detail page. */}
      <h3 className={`mt-2 text-[15px] font-semibold leading-snug text-display ${compact ? 'line-clamp-1' : ''}`}>
        <Link
          to="/templates/$slug"
          params={{ slug: t.name }}
          className="market-card-link outline-none group-hover:underline focus-visible:underline"
        >
          {t.label}
        </Link>
      </h3>
      <p className="mt-1 line-clamp-2 text-caption leading-snug text-secondary">{t.desc}</p>

      {/* The visual anchor: a monospace preview of the REAL prompt, faded at the bottom. */}
      <div
        className={`prompt-preview-mask mt-3 overflow-hidden rounded-control bg-raised px-3 pb-2 pt-2 ${
          compact ? 'h-[60px]' : 'h-[92px]'
        }`}
      >
        <pre className="whitespace-pre-wrap font-mono text-[10.5px] leading-[1.45] text-secondary">
          {promptPreview(t.description)}
        </pre>
      </div>

      {/* Footer: 3 compact indicators + the quiet hover-revealed Create affordance. */}
      <div className="mt-3 flex items-end justify-between gap-3">
        {t.rating && <MicroIndicators rating={t.rating} />}
        <Link
          to="/"
          search={{ template: t.name }}
          aria-label={`Create the ${t.label} loop in Loopany`}
          className="market-create relative z-10 inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-wire bg-surface px-2.5 py-1 text-micro font-medium text-secondary transition-colors hover:border-display hover:text-display"
        >
          Create <span aria-hidden>→</span>
        </Link>
      </div>
    </article>
  )
}

/** The first ~220 chars of the REAL prompt for the card's preview block (the mask fades
 *  the tail, so a mid-sentence cut is invisible). Collapses runs of blank lines so the
 *  preview stays dense. */
export function promptPreview(description: string): string {
  return description.replace(/\n{2,}/g, '\n').slice(0, 220)
}
