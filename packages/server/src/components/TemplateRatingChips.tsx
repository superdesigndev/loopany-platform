import type {
  BundleAccent,
  TemplateCadence,
  TemplateEase,
  TemplateMechanism,
  TemplateRating,
  TemplateVisibility,
} from '../types'

/**
 * The round-6 rating chips, shared by the public market grid (`TemplatesPage`) and the
 * detail view (`TemplateDetail`). They scan at a glance: ease + effect are colour-coded,
 * cadence + mechanism are neutral outline chips. Colours ride the theme CSS vars so they
 * follow light/dark for free. English only.
 */

type ChipTone = 'green' | 'orange' | 'red' | 'blue' | 'neutral' | 'outline'

const TONE_STYLE: Record<ChipTone, React.CSSProperties> = {
  green: { color: 'var(--color-rubik-green)', background: 'var(--color-success-soft)' },
  orange: { color: 'var(--color-rubik-orange)', background: 'color-mix(in srgb, var(--color-rubik-orange) 12%, transparent)' },
  red: { color: 'var(--color-rubik-red)', background: 'var(--color-accent-soft)' },
  blue: { color: 'var(--color-interactive)', background: 'var(--color-interactive-soft)' },
  neutral: { color: 'var(--color-secondary)', background: 'color-mix(in srgb, var(--color-secondary) 10%, transparent)' },
  outline: { color: 'var(--color-secondary)', background: 'transparent', boxShadow: 'inset 0 0 0 1px var(--color-hairline)' },
}

export function Chip({ label, tone, title }: { label: string; tone: ChipTone; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium ${title ? 'cursor-help' : ''}`}
      style={TONE_STYLE[tone]}
    >
      {label}
    </span>
  )
}

const easeMeta: Record<TemplateEase, { label: string; tone: ChipTone }> = {
  easy: { label: 'Easy start', tone: 'green' },
  moderate: { label: 'Moderate setup', tone: 'orange' },
  advanced: { label: 'Advanced setup', tone: 'red' },
}
const visibilityMeta: Record<TemplateVisibility, { label: string; tone: ChipTone }> = {
  'first-run': { label: 'Visible first run', tone: 'green' },
  'few-runs': { label: 'Builds over runs', tone: 'blue' },
  compounds: { label: 'Compounds over weeks', tone: 'neutral' },
}
export const cadenceLabel: Record<TemplateCadence, string> = { short: 'Short cycle', long: 'Long cycle' }
export const mechanismLabel: Record<TemplateMechanism, string> = { open: 'Open loop', closed: 'Closed loop' }

/** All four rating chips inline — the card + detail summary row. */
export function RatingChips({ rating }: { rating: TemplateRating }) {
  const e = easeMeta[rating.ease]
  const v = visibilityMeta[rating.visibility]
  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip label={e.label} tone={e.tone} />
      <Chip label={cadenceLabel[rating.cadence]} tone="outline" />
      <Chip label={mechanismLabel[rating.mechanism]} tone="outline" />
      <Chip label={v.label} tone={v.tone} title={rating.visibilityNote} />
    </div>
  )
}

export function EaseChip({ ease }: { ease: TemplateEase }) {
  const e = easeMeta[ease]
  return <Chip label={e.label} tone={e.tone} />
}
export function VisibilityChip({ visibility, note }: { visibility: TemplateVisibility; note?: string }) {
  const v = visibilityMeta[visibility]
  return <Chip label={v.label} tone={v.tone} title={note} />
}

/** A soft category tag tinted with the bundle accent (yellow uses a darker ink). */
export function categoryTagStyle(accent: BundleAccent): React.CSSProperties {
  const fg = accent === 'rubik-yellow' ? 'var(--color-display)' : `var(--color-${accent})`
  return { color: fg, background: `color-mix(in srgb, var(--color-${accent}) 14%, transparent)` }
}
