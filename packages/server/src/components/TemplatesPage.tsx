import { Link } from '@tanstack/react-router'
import type {
  BundleView,
  TemplateCadence,
  TemplateEase,
  TemplateInfo,
  TemplateMechanism,
  TemplateVisibility,
} from '../types'
import { LoopLogo } from './LoopLogo'
import { DISCORD_URL, DiscordIcon, GITHUB_URL, GitHubIcon } from './SocialLinks'

/**
 * The PUBLIC template catalog (`/templates`) — reachable without login (its route runs
 * no auth check, so it renders even under the login gate). It shares every template in
 * the catalog for free, grouped by the same 6 categories as the dashboard carousel, with
 * the editorial round-6 ratings on each card. English copy only; the "Use this template"
 * CTA is a plain link to the app entry (`/`), which shows sign-in under the gate.
 */
export function TemplatesPage({ bundles }: { bundles: BundleView[] }) {
  const total = bundles.reduce((n, b) => n + b.members.length, 0)
  return (
    <>
      {/* Public top bar — quiet, marketing-grade. */}
      <header className="glass glass-bar sticky top-0 z-50">
        <div className="mx-auto flex max-w-[1180px] items-center gap-3 px-8 py-2.5">
          <Link to="/" className="flex items-center gap-3">
            <LoopLogo size={30} />
            <span className="text-[18px] font-semibold tracking-[-0.015em] text-display">Loopany</span>
          </Link>
          <span className="ml-1 hidden rounded-full bg-raised px-2.5 py-0.5 text-micro font-medium text-secondary sm:inline">
            Templates
          </span>
          <div className="flex-1" />
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub repository" title="GitHub" className={headerIconBtn}>
            <GitHubIcon className="size-[17px]" />
          </a>
          <a href={DISCORD_URL} target="_blank" rel="noreferrer" aria-label="Discord community" title="Discord" className={headerIconBtn}>
            <DiscordIcon className="size-[17px]" />
          </a>
          <Link
            to="/"
            className="inline-flex shrink-0 cursor-pointer items-center rounded-full bg-display px-3.5 py-1.5 text-meta font-medium text-paper transition-opacity hover:opacity-85"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-8 pb-24">
        {/* Hero */}
        <section className="pt-14 text-center">
          <h1 className="font-pixel text-[clamp(26px,4.2vw,36px)] leading-[1.15] text-display">The Loopany template catalog</h1>
          <p className="mx-auto mt-3 max-w-[42rem] text-body leading-relaxed text-secondary">
            {total} ready-to-run agent loops that work while you sleep — free to browse. Pick one, and set it up on your
            own machine with your own coding agent.
          </p>
          <Legend />
        </section>

        {/* One section per category, mirroring the dashboard carousel order. */}
        {bundles.map((b) => (
          <section key={b.name} className="mt-12">
            <div className="mb-4 flex items-baseline gap-3">
              <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-display">{b.label}</h2>
              <span className="text-caption text-secondary">{b.tagline}</span>
            </div>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {b.members.map((t) => (
                <TemplateCard key={t.name} template={t} />
              ))}
            </div>
          </section>
        ))}

        <p className="mt-16 text-center text-caption text-disabled">
          Every loop runs on your machine via your own coding agent — the server never runs an LLM or your code.
        </p>
      </main>
    </>
  )
}

/** A short at-a-glance key for the three rating dimensions. */
function Legend() {
  return (
    <div className="mx-auto mt-6 flex max-w-[46rem] flex-wrap items-center justify-center gap-x-6 gap-y-1 text-caption text-secondary">
      <span>
        <strong className="font-semibold text-primary">Ease</strong> — setup needed before it delivers
      </span>
      <span>
        <strong className="font-semibold text-primary">Cycle &amp; mechanism</strong> — cadence + open vs closed loop
      </span>
      <span>
        <strong className="font-semibold text-primary">Effect</strong> — how soon you see value
      </span>
    </div>
  )
}

function TemplateCard({ template: t }: { template: TemplateInfo }) {
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-hairline bg-surface p-4 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
      {t.thumb ? (
        // Repo-authored thumb.svg, inlined so it inherits the theme's CSS variables
        // (trusted content, same boundary as the dashboard cards).
        <span
          className="block overflow-hidden rounded-control bg-raised [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
          dangerouslySetInnerHTML={{ __html: t.thumb }}
        />
      ) : (
        <span className="flex h-[76px] items-center justify-center rounded-control bg-raised text-secondary">
          <LoopGlyph />
        </span>
      )}
      <h3 className="mt-3 text-body font-semibold text-display">{t.label}</h3>
      <p className="mt-1 line-clamp-2 text-caption leading-snug text-secondary">{t.desc}</p>

      {t.rating && (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chip {...easeChip(t.rating.ease)} />
            <Chip label={cadenceLabel[t.rating.cadence]} tone="outline" />
            <Chip label={mechanismLabel[t.rating.mechanism]} tone="outline" />
            <Chip {...visibilityChip(t.rating.visibility)} title={t.rating.visibilityNote} />
          </div>
          <p className="mt-2 text-micro leading-snug text-disabled">{t.rating.visibilityNote}</p>
        </>
      )}

      <div className="mt-3 flex-1" />
      <Link
        to="/"
        className="mt-3 inline-flex w-full cursor-pointer items-center justify-center rounded-full border border-wire bg-surface px-3.5 py-1.5 text-meta font-medium text-primary transition-colors hover:bg-display hover:text-paper"
      >
        Use this template →
      </Link>
    </div>
  )
}

/* ── rating chips ─────────────────────────────────────────────── */

type ChipTone = 'green' | 'orange' | 'red' | 'blue' | 'neutral' | 'outline'

const TONE_STYLE: Record<ChipTone, React.CSSProperties> = {
  green: { color: 'var(--color-rubik-green)', background: 'var(--color-success-soft)' },
  orange: { color: 'var(--color-rubik-orange)', background: 'color-mix(in srgb, var(--color-rubik-orange) 12%, transparent)' },
  red: { color: 'var(--color-rubik-red)', background: 'var(--color-accent-soft)' },
  blue: { color: 'var(--color-interactive)', background: 'var(--color-interactive-soft)' },
  neutral: { color: 'var(--color-secondary)', background: 'color-mix(in srgb, var(--color-secondary) 10%, transparent)' },
  outline: { color: 'var(--color-secondary)', background: 'transparent', boxShadow: 'inset 0 0 0 1px var(--color-hairline)' },
}

function Chip({ label, tone, title }: { label: string; tone: ChipTone; title?: string }) {
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

function easeChip(ease: TemplateEase): { label: string; tone: ChipTone } {
  return {
    easy: { label: 'Easy start', tone: 'green' as ChipTone },
    moderate: { label: 'Moderate setup', tone: 'orange' as ChipTone },
    advanced: { label: 'Advanced setup', tone: 'red' as ChipTone },
  }[ease]
}

function visibilityChip(v: TemplateVisibility): { label: string; tone: ChipTone } {
  return {
    'first-run': { label: 'Visible first run', tone: 'green' as ChipTone },
    'few-runs': { label: 'Builds over runs', tone: 'blue' as ChipTone },
    compounds: { label: 'Compounds over weeks', tone: 'neutral' as ChipTone },
  }[v]
}

const cadenceLabel: Record<TemplateCadence, string> = { short: 'Short cycle', long: 'Long cycle' }
const mechanismLabel: Record<TemplateMechanism, string> = { open: 'Open loop', closed: 'Closed loop' }

/* The quiet header icon-button (GitHub/Discord). */
const headerIconBtn =
  'inline-flex shrink-0 cursor-pointer items-center rounded-full p-1.5 text-secondary transition-colors hover:bg-raised hover:text-display'

/** A circular-arrow "loop" mark — the per-card fallback when a template ships no thumb. */
function LoopGlyph() {
  return (
    <svg aria-hidden width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M25.5 15a10.5 10.5 0 1 1-3.1-7.4" />
      <path d="M25.5 3.5v5.2h-5.2" />
    </svg>
  )
}
