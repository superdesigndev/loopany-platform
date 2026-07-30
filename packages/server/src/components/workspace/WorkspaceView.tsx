import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'

import {
  fetchAttention,
  fetchEffects,
  fetchLibrary,
  fetchNotifications,
  fetchSummary,
  fetchSystem,
  fetchTimeline,
  postAttention,
  postNotificationsRead,
  postVerdict,
  type AttentionItem,
  type AttentionView,
  type EffectsView,
  type LibraryArtifact,
  type LibraryView,
  type NotificationsView,
  type Summary,
  type SystemView,
  type TimelineEntry,
  type TimelineView,
} from './api'

/**
 * The Graph Engineering v1 workspace — Library / System / Timeline over the real
 * kernel tables.
 *
 * Structurally the reference demo, with its static `data.ts` replaced by the
 * `/api/graph/*` projections. Two things follow from that swap and are worth
 * naming:
 *
 *  - the "Needs you" section is not a filter over a `needsHuman` flag someone
 *    typed; it is the open `human-verdict` obligations, and each row carries the
 *    exact transition that discharges it (resolved server-side from the object's
 *    EFFECTIVE type spec).
 *  - the preview's body HTML is rendered server-side from the stored artifact
 *    file by `@loopany/artifact-format`, already sanitized. It is injected with
 *    `dangerouslySetInnerHTML` for the same reason the product's markdown
 *    pipeline does: the sanitizer is the boundary, and it ran before the bytes
 *    left the server.
 */

const SystemGraph = lazy(() => import('./SystemGraph'))

/** Mirrors `LIBRARY_SETTLED_CAP` in `graph/workspace/read.ts` - display copy only. */
const LIBRARY_SETTLED_SHOWN = 90

type ViewName = 'library' | 'system' | 'timeline' | 'notifications'

const GLYPHS: Record<string, string> = {
  library: '▤',
  system: '⌘',
  timeline: '◷',
  notifications: '◍',
  pr: '⑂',
  post: '✎',
  report: '◫',
  doc: '□',
  observe: '⌁',
  run: '↻',
  artifact: '◇',
  decision: '✓',
  chevron: '›',
  'dead-letter': '⊘',
  'chain-parked': '⧗',
  'close-refused': '⊝',
  'directive-failed': '⤬',
  effects: '↗',
}

function Glyph({ name }: { name: string }) {
  return (
    <span className="glyph" aria-hidden="true">
      {GLYPHS[name] ?? '·'}
    </span>
  )
}

function ViewHeader({ eyebrow, title, description, meta }: { eyebrow: string; title: string; description: string; meta: string }) {
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
        <span className="view-meta">{meta}</span>
      </div>
    </header>
  )
}

// ---- Library ----

function ArtifactRow({
  artifact,
  highlighted,
  onOpen,
  onVerdict,
  busy,
}: {
  artifact: LibraryArtifact
  highlighted: boolean
  onOpen: (a: LibraryArtifact) => void
  onVerdict: (a: LibraryArtifact) => void
  busy: boolean
}) {
  const previewable = artifact.kind === 'document'
  return (
    <article
      id={`artifact-${artifact.id}`}
      className={[
        'artifact-row',
        artifact.needsHuman ? 'needs-human' : '',
        highlighted ? 'is-highlighted' : '',
        previewable ? 'is-previewable' : 'is-mirror',
      ]
        .filter(Boolean)
        .join(' ')}
      tabIndex={previewable ? 0 : undefined}
      role={previewable ? 'button' : undefined}
      aria-haspopup={previewable ? 'dialog' : undefined}
      onClick={() => previewable && onOpen(artifact)}
      onKeyDown={(event) => {
        if (!previewable || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onOpen(artifact)
      }}
    >
      <span className={`artifact-icon icon-${artifact.icon} ${artifact.kind === 'mirror' ? 'icon-mirror' : ''}`}>
        <Glyph name={artifact.icon} />
      </span>
      <div className="artifact-main">
        <h3>{artifact.title}</h3>
        <p>
          {artifact.source}
          {/* An open external wait, spelled out. Deliberately NOT styled as a
              verdict and given no button: nobody owes anything here, we are
              waiting on the outside world, and the mirror poller clears it from a
              real observation (design §12 item 5). */}
          {artifact.watching && <span className="artifact-watch"> · ⌁ {artifact.watching}</span>}
        </p>
      </div>
      <span className={`state-label ${artifact.needsHuman ? 'state-human' : ''}`}>{artifact.state}</span>
      <time>{artifact.age}</time>
      {artifact.verdict ? (
        <button
          className="verdict-button"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            onVerdict(artifact)
          }}
        >
          {busy ? 'Working…' : artifact.verdict.label}
        </button>
      ) : artifact.kind === 'mirror' && artifact.sourceUrl ? (
        <a
          className="artifact-action"
          href={artifact.sourceUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          {artifact.externalLabel} <span aria-hidden="true">↗</span>
        </a>
      ) : (
        <span className="artifact-action">
          {artifact.bodyAvailable ? 'Preview' : 'Details'} <Glyph name="chevron" />
        </span>
      )}
    </article>
  )
}

/** Say plainly how the thing on screen was produced. A real workspace holds
 *  v1-format artifacts, older front-matter-less Markdown, and data files - and
 *  the reader should not have to guess which one they are looking at. */
function previewKicker(artifact: LibraryArtifact): string {
  if (!artifact.bodyAvailable) return 'Front matter only · body not stored locally'
  if (artifact.renderMode === 'code') return 'Data file · rendered as source'
  if (artifact.renderMode === 'markdown') return 'Markdown · no front matter'
  return 'Artifact file · front matter + Markdown'
}

function ArtifactPreview({
  artifact,
  onClose,
  onVerdict,
  busy,
}: {
  artifact: LibraryArtifact
  onClose: () => void
  onVerdict: (a: LibraryArtifact) => void
  busy: boolean
}) {
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [onClose])

  return (
    <div
      className="preview-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <aside className="artifact-preview" role="dialog" aria-modal="true" aria-labelledby="ws-preview-title">
        <div className="preview-toolbar">
          <button className="preview-back" onClick={onClose} autoFocus>
            <span aria-hidden="true">←</span> Back to Library
          </button>
          <span>{previewKicker(artifact)}</span>
          <button className="preview-close" onClick={onClose} aria-label="Close preview">
            ×
          </button>
        </div>
        <div className="preview-scroll">
          <article className="preview-document">
            <div className="preview-icon">
              <Glyph name={artifact.icon} />
            </div>
            <p className="preview-kicker">{artifact.category}</p>
            <h1 id="ws-preview-title">{artifact.title}</h1>
            <dl className="preview-meta">
              <div>
                <dt>Produced by</dt>
                <dd>{artifact.source}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{artifact.state}</dd>
              </div>
              <div>
                <dt>Changed</dt>
                <dd>{artifact.age}</dd>
              </div>
            </dl>
            {artifact.verdict && (
              <div className="preview-verdict">
                <p>
                  A review task is holding an open <code>{artifact.verdict.obligation}</code> obligation on this
                  content. Running <code>{artifact.verdict.transition}</code> on that task closes it.
                </p>
                <button className="verdict-button" disabled={busy} onClick={() => onVerdict(artifact)}>
                  {busy ? 'Working…' : artifact.verdict.label}
                </button>
              </div>
            )}
            {artifact.bodyAvailable ? (
              /* Sanitized by @loopany/artifact-format before it left the server. */
              <div className="preview-body" dangerouslySetInnerHTML={{ __html: artifact.html ?? '' }} />
            ) : (
              <div className="preview-body preview-nobody">
                <p>
                  No local body for this artifact: {artifact.bodyAbsentReason ?? 'its bytes are not in the local cache'}.
                  Its front matter is below.
                </p>
                <dl>
                  {artifact.path && (
                    <>
                      <dt>Path</dt>
                      <dd><code>{artifact.path}</code></dd>
                    </>
                  )}
                  {artifact.originalType && (
                    <>
                      <dt>Front-matter type</dt>
                      <dd><code>{artifact.originalType}</code></dd>
                    </>
                  )}
                </dl>
              </div>
            )}
          </article>
        </div>
      </aside>
    </div>
  )
}

// ---- Attention ----

/**
 * The ATTENTION section: consequences that did not happen.
 *
 * It sits ABOVE "Needs you" and reads in a different temperature (muted rose vs
 * warm amber) because it is a different ask. A verdict queue is ordinary work; a
 * dead-lettered action is a promise the system failed to keep, and burying it
 * among approvals would be the exact failure the outbox exists to prevent.
 *
 * Every row is COMPUTED - from a dead-lettered outbox row, a parked chain event or
 * a refused close - so nothing here can be dismissed by clearing a flag. The two
 * buttons write human-entrance events instead: "Acknowledge" records that a person
 * accepts this is not happening, and "Retry" re-queues the action WITHOUT
 * acknowledging it, so a second failure comes straight back to this list.
 */
/**
 * Compact relative age, so an attention row reads like a Library row ("3h ago")
 * instead of a raw timestamp. Computed against the real clock, NOT the workspace's
 * seeded "now": these rows are things that just went wrong, and their age is a
 * fact about the present. The exact instant stays available as a `title`.
 */
function relativeAge(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(min)) return '—'
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

const ATTENTION_LABEL: Record<AttentionItem['kind'], { one: string; many: string }> = {
  'dead-letter': { one: 'effect never landed', many: 'effects never landed' },
  'chain-parked': { one: 'parked rule chain', many: 'parked rule chains' },
  'close-refused': { one: 'refused close', many: 'refused closes' },
  'directive-failed': { one: 'outward effect refused', many: 'outward effects refused' },
}

function AttentionSection({
  attention,
  onResolve,
  busyId,
}: {
  attention: AttentionView
  onResolve: (item: AttentionItem, verb: 'acknowledge' | 'retry') => void
  busyId: string | null
}) {
  if (!attention.items.length) return null
  const summary = (Object.keys(attention.counts) as AttentionItem['kind'][])
    .filter((k) => attention.counts[k] > 0)
    .map((k) => `${attention.counts[k]} ${attention.counts[k] === 1 ? ATTENTION_LABEL[k].one : ATTENTION_LABEL[k].many}`)
    .join(' · ')

  return (
    <section className="attention-section">
      <div className="section-heading">
        <div>
          <span className="attn-dot" />
          <h2>Attention</h2>
          <span>{attention.items.length}</span>
        </div>
        <p>{summary}</p>
      </div>
      <div className="attn-list">
        {attention.items.map((item) => (
          <article className="attn-row" key={item.id}>
            <span className="attn-icon">
              <Glyph name={item.kind} />
            </span>
            <div className="attn-main">
              <h3>{item.title}</h3>
              <p title={item.detail}>
                {item.subject ? `${item.subject} — ` : ''}
                {item.detail}
              </p>
            </div>
            <span className="attn-reason">{item.reason}</span>
            <time title={item.raisedAt}>{relativeAge(item.raisedAt)}</time>
            <div className="attn-actions">
              {item.retryable && (
                <button className="attn-button" disabled={busyId === item.id} onClick={() => onResolve(item, 'retry')}>
                  {busyId === item.id ? 'Working…' : `Retry (${item.attempts ?? 0} tried)`}
                </button>
              )}
              <button
                className="attn-button is-quiet"
                disabled={busyId === item.id}
                onClick={() => onResolve(item, 'acknowledge')}
              >
                Acknowledge
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

// ---- Outward effects ----

/**
 * WHAT YOUR VERDICTS DID TO THE OUTSIDE WORLD.
 *
 * A notification says a decision was recorded. This says whether it LANDED - and
 * they are not the same claim. The server holds no GitHub credentials, so
 * approving a merge review writes a work order and stops; a machine agent claims
 * it, acts with local credentials, and reports back. Every stage of that is a row
 * here, which is the difference between "we told somebody" and "it happened".
 *
 * `pending` reads as waiting, not as broken: an agent that is not running yet is
 * an ordinary state, and the alarm for one that never runs is the lease expiring
 * into Attention - not this list going red.
 */
function EffectsSection({ effects }: { effects: EffectsView }) {
  if (!effects.items.length) return null
  return (
    <section className="effects-section">
      <div className="section-heading">
        <div>
          <span className="effects-dot" />
          <h2>Outward effects</h2>
          <span>{effects.items.length}</span>
        </div>
        <p>
          {effects.unsettled
            ? `${effects.unsettled} on the way out — a machine agent executes these, not this server`
            : 'Everything your verdicts asked for has been settled'}
        </p>
      </div>
      <div className="effects-list">
        {effects.items.map((e) => (
          <article className={`effect-row is-${e.state}`} key={e.id}>
            <span className="effect-icon">
              <Glyph name="effects" />
            </span>
            <div className="effect-main">
              <h3>
                {e.kind} · {e.target}
              </h3>
              <p title={e.detail ?? undefined}>{e.detail ?? statePhrase(e.state)}</p>
            </div>
            {e.reason && <span className="attn-reason">{e.reason}</span>}
            <span className={`effect-state is-${e.state}`}>{e.state}</span>
            {e.resultUrl && (
              <a className="effect-link" href={e.resultUrl} target="_blank" rel="noreferrer">
                View
              </a>
            )}
            <time title={e.createdAt}>{e.age}</time>
          </article>
        ))}
      </div>
    </section>
  )
}

/** What a state means when the row carries no detail of its own. */
function statePhrase(state: string): string {
  if (state === 'pending') return 'queued — waiting for an effect agent to claim it'
  if (state === 'claimed') return 'an agent is executing this right now'
  if (state === 'done') return 'landed'
  return 'did not land'
}

// ---- Notifications ----

/**
 * What the `notify` action produced. This pane is the proof the executor works
 * from a person's side: approve a gate in the Library and a row appears here,
 * because the verdict enqueued an action and the executor delivered it.
 *
 * Not the Timeline. The Timeline is every event the kernel wrote; this is the
 * short list that was ADDRESSED to a human.
 */
function NotificationsPane({
  notifications,
  onMarkRead,
  busy,
}: {
  notifications: NotificationsView
  onMarkRead: () => void
  busy: boolean
}) {
  return (
    <div className="document-view">
      <ViewHeader
        eyebrow="Notifications"
        title="Notifications"
        description="What your decisions caused. Each row was written by a notify action the outbox executor delivered."
        meta={`${notifications.items.length} total · ${notifications.unread} unread`}
      />
      {notifications.items.length === 0 ? (
        <p className="attn-empty" style={{ marginTop: 26 }}>
          Nothing yet. Approve something in the Library and its notify action lands here.
        </p>
      ) : (
        <>
          <div className="notif-toolbar">
            <button className="attn-button is-quiet" disabled={busy || notifications.unread === 0} onClick={onMarkRead}>
              {busy ? 'Working…' : 'Mark all read'}
            </button>
          </div>
          <div className="notif-list">
            {notifications.items.map((n) => (
              <article className={`notif-row ${n.read ? '' : 'is-unread'}`} key={n.id}>
                <span className="notif-icon">
                  <Glyph name="notifications" />
                </span>
                <div className="notif-main">
                  <h3>{n.title}</h3>
                  <p>{n.body ?? '—'}</p>
                </div>
                <span className="notif-channel">{n.channel}</span>
                <time>{n.age}</time>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---- Library ----

function LibraryPane({
  library,
  attention,
  effects,
  highlighted,
  onVerdict,
  onResolveAttention,
  busyId,
}: {
  library: LibraryView
  attention: AttentionView | null
  effects: EffectsView | null
  highlighted: string[]
  onVerdict: (a: LibraryArtifact) => void
  onResolveAttention: (item: AttentionItem, verb: 'acknowledge' | 'retry') => void
  busyId: string | null
}) {
  const [preview, setPreview] = useState<LibraryArtifact | null>(null)
  const needsYou = library.artifacts.filter((a) => a.needsHuman)
  const grouped = library.categories
    .map((category) => ({ category, items: library.artifacts.filter((a) => a.category === category && !a.needsHuman) }))
    .filter((g) => g.items.length)

  useEffect(() => {
    const first = highlighted[0]
    if (!first) return
    window.setTimeout(() => document.getElementById(`artifact-${first}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80)
  }, [highlighted])

  // Keep the open preview in sync after a verdict lands (state + buttons change).
  useEffect(() => {
    if (!preview) return
    const fresh = library.artifacts.find((a) => a.id === preview.id)
    if (fresh && fresh !== preview) setPreview(fresh)
  }, [library, preview])

  const highlightSet = new Set(highlighted)

  return (
    <div className="document-view library-view">
      <ViewHeader
        eyebrow="Library"
        title="Library"
        description="Everything your loops have made, collected in one quiet place."
        meta={
          library.truncated
            ? `${library.artifacts.length} of ${library.total} artifacts`
            : `${library.total} artifacts`
        }
      />
      {attention && <AttentionSection attention={attention} onResolve={onResolveAttention} busyId={busyId} />}
      {effects && <EffectsSection effects={effects} />}
      <section className="needs-section">
        <div className="section-heading">
          <div>
            <span className="attention-dot" />
            <h2>Needs you</h2>
            <span>{needsYou.length}</span>
          </div>
          <p>Open human-verdict obligations</p>
        </div>
        <div className="artifact-list attention-list">
          {needsYou.length === 0 && <p style={{ padding: '10px 4px 16px', color: '#94866a', fontSize: '.8125rem' }}>Nothing is waiting on you.</p>}
          {needsYou.map((a) => (
            <ArtifactRow
              key={a.id}
              artifact={a}
              highlighted={highlightSet.has(a.id)}
              onOpen={setPreview}
              onVerdict={onVerdict}
              busy={busyId === a.id}
            />
          ))}
        </div>
      </section>
      {library.truncated > 0 && (
        <p className="library-truncation">
          Showing the {LIBRARY_SETTLED_SHOWN} most recent settled artifacts; {library.truncated} older ones are in the
          workspace but not on this page. Everything waiting on a human is always shown.
        </p>
      )}
      {grouped.map(({ category, items }) => (
        <section className="library-group" key={category}>
          <div className="section-heading">
            <div>
              <h2>{category}</h2>
              <span>{items.length}</span>
            </div>
          </div>
          <div className="artifact-list">
            {items.map((a) => (
              <ArtifactRow
                key={a.id}
                artifact={a}
                highlighted={highlightSet.has(a.id)}
                onOpen={setPreview}
                onVerdict={onVerdict}
                busy={busyId === a.id}
              />
            ))}
          </div>
        </section>
      ))}
      {preview && <ArtifactPreview artifact={preview} onClose={() => setPreview(null)} onVerdict={onVerdict} busy={busyId === preview.id} />}
    </div>
  )
}

// ---- Timeline ----

function dayLabel(dateKey: string, newestDate: string): string {
  const day = Math.round((new Date(`${newestDate}T12:00:00`).getTime() - new Date(`${dateKey}T12:00:00`).getTime()) / 86_400_000)
  if (day === 0) return 'Today'
  if (day === 1) return 'Yesterday'
  return new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${dateKey}T12:00:00`))
}

function TimelinePane({ timeline }: { timeline: TimelineView }) {
  const days = useMemo(() => {
    const ordered = [...timeline.events].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    const groups = new Map<string, TimelineEntry[]>()
    for (const e of ordered) {
      const key = e.ts.slice(0, 10)
      groups.set(key, [...(groups.get(key) ?? []), e])
    }
    return [...groups.entries()]
  }, [timeline.events])

  const newestDate = days[0]?.[0] ?? new Date().toISOString().slice(0, 10)

  return (
    <div className="document-view timeline-view">
      <ViewHeader
        eyebrow="Timeline"
        title="Timeline"
        description="The append-only event log: every state change with its provenance."
        meta={`${timeline.events.length} of ${timeline.total} events`}
      />
      <div className="timeline-feed">
        {days.map(([date, dayEvents]) => (
          <section className="timeline-day" key={date}>
            <div className="day-label">
              <h2>{dayLabel(date, newestDate)}</h2>
              <time>{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00`))}</time>
            </div>
            <div className="day-events">
              {dayEvents.map((e) => (
                <article className="timeline-event" key={e.id}>
                  <time>{new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(e.ts))}</time>
                  <span className={`event-icon event-${e.kind}`}>
                    <Glyph name={e.kind} />
                  </span>
                  <p>
                    <strong>{e.actor}</strong> {e.message} <em>· {e.entrance} · {e.actorId}</em>
                  </p>
                  <span className="pipeline-mark">{e.band}</span>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

// ---- shell ----

/**
 * One line answering "is the world still being watched?".
 *
 * Deliberately not alarmist and deliberately not reassuring: it says what the rows
 * say. No mirrors is a clean "nothing to sense"; never observed means the agent has
 * not run yet, which on a fresh workspace is ordinary; stale means it ran once and
 * stopped, which is the case worth noticing and the one a "poller: on" indicator
 * would have hidden.
 */
function sensingPhrase(s: Summary['sensing']): string {
  if (!s.mirrors) return 'sensing: nothing to watch yet'
  if (!s.lastObservedAt) return `sensing: ${s.mirrors} mirror${s.mirrors === 1 ? '' : 's'} never observed — is the machine agent running?`
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(s.lastObservedAt)) / 60_000))
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
  const stale = s.stale ? ` · ${s.stale} stale` : ''
  const unobserved = s.unobserved ? ` · ${s.unobserved} never observed` : ''
  return `sensed by the machine agent ${ago}${stale}${unobserved}`
}

function Sidebar({ view, setView, summary }: { view: ViewName; setView: (v: ViewName) => void; summary: Summary | null }) {
  const items: { id: ViewName; label: string }[] = [
    { id: 'library', label: 'Library' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'system', label: 'System' },
    { id: 'timeline', label: 'Timeline' },
  ]
  return (
    <aside className="sidebar">
      <div className="workspace-brand">
        <div className="loop-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <strong>Loopany</strong>
          <small>Graph v1 demo workspace</small>
        </div>
      </div>
      <nav aria-label="Workspace">
        {items.map((item) => (
          <button
            key={item.id}
            className={view === item.id ? 'is-active' : ''}
            aria-current={view === item.id ? 'page' : undefined}
            onClick={() => setView(item.id)}
          >
            <Glyph name={item.id} />
            <span>{item.label}</span>
            {item.id === 'library' && summary && <b>{summary.needsYou + summary.attention}</b>}
            {item.id === 'notifications' && summary && summary.unreadNotifications > 0 && (
              <b>{summary.unreadNotifications}</b>
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-status">
        <span />
        <div>
          <strong>{summary ? `${summary.loops} armed loop classes` : 'loading…'}</strong>
          {/* The queue depth is the executor's own vital sign: `pending` is work
              it will do, `attention` is work it CANNOT do without a person. The
              mirror line is the POLLER's: how many external facts we keep fresh,
              and how many waits the world still owes us. Both move with nobody
              watching, which is the whole point of live ingestion. */}
          <small>
            {summary
              ? `${summary.events} events · ${summary.pendingActions} queued${summary.attention ? ` · ${summary.attention} need attention` : ''}`
              : ''}
          </small>
          {summary && summary.mirrors > 0 && (
            <small>
              {summary.mirrors} mirror{summary.mirrors === 1 ? '' : 's'} watched
              {summary.watching ? ` · ${summary.watching} waiting on GitHub` : ''}
            </small>
          )}
          {/* SENSING FRESHNESS. This server holds no GitHub transport at all
              (captain decision 10) - a machine agent reads the world with its own
              credentials and reports back. So the honest vital sign is not "the
              poller is running", it is WHEN THE ROWS WERE LAST OBSERVED, computed
              from the observation stamps themselves. Without this line an agent
              that stopped would be indistinguishable from a quiet week on GitHub. */}
          {summary && <small className="sensing-line">{sensingPhrase(summary.sensing)}</small>}
        </div>
      </div>
    </aside>
  )
}

export function WorkspaceView() {
  // `?view=` is applied AFTER mount, never during render: the server has no
  // query string, so reading it in a state initializer hydrates a different
  // sidebar than it rendered (React drops the mismatch instead of patching it).
  const [view, setView] = useState<ViewName>('library')
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('view')
    if (requested === 'system' || requested === 'timeline' || requested === 'notifications') setView(requested)
  }, [])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [system, setSystem] = useState<SystemView | null>(null)
  const [library, setLibrary] = useState<LibraryView | null>(null)
  const [timeline, setTimeline] = useState<TimelineView | null>(null)
  const [attention, setAttention] = useState<AttentionView | null>(null)
  const [effects, setEffects] = useState<EffectsView | null>(null)
  const [notifications, setNotifications] = useState<NotificationsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, sys, lib, tl, att, eff, notes] = await Promise.all([
        fetchSummary(),
        fetchSystem(),
        fetchLibrary(),
        fetchTimeline(),
        fetchAttention(),
        fetchEffects(),
        fetchNotifications(),
      ])
      setSummary(s)
      setSystem(sys)
      setLibrary(lib)
      setTimeline(tl)
      setAttention(att)
      setEffects(eff)
      setNotifications(notes)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * The write path. A refusal is shown verbatim — the engine's typed code, not a
   * client-side guess — and nothing is optimistically re-rendered: the views
   * reload from the database so what you see is what committed.
   */
  const onVerdict = useCallback(
    async (artifact: LibraryArtifact) => {
      if (!artifact.verdict) return
      setBusyId(artifact.id)
      setNotice(null)
      // The verdict moves the SHEPHERD task, never the content itself.
      const result = await postVerdict(artifact.verdict.objectId, artifact.verdict.transition)
      if (result.ok) {
        // Say what it CAUSED, not just what it recorded. The effects count comes
        // from the outbox pass the verdict ran with, so "1 effect delivered" is a
        // fact about rows, not an optimistic claim.
        const effects = result.effects
          ? ` · ${result.effects.done} effect${result.effects.done === 1 ? '' : 's'} delivered${result.effects.deadLettered ? `, ${result.effects.deadLettered} needing attention` : ''}`
          : ''
        setNotice(
          `${artifact.title} → ${result.status} (closed ${result.closed.join(', ') || 'nothing'}; event ${result.eventId})${effects}`,
        )
      } else {
        setNotice(`refused: ${result.code} — ${result.message}`)
      }
      await refresh()
      setBusyId(null)
    },
    [refresh],
  )

  /** Resolve an attention item. Same posture as a verdict: the server decides, the
   *  notice quotes it, and the views reload from the database afterwards. */
  const onResolveAttention = useCallback(
    async (item: AttentionItem, verb: 'acknowledge' | 'retry') => {
      setBusyId(item.id)
      setNotice(null)
      const result = await postAttention(item, verb)
      setNotice(result.ok ? `${verb}: ${result.detail}` : `refused: ${result.code} — ${result.message}`)
      await refresh()
      setBusyId(null)
    },
    [refresh],
  )

  const onMarkNotificationsRead = useCallback(async () => {
    setBusyId('notifications')
    const result = await postNotificationsRead()
    setNotice(`marked ${result.marked} notification${result.marked === 1 ? '' : 's'} read`)
    await refresh()
    setBusyId(null)
  }, [refresh])

  const openArtifacts = useCallback((ids: string[]) => {
    setHighlighted(ids)
    setView('library')
  }, [])

  const empty = library && library.artifacts.length === 0 && (!system || system.nodes.length <= 2)

  return (
    <div className="loopany-workspace">
      <a className="skip-link" href="#ws-main">
        Skip to content
      </a>
      <Sidebar
        view={view}
        setView={(next) => {
          setView(next)
          if (next !== 'library') setHighlighted([])
        }}
        summary={summary}
      />
      <main id="ws-main" className="main-content">
        {error && (
          <div className="ws-state">
            <h2>The workspace API is not answering</h2>
            <p>
              {error}. The demo route is dev-only — start the server with <code>pnpm graph:demo</code>.
            </p>
          </div>
        )}
        {!error && empty && (
          <div className="ws-state">
            <h2>No graph data yet</h2>
            <p>
              The kernel tables are empty for this workspace. Seed them with <code>pnpm graph:seed</code>, then reload.
            </p>
          </div>
        )}
        {!error && !empty && (
          <>
            {notice && (
              <div style={{ padding: '10px 34px 0', color: '#7d6b45', fontSize: '.8125rem' }} role="status">
                {notice}
              </div>
            )}
            {view === 'library' && library && (
              <LibraryPane
                library={library}
                attention={attention}
                effects={effects}
                highlighted={highlighted}
                onVerdict={onVerdict}
                onResolveAttention={onResolveAttention}
                busyId={busyId}
              />
            )}
            {view === 'notifications' && notifications && (
              <NotificationsPane
                notifications={notifications}
                onMarkRead={onMarkNotificationsRead}
                busy={busyId === 'notifications'}
              />
            )}
            {view === 'system' && system && (
              <div className="system-view">
                <ViewHeader
                  eyebrow="System"
                  title="System"
                  description="The living structure behind your loops. Every node is a reusable class."
                  meta={`${system.nodes.length} classes`}
                />
                <div className="system-note">
                  <span>Class view</span> Gate nodes are computed from open obligations. Select one to open what it is holding.
                </div>
                <Suspense fallback={<div className="graph-panel" />}>
                  <SystemGraph view={system} onOpenArtifacts={openArtifacts} />
                </Suspense>
              </div>
            )}
            {view === 'timeline' && timeline && <TimelinePane timeline={timeline} />}
          </>
        )}
      </main>
    </div>
  )
}
