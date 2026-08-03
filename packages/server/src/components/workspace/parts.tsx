import type { EventShape, RunRow } from './api'
import { ViewError } from './api'

/** Small shared pieces every pane uses: glyphs, time, state chips, the refusal
 *  panel, and the event timeline. Kept in one file so a chip means the same
 *  thing on the inbox, the task page and the loop page. */

const GLYPHS: Record<string, string> = {
  inbox: '◍', tasks: '▤', loops: '↻', docs: '□', system: '⌘',
  question: '?', due: '◷', orphan: '⊘', chevron: '›', run: '↻', doc: '□', event: '·',
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
  if (!iso) return <span className="ws-when">—</span>
  return (
    <time className="ws-when" dateTime={iso} title={new Date(iso).toLocaleString()}>
      {prefix ? `${prefix} ` : ''}
      {rel(iso)}
    </time>
  )
}

export function StateChip({ state }: { state: string | null }) {
  if (!state) return <span className="ws-chip ws-chip-idle">no runs yet</span>
  return <span className={`ws-chip ws-chip-${state}`}>{state}</span>
}

export function ReasonChips({ reasons }: { reasons: string[] }) {
  const label: Record<string, string> = { question: 'question', 'due-unwatched': 'due · unwatched', orphan: 'orphan floor' }
  return (
    <span className="ws-reasons">
      {reasons.map((reason) => (
        <span key={reason} className={`ws-chip ws-chip-reason ws-chip-${reason.split('-')[0]}`}>
          {label[reason] ?? reason}
        </span>
      ))}
    </span>
  )
}

/** A kernel refusal, shown the way the CLI shows one: the sentence, then the
 *  hint — which is the half that tells you what to do next. */
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

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="ws-empty">{children}</p>
}

export function Loading({ what }: { what: string }) {
  return <p className="ws-empty">Loading {what}…</p>
}

/** The event timeline. Ordered by `seq` — the content id dedups, the seq
 *  orders — and it renders the field-level `{old,new}` diffs verbatim, because
 *  the diff IS the audit record. */
export function Timeline({ events, emptyNote }: { events: EventShape[]; emptyNote?: string }) {
  if (!events.length) return <Empty>{emptyNote ?? 'No events yet.'}</Empty>
  return (
    <ol className="ws-timeline">
      {events.map((event) => (
        <li key={event.id} className={`ws-event ws-entrance-${event.entrance}`}>
          <div className="ws-event-head">
            <b>{event.kind}</b>
            <span className="ws-entrance">{event.entrance}</span>
            <code>{event.actor}</code>
            <When iso={event.ts} />
            <small className="ws-seq">seq {event.seq}</small>
          </div>
          {event.note && <p className="ws-event-note">{event.note}</p>}
          {event.diff && Object.keys(event.diff).length > 0 && (
            <dl className="ws-diff">
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
    <ul className="ws-runs">
      {runs.map((run) => (
        <li key={run.id} className={`ws-run ws-run-${run.state}`}>
          <StateChip state={run.state} />
          <code className="ws-id">{run.id}</code>
          <span className="ws-run-scope">{run.scope}</span>
          <span className="ws-run-reason">{run.reason ?? '—'}</span>
          <When iso={run.finishedAt ?? run.startedAt} />
          {run.costUsd != null && <span className="ws-cost">${run.costUsd.toFixed(2)}</span>}
          {run.summary && <p className="ws-run-summary">{run.summary}</p>}
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
