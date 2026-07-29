import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { marked } from 'marked'
import type { TemplateDetailView, TemplatePrereq } from '../types'
import { PublicHeader } from './TemplatesPage'
import { RatingChips, categoryTagStyle } from './TemplateRatingChips'
import { TemplateFlowDiagram } from './TemplateFlowDiagram'
import { TemplateIcon } from './TemplateIcon'

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
 * The PUBLIC template detail (`/templates/<slug>`) — split layout (round 10). The
 * header (tag, title, intro, chips, CTAs) spans the page; below it a two-column split:
 * LEFT is the loop itself — how a run flows (the drawn diagram), the mechanism facts
 * COLLAPSED under it (a native `<details>`, SSR-safe, closed by default — reference
 * detail, not the pitch) and the optional repo-authored
 * "Field notes" write-up (`story.md`: real results and learnings) — and RIGHT is the
 * REAL prompt this template feeds the agent, sticky so it stays alongside while the
 * left column scrolls. Public: no auth. English only.
 */
export function TemplateDetail({ data }: { data: TemplateDetailData | null }) {
  if (!data) return <NotFound />
  return <TemplateDetailBody data={data} />
}

function TemplateDetailBody({ data }: { data: TemplateDetailData }) {
  const { template: t, categoryLabel, accent } = data
  const r = t.rating

  // Once the header's own "Setup in Loopany" CTA scrolls out of view, surface a compact
  // twin beside "Copy prompt" in the sticky panel — the primary action must never be
  // off-screen. Client-only enhancement: SSR renders without it (ctaOffscreen false).
  const ctaRef = useRef<HTMLDivElement>(null)
  const [ctaOffscreen, setCtaOffscreen] = useState(false)
  useEffect(() => {
    const el = ctaRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const obs = new IntersectionObserver(([entry]) => setCtaOffscreen(!entry!.isIntersecting))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <>
      <PublicHeader />
      <main className="mx-auto max-w-[1120px] px-8 pb-24">
        <Link to="/templates" className="mt-8 inline-flex items-center gap-1.5 text-caption text-secondary transition-colors hover:text-display">
          <span aria-hidden>←</span> Back to templates
        </Link>

        {/* Header: category tag, title, intro, chips, CTA. */}
        <div className="mt-4 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-micro font-medium" style={categoryTagStyle(accent)}>
            {categoryLabel}
          </span>
        </div>
        <h1 className="mt-2 flex min-w-0 items-center gap-3 text-[clamp(24px,3.4vw,32px)] font-semibold leading-tight tracking-[-0.015em] text-display">
          <TemplateIcon name={t.name} size={30} className="shrink-0 text-secondary" />
          {t.label}
        </h1>
        <p className="mt-2 max-w-[46rem] text-body leading-relaxed text-secondary">{t.desc}</p>
        {r && <div className="mt-4">{<RatingChips rating={r} />}</div>}

        <div ref={ctaRef} className="mt-5 flex flex-wrap items-center gap-2.5">
          <Link
            to="/"
            search={{ template: t.name }}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-display bg-display px-4 py-2 text-body font-medium text-paper transition-opacity hover:opacity-85"
          >
            Setup in Loopany <span aria-hidden>→</span>
          </Link>
          <CopyLinkButton slug={t.name} />
        </div>

        {/* The split: the loop itself on the left, the copyable prompt on the right. */}
        <div className="mt-4 grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:items-start">
          <div className="min-w-0">
            {/* How a run actually flows — drawn from the template's own flow spec.
                Renders nothing for a template that declares none. */}
            <TemplateFlowDiagram name={t.name} />

            {/* What the loop needs before it runs well — only when declared. */}
            {data.prereqs && <Prereqs items={data.prereqs} />}

            {/* Mechanism facts, collapsed by default — reference detail, not pitch. */}
            {r && (
              <details className="group mt-4 rounded-card border border-hairline bg-surface">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-caption font-medium text-secondary transition-colors hover:text-display [&::-webkit-details-marker]:hidden">
                  <span aria-hidden className="inline-block text-micro transition-transform group-open:rotate-90">
                    ▸
                  </span>
                  How this loop works — schedule, exit, notifications
                </summary>
                <dl className="divide-y divide-hairline border-t border-hairline">
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
              </details>
            )}

            {/* Field notes — the honest how-it-really-ran write-up, when one exists. */}
            {data.story && <StorySection story={data.story} />}
          </div>

          {/* The REAL prompt this template runs — verbatim from the registry, sticky
              beside the left column on desktop. */}
          <div className="min-w-0 lg:sticky lg:top-16">
            <PromptBlock description={t.description} setupTemplate={ctaOffscreen ? t.name : null} />
            <p className="mt-3 text-caption leading-relaxed text-disabled">
              This is the exact intent appended to the bootstrap when you create the loop — your coding agent reads it,
              then proposes cadence and config and confirms with you before creating anything.
            </p>
          </div>
        </div>
      </main>
    </>
  )
}

/**
 * "Field notes" — the per-template `story.md`, REPO-AUTHORED and trusted (same trust
 * level as the folder's thumb.svg), so it renders through marked without the DOMPurify
 * pass the agent-generated surfaces need (DOMPurify also needs a DOM, and this route
 * SSRs). Styled by the `.storymd` article rules in `styles/app.css`.
 */
function StorySection({ story }: { story: string }) {
  return (
    <article
      className="storymd mt-10 border-t border-hairline pt-9"
      dangerouslySetInnerHTML={{ __html: marked.parse(story, { async: false, gfm: true }) as string }}
    />
  )
}

/** The prerequisites checklist: label (linked when a resource exists), a
 *  required/optional chip, and one quiet line of why. Hook-free (SSR). */
function Prereqs({ items }: { items: TemplatePrereq[] }) {
  return (
    <section className="mt-9">
      <h2 className="text-label font-semibold text-display">Prerequisites</h2>
      <ul className="mt-3 divide-y divide-hairline overflow-hidden rounded-card border border-hairline bg-surface">
        {items.map((p) => (
          <li key={p.label} className="flex min-w-0 items-start gap-3 px-4 py-3">
            <span aria-hidden className={`mt-0.5 text-caption ${p.optional ? 'text-disabled' : 'text-success'}`}>
              {p.optional ? '○' : '✓'}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-caption font-medium text-display">{p.label}</span>
                <span
                  className={`rounded-full px-1.5 py-px text-micro font-medium ${
                    p.optional ? 'bg-raised text-secondary' : 'bg-success-soft text-success'
                  }`}
                >
                  {p.optional ? 'optional' : 'required'}
                </span>
              </div>
              {(p.desc || p.href) && (
                <p className="mt-0.5 text-caption leading-snug text-secondary">
                  {p.desc}
                  {p.href && p.linkLabel && (
                    <>
                      {' '}
                      <a
                        href={p.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline decoration-wire underline-offset-2 transition-colors hover:text-display hover:decoration-display"
                      >
                        {p.linkLabel} <span aria-hidden>↗</span>
                      </a>
                    </>
                  )}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
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

function PromptBlock({ description, setupTemplate }: { description: string; setupTemplate: string | null }) {
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
    <section>
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 text-label font-semibold text-display">The prompt this runs</h2>
        <div className="flex shrink-0 items-center gap-2">
          {setupTemplate && (
            <Link
              to="/"
              search={{ template: setupTemplate }}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-display bg-display px-3 py-1 text-label font-medium text-paper transition-opacity hover:opacity-85"
            >
              Setup in Loopany <span aria-hidden>→</span>
            </Link>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-wire bg-surface px-3 py-1 text-label font-medium text-primary transition-colors hover:bg-raised"
          >
            {copied ? '✓ Copied' : 'Copy prompt'}
          </button>
        </div>
      </div>
      <pre className="mt-2 max-h-[calc(100vh-10rem)] overflow-auto whitespace-pre-wrap rounded-card border border-hairline bg-raised p-4 font-mono text-label leading-relaxed text-primary">
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
