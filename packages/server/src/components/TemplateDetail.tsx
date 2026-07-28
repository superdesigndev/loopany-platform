import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { TemplateDetailView } from '../types'
import { PublicHeader } from './TemplatesPage'
import { RatingChips, categoryTagStyle } from './TemplateRatingChips'

/** What the `/templates/<slug>` loader resolves: the template + its category context.
 *  The shape lives in `types.ts` (the server resolves it by slug); this alias keeps the
 *  view's own import surface stable. */
export type TemplateDetailData = TemplateDetailView

const easeNote: Record<string, string> = {
  easy: 'Runs with almost no setup — confirm a detail or two and go.',
  moderate: 'Some setup and context are needed before the first useful run.',
  advanced: 'A guided, multi-step setup (access, accounts, rules) before it can run.',
}

/**
 * The PUBLIC template detail (`/templates/<slug>`) — reference-site style. Exposes the
 * loop ITSELF: the full plain-language intro, structured mechanism facts (suggested
 * schedule, open/closed, exit condition, notifications), the rating dimensions with
 * their honest notes, and the REAL prompt this template feeds the agent (verbatim from
 * the registry) with a Copy button. A primary "Create directly in Loopany" CTA deep-links
 * into the real compose flow with this template preselected. Public: no auth. English only.
 */
export function TemplateDetail({ data }: { data: TemplateDetailData | null }) {
  if (!data) return <NotFound />
  const { template: t, categoryLabel, accent } = data
  const r = t.rating

  return (
    <>
      <PublicHeader />
      <main className="mx-auto max-w-[860px] px-8 pb-24">
        <Link to="/templates" className="mt-8 inline-flex items-center gap-1.5 text-caption text-secondary transition-colors hover:text-display">
          <span aria-hidden>←</span> Back to templates
        </Link>

        {/* Header: category tag, title, intro, chips, CTA. */}
        <div className="mt-4 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-micro font-medium" style={categoryTagStyle(accent)}>
            {categoryLabel}
          </span>
        </div>
        <h1 className="mt-2 text-[clamp(24px,3.4vw,32px)] font-semibold leading-tight tracking-[-0.015em] text-display">{t.label}</h1>
        <p className="mt-2 max-w-[46rem] text-body leading-relaxed text-secondary">{t.desc}</p>
        {r && <div className="mt-4">{<RatingChips rating={r} />}</div>}

        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <Link
            to="/"
            search={{ template: t.name }}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-display bg-display px-4 py-2 text-body font-medium text-paper transition-opacity hover:opacity-85"
          >
            Create directly in Loopany <span aria-hidden>→</span>
          </Link>
          <CopyLinkButton slug={t.name} />
        </div>

        {/* Mechanism facts, structured. */}
        {r && (
          <section className="mt-9">
            <h2 className="text-label font-semibold text-display">How this loop works</h2>
            <dl className="mt-3 divide-y divide-hairline overflow-hidden rounded-card border border-hairline bg-surface">
              <FactRow term="Suggested schedule" desc={r.schedule} />
              <FactRow
                term="Loop type"
                desc={
                  r.mechanism === 'closed'
                    ? 'Closed loop — goal-bound; it finishes itself when the goal is met.'
                    : 'Open loop — an ongoing monitor with no finish line.'
                }
              />
              <FactRow
                term="Exit condition"
                desc={r.mechanism === 'closed' ? r.exitCondition ?? 'Finishes when its goal is met.' : 'Runs indefinitely (no finish line).'}
              />
              <FactRow
                term="Notifications"
                desc="On by default — you're alerted on each run's outcome (completion or failure). Silence with notify: never."
              />
              <FactRow term="Ease of starting" desc={easeNote[r.ease] ?? ''} />
              <FactRow term="When you see value" desc={r.visibilityNote} />
            </dl>
          </section>
        )}

        {/* The REAL prompt this template runs — verbatim from the registry. */}
        <PromptBlock description={t.description} />

        <p className="mt-4 text-caption leading-relaxed text-disabled">
          This is the exact intent appended to the bootstrap when you create the loop — your coding agent reads it, then
          proposes cadence and config and confirms with you before creating anything.
        </p>
      </main>
    </>
  )
}

function FactRow({ term, desc }: { term: string; desc: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-caption font-medium text-secondary sm:w-40">{term}</dt>
      <dd className="min-w-0 text-caption leading-snug text-primary">{desc}</dd>
    </div>
  )
}

function PromptBlock({ description }: { description: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(description)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable — the text is selectable in the block below */
    }
  }
  return (
    <section className="mt-9">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-label font-semibold text-display">The prompt this runs</h2>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-wire bg-surface px-3 py-1 text-label font-medium text-primary transition-colors hover:bg-raised"
        >
          {copied ? '✓ Copied' : 'Copy prompt'}
        </button>
      </div>
      <pre className="mt-2 max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-card border border-hairline bg-raised p-4 font-mono text-label leading-relaxed text-primary">
        {description}
      </pre>
    </section>
  )
}

function CopyLinkButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      const href = typeof window !== 'undefined' ? `${window.location.origin}/templates/${slug}` : `/templates/${slug}`
      await navigator.clipboard.writeText(href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* ignore */
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex cursor-pointer items-center rounded-full border border-wire bg-surface px-4 py-2 text-body font-medium text-primary transition-colors hover:bg-raised"
    >
      {copied ? '✓ Link copied' : 'Copy link'}
    </button>
  )
}

function NotFound() {
  return (
    <>
      <PublicHeader />
      <main className="mx-auto max-w-[860px] px-8 pb-24">
        <div className="mt-32 text-center">
          <h1 className="text-[22px] font-semibold text-display">Template not found</h1>
          <p className="mt-2 text-body text-secondary">That template does not exist (or was renamed).</p>
          <Link
            to="/templates"
            className="mt-6 inline-flex cursor-pointer items-center rounded-full border border-display bg-display px-4 py-2 text-body font-medium text-paper transition-opacity hover:opacity-85"
          >
            Browse all templates
          </Link>
        </div>
      </main>
    </>
  )
}
