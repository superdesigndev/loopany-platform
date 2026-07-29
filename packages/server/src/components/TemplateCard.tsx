import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { BundleView, TemplateInfo, TemplateRating } from '../types'
import { MicroIndicators, categoryTagStyle } from './TemplateRatingChips'
import { TemplateIcon } from './TemplateIcon'

/**
 * The ONE outcome-first template card, shared by the public market sections
 * (`TemplatesPage`, `/templates`) and the dashboard's catalog preview strip
 * (`TemplatesPreview`). Extracted so the two surfaces cannot drift: title, one-line
 * intro, the When → Does → You-get flow strip (the card's visual anchor — it answers
 * "what is this loop and what lands in my repo/inbox" without reading the prompt; the
 * full prompt lives on the detail page), the compact 3-indicator rating row, and the
 * whole-card navigation to `/templates/<slug>`.
 *
 * `compact` is the dashboard variant: a fixed card height plus one-line clamps on title
 * and intro, so the preview grid's rows are uniform and the section's bottom fade cuts
 * at a predictable place at every viewport width. The fixed height leaves no slack, so
 * a longer label ellipsises instead of silently pushing the rating row and the Create
 * link out of the card. Everything else is identical markup.
 *
 * `showCategory` hides the per-card category tag on surfaces that already label the
 * category around the card (the market's per-bundle sections); the flat teaser grid
 * keeps it (the default) since there the tag is the only category context.
 */

/** One template flattened with its category, for the market grid + filter. */
export interface MarketItem {
  template: TemplateInfo
  categoryLabel: string
  accent: BundleView['accent']
}

/** One bundle's members flattened to market items, in the bundle's own display order. */
export function bundleItems(b: BundleView): MarketItem[] {
  return b.members.map((template) => ({ template, categoryLabel: b.label, accent: b.accent }))
}

export function TemplateCard({
  item,
  compact,
  showCategory = true,
  className,
}: {
  item: MarketItem
  compact?: boolean
  showCategory?: boolean
  className?: string
}) {
  const { template: t, categoryLabel, accent } = item
  return (
    <article
      className={`market-card group relative flex min-w-0 flex-col rounded-card border border-hairline bg-surface p-4 transition-colors hover:border-wire hover:shadow-[0_14px_30px_-20px_rgba(0,0,0,0.28)] ${
        compact ? 'h-[252px] overflow-hidden' : ''
      } ${className ?? ''}`}
    >
      {/* Header: category tag (teaser context only — market sections already carry it). */}
      {showCategory && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium" style={categoryTagStyle(accent)}>
            {categoryLabel}
          </span>
        </div>
      )}

      {/* Title is the stretched link — the WHOLE card navigates to the detail page. */}
      <h3 className={`${showCategory ? 'mt-2' : ''} flex min-w-0 items-center gap-2 text-[15px] font-semibold leading-snug text-display`}>
        <TemplateIcon name={t.name} size={17} className="shrink-0 text-secondary" />
        <Link
          to="/templates/$slug"
          params={{ slug: t.name }}
          className={`market-card-link min-w-0 outline-none group-hover:underline focus-visible:underline ${compact ? 'truncate' : ''}`}
        >
          {t.label}
        </Link>
      </h3>
      <p className={`mt-1 ${compact ? 'line-clamp-1' : 'line-clamp-2'} text-caption leading-snug text-secondary`}>{t.desc}</p>

      {/* The visual anchor: When → Does → You get, from the editorial rating table. */}
      {t.rating && <FlowStrip rating={t.rating} />}

      {/* Footer: 3 compact indicators + the quiet hover-revealed Create affordance. */}
      <div className="mt-auto flex items-end justify-between gap-3 pt-3">
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

/** The When → Does → You-get strip. The You-get row is the card's one bold element. */
function FlowStrip({ rating }: { rating: TemplateRating }) {
  return (
    <div className="flow-strip mt-3 flex min-w-0 flex-col gap-1.5 rounded-control bg-raised px-3 py-2.5">
      <FlowRow label="When">
        <span className="text-caption leading-snug text-primary">{rating.schedule}</span>
      </FlowRow>
      <FlowRow label="Does">
        <span className="text-caption leading-snug text-primary">{rating.does}</span>
      </FlowRow>
      <FlowRow label="You get">
        <span className="inline-flex min-w-0 items-center rounded-control border border-hairline bg-surface px-2 py-0.5 text-caption font-medium leading-snug text-display">
          {rating.outcome}
        </span>
      </FlowRow>
    </div>
  )
}

function FlowRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-[52px] shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-disabled">
        {label}
      </span>
      {children}
    </div>
  )
}
