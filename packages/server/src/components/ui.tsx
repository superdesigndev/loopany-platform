import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import type { RunSummary } from '../types'
import { dotColor, dotLabel } from '../lib/format'

/*
 * Hydration gate. `fmt`/`rel`/`until` (lib/format) read the wall clock and the
 * runtime locale — toLocaleString() renders in the server's timezone (UTC) and
 * Date.now() differs between the SSR instant and the hydration instant, so any
 * time string baked into the server HTML mismatches the client and React warns.
 * Gate those renders behind this: server + first client paint both yield the
 * stable fallback (no mismatch), then the post-mount snapshot flips to true and
 * the real local/relative time renders. useSyncExternalStore needs no effect
 * and never subscribes (the value only flips once, at mount).
 */
const noopSubscribe = () => () => {}
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )

/*
 * Shared control/field tokens (single source so they can't drift across forms/
 * modals). Buttons: sans 13px/500, Apple control radius, Geist state
 * progression - primary is the display-ink fill, secondary is a surface card
 * with a wire border that raises on hover, destructive fills with the Rubik
 * red. The double focus ring (surface 2px + interactive blue 4px) is shared by
 * every control.
 */
export const focusRing = 'focus-visible:outline-none focus-visible:shadow-focus'
const btnBase = `inline-flex cursor-pointer items-center gap-1.5 rounded-control px-4 py-2 text-body font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${focusRing}`
export const btn = `${btnBase} border border-wire bg-surface text-primary hover:bg-raised`
export const btnPrimary = `${btnBase} border border-display bg-display text-paper hover:opacity-85`
export const btnDanger = `${btnBase} border border-transparent bg-rubik-red text-white hover:opacity-85`
// The metered tier - actions that spend real credits (Run / Evolve). Heavier
// than the wire-bordered secondary (full ink border) so cost reads as more
// consequential than a free toggle, but still no fill - it sits visually
// between `btn` (free) and `btnPrimary` (the screen's lead verb).
export const btnCost = `${btnBase} border border-display bg-transparent text-display hover:bg-[color:var(--color-display)]/8`
// Compact control - its own padding/size base (NOT btnBase) so it can't lose
// the px/text tug-of-war on CSS source-order. For inline affordances like Copy
// that sit next to dense content rather than anchoring a dialog.
export const btnSm = `inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-wire bg-surface px-3 py-1 text-label font-medium text-primary transition-colors duration-150 hover:bg-raised disabled:cursor-default disabled:opacity-40 ${focusRing}`

// A quiet borderless text button - back links, Done, dismissals.
export const btnQuiet =
  'inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-meta font-medium text-secondary transition-colors hover:text-display'

/** Section divider heading ink - shared by ModalSection and the page panels. */
export const sectionHeadCls = 'text-label font-semibold text-secondary'

/** Field labels: sentence case, quiet weight - hierarchy from color, not caps. */
export const labelCls = 'mb-1.5 mt-3 block text-label font-medium text-secondary'
export const inputCls = `w-full rounded-control border border-wire bg-surface px-3 py-2.5 text-sm text-primary outline-none transition-shadow focus:border-transparent focus:shadow-focus`
/** Content-editing textareas keep mono - they hold markdown/code, not prose. */
export const areaCls = `${inputCls} min-h-16 resize-y bg-raised font-mono text-body leading-relaxed`
/** Field-sized <select>: the input token + the `.lp-select` caret/padding. */
export const selectCls = `${inputCls} lp-select cursor-pointer`

/**
 * The live "running" pulse — a display-ink fill breathing via the `runPulse`
 * keyframe (app.css). Shared so the in-flight timeline block and the Running
 * badge stay in lockstep. Spread into a `style` prop.
 */
/** Just the breathing animation — spread onto any element to pulse it in its own color. */
export const runPulseAnim = { animation: 'runPulse 1.1s ease-in-out infinite' } as const

/** The live "running" signal light - the Rubik yellow, breathing. */
export const runPulseStyle = {
  background: 'var(--color-rubik-yellow)',
  ...runPulseAnim,
} as const

/** The shared inline error banner - red signal dot + message + a dismiss link.
 *  One source so the four call sites (modals + detail view) stay in lockstep. */
export function ErrorBanner({
  message,
  onDismiss,
  className = 'mb-2',
}: {
  message: string
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div className={`flex items-start gap-2 text-body text-accent ${className}`}>
      <span className="mt-[5px] size-2 shrink-0 rounded-full bg-rubik-red" aria-hidden />
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto shrink-0 cursor-pointer border-none bg-transparent p-0 text-label text-secondary transition-colors hover:text-display"
        >
          Dismiss
        </button>
      )}
    </div>
  )
}

/** A read-only mono code block (task file / transcript / control dump). */
export function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap rounded-control border border-hairline bg-raised px-4 py-3.5 font-mono text-meta leading-relaxed text-secondary">
      {children}
    </pre>
  )
}

/** A run's created/edited files — shared by the run detail + the edit-watch panel.
 *  Paths stay mono (they are code); the kind tag is a quiet sans chip. */
export function ArtifactList({ artifacts }: { artifacts: NonNullable<RunSummary['artifacts']> }) {
  return (
    <ul className="space-y-1">
      {artifacts.map((a) => (
        <li key={a.path} className="flex items-baseline gap-2">
          <span
            className={`shrink-0 text-caption font-medium ${a.kind === 'created' ? 'text-success' : 'text-secondary'}`}
          >
            {a.kind === 'created' ? 'new' : 'edit'}
          </span>
          <span className="break-all font-mono text-meta text-primary">{a.path}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The status/role chip - ONE recipe for every soft rounded pill in the app
 * (loop cards, detail header, run chips, kanban/type chips at their own sizes
 * stay separate). Tones map to the semantic -soft pairs; `ink` is the neutral
 * pill with primary text (e.g. a duration), `outline` the quiet bordered chip
 * (e.g. the recorded agent).
 */
const PILL_TONES = {
  neutral: 'bg-raised text-secondary',
  ink: 'bg-raised text-primary',
  outline: 'border border-hairline text-secondary',
  running: 'bg-running-soft text-running',
  success: 'bg-success-soft text-success',
  accent: 'bg-accent-soft text-accent',
  warn: 'bg-warn-soft text-warn',
} as const

export function Pill({
  tone = 'neutral',
  dot,
  title,
  children,
}: {
  tone?: keyof typeof PILL_TONES
  /** Optional signal light: 'pulse' = the breathing yellow, 'green' = solid go. */
  dot?: 'pulse' | 'green'
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-caption font-medium ${PILL_TONES[tone]}`}
    >
      {dot && (
        <span
          className="size-1.5 rounded-full"
          style={dot === 'pulse' ? runPulseStyle : { background: 'var(--color-rubik-green)' }}
        />
      )}
      {children}
    </span>
  )
}

/** The shared quiet loading placeholder. */
export function Loading({ className = '' }: { className?: string }) {
  return <div className={`text-body text-disabled ${className}`}>Loading…</div>
}

/** A run's status as a colored dot + label. `colorText` also tints the label. */
export function StatusPill({ run, colorText }: { run: RunSummary; colorText?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-medium"
      style={colorText ? { color: dotColor(run) } : undefined}
    >
      <span className="size-2 rounded-full" style={{ background: dotColor(run) }} />
      {dotLabel(run)}
    </span>
  )
}
