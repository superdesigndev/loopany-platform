import { useEffect, useRef, type ReactNode } from 'react'

import type { EventShape, RunRow } from './api'
import { ViewError } from './api'

/**
 * The shared vocabulary every screen speaks — glyphs, time, state pills, rows,
 * section cards, the drawer, the refusal panel and the event timeline.
 *
 * These are the graph workspace's primitives, COPIED into the rewrite's own tree
 * (unit 8) rather than imported across the two lines: both branches own a
 * `components/workspace/` directory and a `styles/workspace.css`, so sharing a
 * module would deepen a conflict the chain merge already has to resolve. What is
 * lifted is the FORM — `ViewHeader`, `Section`, `ArtifactRow`, `Drawer`,
 * `.state-label` — pointed at the rewrite kernel's own shapes.
 *
 * Kept in one file so a pill means the same thing on the inbox, the board, the
 * loop page and the doc library.
 */

const GLYPHS: Record<string, string> = {
  inbox: '◍', tasks: '▤', loops: '↻', docs: '□', system: '⌘',
  question: '?', due: '◷', orphan: '⊘', chevron: '›', run: '↻', doc: '□',
  html: '◈', task: '▫', event: '·', close: '×', back: '‹',
}

export function Glyph({ name }: { name: string }) {
  return (
    <span className="glyph" aria-hidden="true">
      {GLYPHS[name] ?? '·'}
    </span>
  )
}

export function rel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const future = ms < 0
  const abs = Math.abs(ms)
  const minutes = Math.round(abs / 60_000)
  const text =
    minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`
  if (text === 'just now') return text
  return future ? `in ${text}` : `${text} ago`
}

export function When({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  if (!iso) return <time>—</time>
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {prefix ? `${prefix} ` : ''}
      {rel(iso)}
    </time>
  )
}

/**
 * THE VIEW HEADER — breadcrumb, one large tightly-tracked title, the sentence
 * that says what the screen is for, and a right-aligned count.
 *
 * Lifted from the reference verbatim. It is what makes every screen read as a
 * DOCUMENT rather than a panel, which is the single strongest carrier of the
 * design language.
 */
export function ViewHeader({ eyebrow, title, description, meta }: { eyebrow: string; title: string; description: string; meta?: ReactNode }) {
  return (
    <header className="view-header">
      <div className="breadcrumb">
        <span>Loopany</span>
        <Glyph name="chevron" />
        <b>{eyebrow}</b>
      </div>
      <div className="title-row">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {meta !== undefined && <span className="view-meta">{meta}</span>}
      </div>
    </header>
  )
}

/**
 * The §6 safety-floor counters, at a glance on every screen that has them.
 *
 * Three separate figures rather than one summary sentence: each is a distinct
 * route into the inbox, and collapsing them would hide which floor is holding
 * the work. Zero renders quiet rather than absent — "no orphans" is a fact worth
 * seeing, and a disappearing row would make the strip jump.
 */
export function CountStrip({ counts }: { counts: { question: number; dueUnwatched: number; orphan: number } }) {
  const cells: [string, number][] = [
    ['questions', counts.question],
    ['due · unwatched', counts.dueUnwatched],
    ['orphan floor', counts.orphan],
  ]
  return (
    <dl className="count-strip">
      {cells.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={value === 0 ? 'is-zero' : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

type Tone = 'needs' | 'attention' | 'effects' | 'plain'

const TONE_CLASS: Record<Tone, string> = {
  needs: 'needs-section',
  attention: 'attention-section',
  effects: 'effects-section',
  plain: 'library-group',
}

const TONE_DOT: Record<Tone, string | null> = {
  needs: 'attention-dot',
  attention: 'attn-dot',
  effects: 'effects-dot',
  plain: null,
}

/**
 * A tinted section card. The TONE is a meaning, not a colour choice — the rule
 * the reference sheet states and this surface keeps: amber is a decision you
 * owe, rose is a consequence that did not happen, blue is a decision already made
 * and on its way out, plain is content.
 */
export function Section({ tone = 'plain', title, count, note, children }: { tone?: Tone; title: string; count?: ReactNode; note?: string; children: ReactNode }) {
  const dot = TONE_DOT[tone]
  return (
    <section className={TONE_CLASS[tone]}>
      <div className="section-heading">
        <div>
          {dot && <span className={dot} />}
          <h2>{title}</h2>
          {count !== undefined && <span>{count}</span>}
        </div>
        {note && <p>{note}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * THE ROW — the reference's 62px five-track grid: an icon tile, the title over
 * its source line, a state pill, an age, and one action slot.
 *
 * Rendered as a `<button>` when it opens something, so the whole row is one
 * keyboard-reachable target rather than a div with a click handler.
 */
export function ArtifactRow({
  icon, iconTone, title, source, state, stateTone, when, action, selected, onOpen, ariaLabel,
}: {
  icon: string
  iconTone?: string
  title: ReactNode
  source?: ReactNode
  state?: string
  stateTone?: 'human' | 'floor' | 'ok' | 'live' | 'html'
  when?: string | null
  action?: ReactNode
  selected?: boolean
  onOpen?: () => void
  ariaLabel?: string
}) {
  const className = ['artifact-row', onOpen ? 'is-previewable' : '', selected ? 'is-selected' : ''].filter(Boolean).join(' ')
  const inner = (
    <>
      <span className={`artifact-icon ${iconTone ? `icon-${iconTone}` : ''}`}>
        <Glyph name={icon} />
      </span>
      <span className="artifact-main">
        <h3>{title}</h3>
        {source !== undefined && <p>{source}</p>}
      </span>
      {state ? <span className={`state-label ${stateTone ? `state-${stateTone}` : ''}`}>{state}</span> : <span />}
      {when !== undefined ? <When iso={when} /> : <span />}
      {action !== undefined ? action : <span />}
    </>
  )
  if (!onOpen) return <div className={className}>{inner}</div>
  return (
    <button type="button" className={className} onClick={onOpen} aria-label={ariaLabel}>
      {inner}
    </button>
  )
}

/**
 * THE DRAWER — the reference's slide-in preview, and the one detail surface on
 * this workspace.
 *
 * Every screen's detail opens here rather than in a second grid track, so the
 * list behind it keeps its full width whether or not something is open. It owns
 * the keyboard while it is up (Escape closes, Tab cycles inside) because
 * `aria-modal` is a promise, and the scrim closes on a click that started on the
 * scrim itself — never on a drag that merely ended there.
 */
export function Drawer({ kicker, onClose, children }: { kicker: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const scrimDown = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('.preview-close')?.focus()
  }, [])

  const onTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !panel.current) return
    const focusable = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, select, input, [tabindex]:not([tabindex="-1"])')]
    if (!focusable.length) return
    const edge = event.shiftKey ? focusable[0]! : focusable[focusable.length - 1]!
    if (document.activeElement !== edge) return
    event.preventDefault()
    ;(event.shiftKey ? focusable[focusable.length - 1]! : focusable[0]!).focus()
  }

  return (
    <div
      className="preview-scrim"
      onMouseDown={(event) => { scrimDown.current = event.target === event.currentTarget }}
      onMouseUp={(event) => { if (scrimDown.current && event.target === event.currentTarget) onClose() }}
    >
      <div className="artifact-preview" ref={panel} role="dialog" aria-modal="true" aria-label={kicker} onKeyDown={onTab}>
        <div className="preview-toolbar">
          <button type="button" className="preview-back" onClick={onClose}>
            <Glyph name="back" />
            Back
          </button>
          <span>{kicker}</span>
          <button type="button" className="preview-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="preview-scroll">{children}</div>
      </div>
    </div>
  )
}

/** The drawer's document head: kicker, title, facet line, then the meta grid. */
export function DrawerHead({ kicker, title, facets, meta }: { kicker: string; title: string; facets?: ReactNode; meta?: [string, ReactNode][] }) {
  return (
    <>
      <p className="preview-kicker">{kicker}</p>
      <h1>{title}</h1>
      {facets && <div className="preview-facets">{facets}</div>}
      {meta && meta.length > 0 && (
        <dl className="preview-meta">
          {meta.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  )
}

export function DrawerSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="preview-section">
      <h2>{title}</h2>
      {note && <p className="ws-note-line">{note}</p>}
      {children}
    </section>
  )
}

export function StateChip({ state }: { state: string | null }) {
  if (!state) return <span className="state-label">no runs yet</span>
  const tone = state === 'ok' || state === 'success' ? 'state-ok' : state === 'failure' || state === 'failed' ? 'state-floor' : state === 'running' || state === 'queued' ? 'state-live' : ''
  return <span className={`state-label ${tone}`}>{state}</span>
}

/**
 * The three routes into the inbox, in the surface's temperature grammar: a
 * pending question is a DECISION YOU OWE (amber); due-unwatched and the orphan
 * floor are CONSEQUENCES THAT DID NOT HAPPEN — work nobody picked up (rose).
 */
const REASON_LABEL: Record<string, string> = { question: 'question', 'due-unwatched': 'due · unwatched', orphan: 'orphan floor' }
export const reasonTone = (reason: string): 'human' | 'floor' => (reason === 'question' ? 'human' : 'floor')
export const reasonLabel = (reason: string): string => REASON_LABEL[reason] ?? reason

/** A kernel refusal, shown the way the CLI shows one: the code, the sentence,
 *  then the hint — which is the half that tells you what to do next. */
export function Refusal({ error }: { error: Error }) {
  const refusal = error instanceof ViewError ? error : undefined
  return (
    <div className="ws-refusal" role="alert">
      <b>{refusal?.code ?? 'ERROR'}</b>
      <p>{error.message}</p>
      {refusal?.hint && <small>{refusal.hint}</small>}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="ws-empty">{children}</p>
}

export function Loading({ what }: { what: string }) {
  return <p className="ws-empty">Loading {what}…</p>
}

/** The centered full-screen state the reference uses when a whole view has
 *  nothing to show — a stopped API, or a workspace with no rows yet. */
export function BigState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ws-state">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  )
}

/** The event timeline. Ordered by `seq` — the content id dedups, the seq
 *  orders — and it renders the field-level `{old,new}` diffs verbatim, because
 *  the diff IS the audit record. */
export function Timeline({ events, emptyNote }: { events: EventShape[]; emptyNote?: string }) {
  if (!events.length) return <Empty>{emptyNote ?? 'No events yet.'}</Empty>
  return (
    <ol className="event-list">
      {events.map((event) => (
        <li key={event.id} className={`event-item entrance-${event.entrance}`}>
          <div className="event-head">
            <b>{event.kind}</b>
            <span className="event-entrance">{event.entrance}</span>
            <code className="ws-id">{event.actor}</code>
            <When iso={event.ts} />
            <span className="event-seq">seq {event.seq}</span>
          </div>
          {event.note && <p className="event-note">{event.note}</p>}
          {event.diff && Object.keys(event.diff).length > 0 && (
            <dl className="event-diff">
              {Object.entries(event.diff).map(([field, change]) => (
                <div key={field}>
                  <dt>{field}</dt>
                  <dd>
                    <del>{preview(change.old)}</del>
                    <ins>{preview(change.new)}</ins>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ol>
  )
}

export function RunStrip({ runs }: { runs: RunRow[] }) {
  if (!runs.length) return <Empty>No runs recorded for this loop yet.</Empty>
  return (
    <ul className="run-list">
      {runs.map((run) => (
        <li key={run.id} className="run-row">
          <StateChip state={run.state} />
          <div className="run-main">
            <h4>{run.summary ?? run.reason ?? run.scope}</h4>
            <p>
              <code className="ws-id">{run.id}</code> · {run.scope}
              {run.attempts > 1 ? ` · ${run.attempts} attempts` : ''}
            </p>
          </div>
          {run.costUsd != null ? <span className="run-cost">${run.costUsd.toFixed(2)}</span> : <span />}
          <When iso={run.finishedAt ?? run.startedAt} />
        </li>
      ))}
    </ul>
  )
}

function preview(value: unknown): string {
  if (value == null) return '∅'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 220 ? `${text.slice(0, 220)}…` : text
}
