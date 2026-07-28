import { useCallback, useEffect, useRef, useState } from 'react'
import type { BundleView, TemplateInfo } from '../types'

/** Auto-advance interval — calm, a few seconds per bundle. */
const AUTOPLAY_MS = 4500

/**
 * Split `items` into rows of at most `maxPerRow`, filling each row before wrapping (so
 * the larger rows sit on top), matching the product rule: 3 → [3], 4 → [3, 1],
 * 5 → [3, 2], 7 → [3, 3, 1]. Pure + data-driven (no hardcoded counts).
 */
export function splitRows<T>(items: T[], maxPerRow: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += maxPerRow) rows.push(items.slice(i, i + maxPerRow))
  return rows
}

/** True when the user asked for reduced motion (no auto-play, no slide tween). Guards
 *  the jsdom/SSR case where `matchMedia` is absent. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * The bundle CAROUSEL — one bundle in focus at a time, auto-playing on a calm interval
 * and pausing on hover/focus (and permanently after a manual nav). A plain slide
 * carousel (no rotating disc/spin): a translated track inside a clipped viewport, prev/
 * next arrows, and pager dots. The active bundle shows its fanned loop-cards (wrapping in
 * balanced rows of up to three WITHIN the bundle), its name/tagline/loop-count, and —
 * unless it is an individually-set-up category ("Others") — a "Try this bundle" CTA.
 * `prefers-reduced-motion` disables both auto-play and the slide tween. English only.
 */
export function BundleCarousel({
  bundles,
  onPickTemplate,
  onTryBundle,
}: {
  bundles: BundleView[]
  /** A single member loop-card was clicked → set it up alone (the existing
   *  single-template compose path). */
  onPickTemplate: (t: TemplateInfo) => void
  /** A tryable bundle's "Try this bundle" CTA → open the bundle compose path. */
  onTryBundle: (b: BundleView) => void
}) {
  const n = bundles.length
  const [idx, setIdx] = useState(0)
  // `hovered`/`focused` pause auto-play transiently; `stopped` disables it for good
  // after a deliberate manual navigation (arrow / dot). Non-annoying by construction.
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [stopped, setStopped] = useState(false)
  const reduced = usePrefersReducedMotion()

  const next = useCallback(() => setIdx((i) => (i + 1) % n), [n])
  const prev = useCallback(() => setIdx((i) => (i - 1 + n) % n), [n])
  const goManual = useCallback((i: number) => {
    setStopped(true)
    setIdx(((i % n) + n) % n)
  }, [n])
  const navManual = useCallback((dir: 1 | -1) => {
    setStopped(true)
    setIdx((i) => (i + dir + n) % n)
  }, [n])

  const autoplaying = !reduced && !stopped && !hovered && !focused && n > 1
  useEffect(() => {
    if (!autoplaying) return
    const t = setInterval(next, AUTOPLAY_MS)
    return () => clearInterval(t)
  }, [autoplaying, next])

  // Focus within the carousel pauses auto-play; leaving it resumes (unless stopped).
  const rootRef = useRef<HTMLDivElement>(null)

  // Arrow keys navigate (and count as a manual stop) — SCOPED to the carousel (WAI
  // carousel pattern): the listener sits on the root, so a press only counts when the
  // event actually originates inside it. Never while typing in a field, and never while
  // a dialog owns the page (the carousel stays mounted behind every dashboard modal,
  // where it isn't even visible — stealing the keys there would silently advance it and
  // kill auto-play for good).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const target = e.target as Node | null
      if (!target || !root.contains(target)) return
      const el = document.activeElement
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if (document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      navManual(e.key === 'ArrowLeft' ? -1 : 1)
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [navManual])

  const onBlurCapture = (e: React.FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false)
  }

  return (
    <div
      ref={rootRef}
      className="mx-auto mt-3 max-w-[720px]"
      role="group"
      aria-roledescription="carousel"
      aria-label="Template bundles"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={onBlurCapture}
    >
      <div className="relative">
        {/* Clipped viewport + translated track = a plain slide carousel (no page scroll). */}
        <div className="bundle-carousel-viewport">
          <div className="bundle-carousel-track" style={{ transform: `translateX(${-idx * 100}%)` }}>
            {bundles.map((b, i) => (
              <div
                key={b.name}
                className="bundle-slide"
                role="group"
                aria-roledescription="slide"
                aria-label={`${b.label} (${i + 1} of ${n})`}
                aria-hidden={i !== idx}
              >
                <BundleFace bundle={b} active={i === idx} onPickTemplate={onPickTemplate} onTryBundle={onTryBundle} />
              </div>
            ))}
          </div>
        </div>

        {/* Prev / next arrows (wrap-around, so auto-play + arrows cycle cleanly). */}
        {n > 1 && (
          <>
            <button type="button" className="bundle-arrow bundle-arrow-prev" onClick={() => navManual(-1)} aria-label="Previous bundle">
              <ArrowGlyph dir="left" />
            </button>
            <button type="button" className="bundle-arrow bundle-arrow-next" onClick={() => navManual(1)} aria-label="Next bundle">
              <ArrowGlyph dir="right" />
            </button>
          </>
        )}
      </div>

      {/* Pager dots — active dot stretches wider + tints with the bundle accent. */}
      {n > 1 && (
        <div className="mt-3 flex items-center justify-center gap-2">
          {bundles.map((b, i) => (
            <button
              key={b.name}
              type="button"
              onClick={() => goManual(i)}
              aria-label={`Go to ${b.label}`}
              aria-current={i === idx}
              className="h-2 rounded-full transition-all"
              style={{
                width: i === idx ? '22px' : '8px',
                background: i === idx ? `var(--color-${b.accent})` : 'var(--color-hairline)',
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** The active bundle's face: name + loop count + tagline, the fanned loop-cards (wrapping
 *  in rows of up to three), the "Try this bundle" CTA (tryable bundles only), and the
 *  set-up-a-single-loop hint. */
function BundleFace({
  bundle,
  active,
  onPickTemplate,
  onTryBundle,
}: {
  bundle: BundleView
  active: boolean
  onPickTemplate: (t: TemplateInfo) => void
  onTryBundle: (b: BundleView) => void
}) {
  const accent = `var(--color-${bundle.accent})`
  // A few accents (rubik-yellow) are too LIGHT for white CTA text — use dark ink there.
  const LIGHT_ACCENTS = new Set(['rubik-yellow'])
  const ctaText = LIGHT_ACCENTS.has(bundle.accent) ? 'var(--color-display)' : 'var(--color-paper)'
  const rows = splitRows(bundle.members, 3)
  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center px-10 py-2">
      <div className="text-[18px] font-semibold tracking-[-0.01em] text-display">{bundle.label}</div>
      <div className="mt-0.5 text-center text-body text-secondary">{bundle.tagline}</div>

      {/* The fan — balanced rows of up to three cards; tilt/lift grow from each row's
          center. A click sets up that single loop alone. */}
      <div className="mt-3 flex flex-col items-center gap-1">
        {rows.map((row, r) => {
          const center = (row.length - 1) / 2
          return (
            <div key={r} className="flex flex-wrap items-start justify-center">
              {row.map((t, i) => {
                const off = i - center
                return (
                  <button
                    key={t.name}
                    type="button"
                    tabIndex={active ? 0 : -1}
                    onClick={() => active && onPickTemplate(t)}
                    title={t.desc}
                    className="fan-card relative w-[128px] shrink-0 cursor-pointer rounded-card border border-hairline bg-surface p-2 text-left shadow-[0_12px_28px_-16px_rgba(0,0,0,0.25)] outline-none focus-visible:ring-2 focus-visible:ring-interactive"
                    style={
                      {
                        '--tilt': `${off * 4}deg`,
                        '--lift': `${Math.abs(off) * 5}px`,
                        marginInline: row.length > 1 ? '-14px' : undefined,
                      } as React.CSSProperties
                    }
                  >
                    {t.thumb ? (
                      <span
                        className="block overflow-hidden rounded-control bg-raised [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
                        dangerouslySetInnerHTML={{ __html: t.thumb }}
                      />
                    ) : (
                      <span className="flex h-[52px] items-center justify-center rounded-control bg-raised text-secondary">
                        <LoopGlyph />
                      </span>
                    )}
                    <span className="mt-1.5 block truncate text-center text-micro font-semibold text-primary">{t.label}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Tryable bundles get the CTA; the "Others" category (individual) never does — its
          loops are set up one at a time via the single-loop click above. */}
      {!bundle.individual && (
        <button
          type="button"
          tabIndex={active ? 0 : -1}
          onClick={() => active && onTryBundle(bundle)}
          className="mt-4 inline-flex cursor-pointer items-center rounded-full px-4 py-2 text-meta font-medium outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-interactive"
          style={{ background: accent, color: ctaText }}
        >
          Try this bundle
        </button>
      )}
      <div className="mt-2 text-caption text-disabled">or click a loop to set it up alone</div>
    </div>
  )
}

/** A left/right chevron for the carousel arrows. */
function ArrowGlyph({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {dir === 'left' ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  )
}

/** A circular-arrow "loop" mark — the per-card fallback when a template ships no thumb. */
function LoopGlyph() {
  return (
    <svg
      aria-hidden
      width="24"
      height="24"
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
