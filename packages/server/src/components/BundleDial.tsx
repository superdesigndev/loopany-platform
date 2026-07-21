import { useCallback, useEffect, useRef, useState } from 'react'
import type { BundleView, TemplateInfo } from '../types'
import { AgentMarksRow } from './AgentMarks'

/** Degrees between adjacent spokes on the wheel — the arc a single spin sweeps. */
const STEP = 52

/**
 * The stage-select DIAL — an arcade song-wheel over the template bundles. A single
 * oversized disc (`.dial-wheel`) rotates by `var(--rot)`; each bundle is a spoke on its
 * rim, counter-rotated so it rides upright. Spinning brings the next bundle's fan of
 * loop-cards to the apex. Only the top arc of the disc is visible (the stage clips the
 * rest), so no page scroll is introduced.
 *
 * Navigation: prev/next arrows (no wrap-around), dot indicators, horizontal pointer
 * drag, and ArrowLeft/ArrowRight keys. Motion honors `prefers-reduced-motion` (the spin
 * transition is a CSS concern; see `.dial-wheel` in app.css). Light/dark ride the app's
 * `--color-*` tokens; a bundle's `accent` tints its chip + active dot.
 */
export function BundleDial({
  bundles,
  onPickTemplate,
  onTryBundle,
}: {
  bundles: BundleView[]
  /** A single member loop-card was clicked → set it up alone (the existing
   *  single-template compose path). */
  onPickTemplate: (t: TemplateInfo) => void
  /** "Copy prompt · try this bundle" → open the bundle compose path. */
  onTryBundle: (b: BundleView) => void
}) {
  const [idx, setIdx] = useState(0)
  const last = bundles.length - 1
  const clamp = useCallback((n: number) => Math.max(0, Math.min(last, n)), [last])
  const go = useCallback((n: number) => setIdx((cur) => clamp(typeof n === 'number' ? n : cur)), [clamp])
  const prev = useCallback(() => setIdx((i) => clamp(i - 1)), [clamp])
  const next = useCallback(() => setIdx((i) => clamp(i + 1)), [clamp])

  // Arrow keys spin the wheel — but never while the user is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        prev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next])

  // Horizontal pointer drag: past the threshold, spin ONE step in the drag direction.
  const drag = useRef<{ x: number; active: boolean }>({ x: 0, active: false })
  const DRAG_THRESHOLD = 60
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, active: true }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return
    const dx = e.clientX - drag.current.x
    if (Math.abs(dx) < DRAG_THRESHOLD) return
    // Drag right → previous (wheel spins clockwise, bringing the left spoke up).
    if (dx > 0) prev()
    else next()
    drag.current.active = false
  }
  const endDrag = () => {
    drag.current.active = false
  }

  return (
    <div className="mx-auto mt-3 max-w-[860px] select-none">
      <div
        className="dial-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        role="group"
        aria-label="Template bundles"
      >
        <div className="dial-wheel" style={{ ['--rot' as string]: `${-idx * STEP}deg` }}>
          {/* Decorative plate: tick marks + hairline border + inner dashed rim ring. */}
          <div className="dial-plate" aria-hidden />
          {bundles.map((b, i) => {
            const active = i === idx
            const accent = `var(--color-${b.accent})`
            return (
              <div
                key={b.name}
                className="dial-spoke"
                style={{ ['--a' as string]: `${i * STEP}deg` }}
                aria-hidden={!active}
              >
                <div className="dial-spoke-inner">
                  <div className={`dial-spoke-content ${active ? '' : 'dial-dim'}`} style={{ ['--accent' as string]: accent }}>
                    <BundleFace bundle={b} active={active} onPickTemplate={onPickTemplate} onTryBundle={onTryBundle} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Prev / next — disabled at the ends (no wrap-around). */}
        <button
          type="button"
          className="dial-arrow dial-arrow-prev"
          onClick={prev}
          disabled={idx === 0}
          aria-label="Previous bundle"
        >
          <ArrowGlyph dir="left" />
        </button>
        <button
          type="button"
          className="dial-arrow dial-arrow-next"
          onClick={next}
          disabled={idx === last}
          aria-label="Next bundle"
        >
          <ArrowGlyph dir="right" />
        </button>
      </div>

      {/* Dot indicators — the active dot stretches wider + tints with the accent. */}
      <div className="mt-1 flex items-center justify-center gap-2">
        {bundles.map((b, i) => (
          <button
            key={b.name}
            type="button"
            onClick={() => go(i)}
            aria-label={`Go to ${b.label} bundle`}
            aria-current={i === idx}
            className="h-2 rounded-full transition-all"
            style={{
              width: i === idx ? '22px' : '8px',
              background: i === idx ? `var(--color-${b.accent})` : 'var(--color-hairline)',
            }}
          />
        ))}
      </div>
    </div>
  )
}

/** One bundle's face at the apex: the accent chip + name + tagline + member count, a
 *  fan of member loop-cards, the try-bundle CTA, and the set-up-alone hint. */
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
  const center = (bundle.members.length - 1) / 2
  return (
    <div className="flex flex-col items-center">
      <span
        className="rounded-full px-2 py-0.5 text-micro font-semibold uppercase tracking-wider"
        style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}
      >
        Bundle
      </span>
      <div className="mt-1.5 text-[19px] font-semibold tracking-[-0.01em] text-display">{bundle.label}</div>
      <div className="mt-0.5 text-body text-secondary">{bundle.tagline}</div>
      <div className="mt-0.5 text-caption text-disabled">
        {bundle.members.length} {bundle.members.length === 1 ? 'loop' : 'loops'}
      </div>

      <div className="mt-3 flex items-start justify-center">
        {bundle.members.map((t, i) => {
          const off = i - center
          return (
            <button
              key={t.name}
              type="button"
              // Only the active face is interactive — background spokes are inert.
              tabIndex={active ? 0 : -1}
              onClick={() => active && onPickTemplate(t)}
              title={t.desc}
              className="fan-card relative w-[150px] shrink-0 cursor-pointer rounded-card border border-hairline bg-surface p-2.5 text-left shadow-[0_12px_28px_-16px_rgba(0,0,0,0.25)] outline-none focus-visible:ring-2 focus-visible:ring-interactive"
              style={
                {
                  '--tilt': `${off * 4}deg`,
                  '--lift': `${Math.abs(off) * 6}px`,
                  marginInline: bundle.members.length > 1 ? '-4px' : undefined,
                } as React.CSSProperties
              }
            >
              {t.thumb ? (
                // Repo-authored thumb.svg inlined by the registry (trusted content, same
                // boundary as skill markdown) — inline so it inherits theme CSS vars.
                <span
                  className="block overflow-hidden rounded-control bg-raised [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: t.thumb }}
                />
              ) : (
                <span className="flex h-[62px] items-center justify-center rounded-control bg-raised text-secondary">
                  <LoopGlyph />
                </span>
              )}
              <span className="mt-2 block truncate text-center text-caption font-semibold text-primary">{t.label}</span>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        tabIndex={active ? 0 : -1}
        onClick={() => active && onTryBundle(bundle)}
        className="mt-4 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-display px-4 py-2 text-meta font-medium text-paper outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-interactive"
      >
        <AgentMarksRow />
        Copy prompt · try this bundle
      </button>
      <div className="mt-1.5 text-caption text-disabled">or click a loop to set it up alone</div>
    </div>
  )
}

/** A left/right chevron for the spin arrows. */
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
      width="26"
      height="26"
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
