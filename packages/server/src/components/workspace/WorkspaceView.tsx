import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'

import {
  fetchAttention,
  fetchEffects,
  fetchWork,
  fetchInbox,
  fetchLibrary,
  fetchNotifications,
  fetchSchedule,
  fetchSummary,
  fetchSystem,
  fetchTimeline,
  postAttention,
  postGraphVerb,
  postNotificationsRead,
  postVerdict,
  type AttentionItem,
  type AttentionView,
  type GraphVerb,
  type EffectsView,
  type InboxItem,
  type InboxView,
  type LibraryArtifact,
  type LibraryView,
  type NotificationsView,
  type ScheduleRow,
  type ScheduleView,
  type Summary,
  type SystemView,
  type TimelineEntry,
  type TimelineView,
  type WorkRow,
  type WorkView,
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
 *    typed; it is `/api/graph/inbox` - THE open `human-verdict` obligations - and
 *    each row carries the exact transition that discharges it (resolved server-side
 *    from the object's EFFECTIVE type spec). It is deliberately NOT built by
 *    filtering the Library: the Library lists CONTENT, so a gate on an object with
 *    no Library row (a plain Task, which is exactly what a run's escalation
 *    produces) was counted by the badge and never rendered, and a person could owe
 *    a verdict the UI never showed them. The list and the count now read the same
 *    rows, so they cannot disagree.
 *  - the preview's body HTML is rendered server-side from the stored artifact
 *    file by `@loopany/artifact-format`, already sanitized. It is injected with
 *    `dangerouslySetInnerHTML` for the same reason the product's markdown
 *    pipeline does: the sanitizer is the boundary, and it ran before the bytes
 *    left the server.
 */

const SystemGraph = lazy(() => import('./SystemGraph'))

/** Mirrors `LIBRARY_SETTLED_CAP` in `graph/workspace/read.ts` - display copy only. */
const LIBRARY_SETTLED_SHOWN = 90

type ViewName = 'library' | 'system' | 'schedule' | 'timeline' | 'notifications'

const GLYPHS: Record<string, string> = {
  library: '▤',
  system: '⌘',
  timeline: '◷',
  schedule: '◴',
  notifications: '◍',
  clock: '◴',
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


/**
 * THE VERB BAR - the seven verbs, from a person's hands (captain decision 16).
 *
 * "UI buttons invoke the same verbs (plus the human verdict), no bespoke parallel
 * endpoints." So this panel does not post to a form handler that writes rows its
 * own way: it posts to `/api/graph/verb/*`, which calls the very functions the
 * `graph` CLI calls, with `entrance: "human"` instead of `agent-run`.
 *
 * The consequence worth having is in the Timeline: a task a person opened and a
 * task a run opened are the same shape with different provenance, so "who did
 * this?" is answered by one column rather than by guessing at which surface was
 * responsible.
 *
 * Deliberately three actions and not seven. `task move` is the verdict buttons
 * that already exist, `mirror track` and `wait open` are things a run does with
 * ids it holds, and a form for them would be a worse version of the CLI. What a
 * person genuinely does from here is: start a piece of work, ask for a verdict,
 * and answer a wait they are looking at.
 */
function VerbBar({ artifacts, onDone }: { artifacts: LibraryArtifact[]; onDone: () => void | Promise<void> }) {
  const [open, setOpen] = useState<'task' | 'review' | 'wait' | null>(null)
  const [title, setTitle] = useState('')
  const [evidence, setEvidence] = useState('')
  const [waitOn, setWaitOn] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  // Only rows actually holding an open wait can be answered - the list is derived
  // from the obligations, never from a flag.
  const waits = artifacts.filter((a) => a.watchKey)

  const send = async (verb: GraphVerb, body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const result = await postGraphVerb(verb, body)
      setSaid(
        result.ok
          ? result.summary
          : `${result.code}: ${result.message}${result.allowed?.length ? ` — you may: ${result.allowed.join(', ')}` : ''}`,
      )
      if (result.ok) {
        setTitle('')
        setEvidence('')
        setOpen(null)
        await onDone()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="verb-bar">
      <div className="section-heading">
        <div>
          <h2>Do something</h2>
        </div>
        <p>The same seven verbs your runs use — this time it is you calling them</p>
      </div>
      <div className="verb-actions">
        <button type="button" onClick={() => setOpen(open === 'task' ? null : 'task')}>
          + Task
        </button>
        <button type="button" onClick={() => setOpen(open === 'review' ? null : 'review')}>
          + Review
        </button>
        {waits.length > 0 && (
          <button type="button" onClick={() => setOpen(open === 'wait' ? null : 'wait')}>
            Answer a wait ({waits.length})
          </button>
        )}
      </div>

      {open === 'task' && (
        <div className="verb-form">
          <input
            value={title}
            placeholder="What needs doing?"
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Task title"
          />
          <button
            type="button"
            disabled={busy || !title.trim()}
            onClick={() => void send('task.create', { type: 'task', title: title.trim() })}
          >
            {busy ? 'Working…' : 'graph task create'}
          </button>
        </div>
      )}

      {open === 'review' && (
        <div className="verb-form">
          <input
            value={title}
            placeholder="What should somebody decide?"
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Review question"
          />
          <button
            type="button"
            disabled={busy || !title.trim()}
            onClick={() => void send('review.request', { question: title.trim(), preset: 'decision' })}
          >
            {busy ? 'Working…' : 'graph review request'}
          </button>
        </div>
      )}

      {open === 'wait' && (
        <div className="verb-form">
          <select value={waitOn} onChange={(e) => setWaitOn(e.target.value)} aria-label="Which wait">
            <option value="">Pick a wait…</option>
            {waits.map((a) => (
              <option key={`${a.id}:${a.watchKey}`} value={`${a.id}|${a.watchKey}`}>
                {a.title} — {a.watchQuestion ?? a.watching}
              </option>
            ))}
          </select>
          <input
            value={evidence}
            placeholder="What did you see? (the answer's evidence)"
            onChange={(e) => setEvidence(e.target.value)}
            aria-label="Evidence"
          />
          {(['met', 'not-met'] as const).map((answer) => (
            <button
              key={answer}
              type="button"
              disabled={busy || !waitOn || !evidence.trim()}
              onClick={() =>
                void send('wait.answer', {
                  objectId: waitOn.split('|')[0],
                  key: waitOn.split('|')[1],
                  met: answer === 'met',
                  evidence: evidence.trim(),
                })
              }
            >
              {answer === 'met' ? '--met' : '--not-met'}
            </button>
          ))}
        </div>
      )}

      {said && <p className="verb-said">{said}</p>}
    </section>
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

/**
 * AN INBOX ITEM WITH NO LIBRARY ROW - a verdict owed on something that is not
 * content.
 *
 * The minimal counterpart to `ArtifactRow`, and the reason "Needs you" can now be
 * complete. A gate lives on a TASK; most of today's tasks shepherd a doc or a PR
 * mirror, and those rows render the content. But nothing guarantees it - a run that
 * escalates its own findings, a probe's plain Task, any future type that owes a
 * verdict about something with no body - and for those the honest answer is a row of
 * their own rather than an absence.
 *
 * It says what it can and does not invent the rest: no preview (there is nothing to
 * preview) and no state chip pretending to be a document state - just what is owed,
 * on what, since when, and the button that discharges it.
 */
function InboxRow({
  item,
  onVerdict,
  busy,
}: {
  item: InboxItem
  onVerdict: (item: InboxItem) => void
  busy: boolean
}) {
  return (
    <article className="artifact-row needs-human is-mirror" id={`inbox-${item.objectId}-${item.key}`}>
      <span className="artifact-icon icon-doc">
        <Glyph name="decision" />
      </span>
      <div className="artifact-main">
        <h3>{item.title}</h3>
        <p>
          {item.source} · {item.type}
        </p>
      </div>
      <span className="state-label state-human">{item.label}</span>
      <time title={item.openedAt}>{relativeAge(item.openedAt)}</time>
      {item.verdict ? (
        <button className="verdict-button" disabled={busy} onClick={() => onVerdict(item)}>
          {busy ? 'Working…' : item.verdict.label}
        </button>
      ) : (
        // No declared transition closes this key from the object's current state.
        // Saying so is better than a dead button: the obligation is real, and the
        // spec is what has to change.
        <span className="artifact-action">No verdict declared</span>
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
  // Decision 14: a verification wait answered "met" and then answered again with
  // the thing back. Worded as the fact rather than as a failure - nothing broke,
  // something returned.
  'wait-recurrence': { one: 'it came back', many: 'came back' },
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

// ---- Work: the runs bridge ----

/**
 * WORK A PERSON IS BEING ASKED TO LET A MACHINE DO.
 *
 * The other half of "approve in the platform". Outward effects say what a verdict did
 * to the world; this says what the fleet wants to GO AND DO, and then what its run
 * actually did. Both exist for the same reason: a decision whose consequence you have
 * to go and look for somewhere else is a decision the workspace only pretended to make.
 *
 * The brief is shown VERBATIM. A person approving a run is approving an instruction an
 * agent will follow, so summarising it here would be the one place a summary is
 * actually dangerous.
 */
function WorkSection({ work, onVerdict, busyId }: { work: WorkView; onVerdict: (row: WorkRow) => void; busyId: string | null }) {
  if (!work.items.length) return null
  return (
    <section className="effects-section">
      <div className="section-heading">
        <div>
          <span className="effects-dot" />
          <h2>Work</h2>
          <span>{work.items.length}</span>
        </div>
        <p>
          {work.awaiting
            ? `${work.awaiting} waiting on your go-ahead — a machine agent runs these, not this server`
            : work.inFlight
              ? `${work.inFlight} dispatched and still running`
              : 'Every dispatched run has reported back'}
        </p>
      </div>
      <div className="effects-list">
        {work.items.map((row) => (
          <article className={`effect-row is-${workState(row)}`} key={row.id}>
            <span className="effect-icon">
              <Glyph name="run" />
            </span>
            <div className="effect-main">
              <h3>{row.title}</h3>
              <p title={row.brief ?? undefined}>{row.summary ?? row.brief ?? workPhrase(row)}</p>
            </div>
            <span className={`effect-state is-${workState(row)}`}>{row.status}</span>
            {row.verdict && (
              <button className="verdict-button" onClick={() => onVerdict(row)} disabled={busyId === row.id}>
                {busyId === row.id ? '…' : row.verdict.label}
              </button>
            )}
            <time>{row.age}</time>
          </article>
        ))}
      </div>
    </section>
  )
}

/** The row's visual state, borrowed from the effects row so the two read alike. */
function workState(row: WorkRow): string {
  if (row.verdict) return 'pending'
  if (row.runState === 'failure' || row.status === 'failed') return 'failed'
  if (row.runState === 'success' || row.status === 'done') return 'done'
  if (row.status === 'dispatched') return 'claimed'
  return 'pending'
}

/** What a row means when neither the run nor the brief has said anything yet. */
function workPhrase(row: WorkRow): string {
  if (row.status === 'dispatched') return 'dispatched — waiting for a machine agent to run it'
  if (row.status === 'declined') return 'you declined this run'
  return 'staged'
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
  inbox,
  attention,
  effects,
  work,
  highlighted,
  onVerdict,
  onInboxVerdict,
  onWorkVerdict,
  onResolveAttention,
  onRefresh,
  busyId,
}: {
  library: LibraryView
  inbox: InboxView | null
  attention: AttentionView | null
  effects: EffectsView | null
  work: WorkView | null
  highlighted: string[]
  onVerdict: (a: LibraryArtifact) => void
  onInboxVerdict: (item: InboxItem) => void
  onWorkVerdict: (row: WorkRow) => void
  onResolveAttention: (item: AttentionItem, verb: 'acknowledge' | 'retry') => void
  onRefresh: () => void | Promise<void>
  busyId: string | null
}) {
  const [preview, setPreview] = useState<LibraryArtifact | null>(null)
  // THE ACCOUNT, not the Library projection. Every open human-verdict obligation
  // gets a row: the CONTENT row when the gate's shepherd tracks something the
  // Library holds, and a minimal row of its own when it does not.
  const needsYou = inbox?.items ?? []
  const artifactById = new Map(library.artifacts.map((a) => [a.id, a]))
  const inRows = needsYou.map((item) => ({ item, artifact: item.reviews ? artifactById.get(item.reviews) : undefined }))
  // A category listing skips exactly what "Needs you" already rendered - derived
  // from the SAME rows, so an artifact can never be in both places or in neither.
  const shownAbove = new Set(inRows.map((r) => r.artifact?.id).filter(Boolean) as string[])
  const grouped = library.categories
    .map((category) => ({
      category,
      items: library.artifacts.filter((a) => a.category === category && !shownAbove.has(a.id)),
    }))
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
      <VerbBar artifacts={library.artifacts} onDone={onRefresh} />
      {attention && <AttentionSection attention={attention} onResolve={onResolveAttention} busyId={busyId} />}
      {work && <WorkSection work={work} onVerdict={onWorkVerdict} busyId={busyId} />}
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
          {inRows.map(({ item, artifact }) =>
            artifact ? (
              <ArtifactRow
                key={`${item.objectId}:${item.key}`}
                artifact={artifact}
                highlighted={highlightSet.has(artifact.id)}
                onOpen={setPreview}
                onVerdict={onVerdict}
                busy={busyId === artifact.id}
              />
            ) : (
              <InboxRow
                key={`${item.objectId}:${item.key}`}
                item={item}
                onVerdict={onInboxVerdict}
                busy={busyId === item.objectId}
              />
            ),
          )}
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

// ---- Schedule ----

/**
 * THE CLOCK, as a person can see it: every cadence in the workspace, what it fires,
 * and when it is next due.
 *
 * The one distinction this pane is built around is ARMED vs CONFIGURED. A cadence
 * is configuration; a cursor is what makes it live. This workspace replays real
 * production loops, cadences and all, and none of them fires here - so a row that
 * said "every day at 07:00" without saying it is not armed would be telling a
 * person about something that is not happening. `not armed` says it plainly.
 *
 * `overdue` is deliberately not styled as an error either: the scheduler ticks
 * faster than any legal cadence, so a cursor in the past means the clock is not
 * running - which is a fact about this server, and exactly what a person needs to
 * see instead of a green "scheduler: on" light.
 */
function SchedulePane({ schedule }: { schedule: ScheduleView }) {
  return (
    <div className="document-view">
      <ViewHeader
        eyebrow="Schedule"
        title="Schedule"
        description="Cadences as data. An armed schedule fires itself: a clock event, then whatever that transition dispatches — with nobody watching."
        meta={`${schedule.armed} armed · ${schedule.items.length} with a cadence${schedule.overdue ? ` · ${schedule.overdue} overdue` : ''}`}
      />
      {schedule.items.length === 0 ? (
        <p className="attn-empty" style={{ marginTop: 26 }}>
          Nothing carries a cadence yet. <code>pnpm graph:schedule</code> arms one.
        </p>
      ) : (
        <div className="effects-list" style={{ marginTop: 22 }}>
          {schedule.items.map((row) => (
            <article className={`effect-row is-${scheduleState(row)}`} key={row.objectId}>
              <span className="effect-icon">
                <Glyph name="schedule" />
              </span>
              <div className="effect-main">
                <h3>
                  {row.title} <em style={{ opacity: 0.6 }}>· {row.cadence}</em>
                </h3>
                <p>{schedulePhrase(row)}</p>
              </div>
              <span className={`effect-state is-${scheduleState(row)}`}>{row.armed ? 'armed' : 'not armed'}</span>
              <time title={row.nextFire ?? undefined}>{row.dueIn ? `in ${row.dueIn}` : (row.overdueBy ?? '—')}</time>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

/** Reuses the effects row's visual states, so the two panes read alike: a live
 *  cursor is `claimed` (something is happening), an overdue one `failed` (the clock
 *  is not running), a cadence with no cursor `pending` (configured, not live). */
function scheduleState(row: ScheduleRow): string {
  if (row.overdueBy !== undefined) return 'failed'
  if (row.armed) return 'claimed'
  return 'pending'
}

function schedulePhrase(row: ScheduleRow): string {
  const bits: string[] = []
  if (!row.armed) bits.push('configured, not armed on this server — the clock will not fire it')
  else if (row.overdueBy !== undefined) bits.push(`overdue by ${row.overdueBy} — is the scheduler running?`)
  else bits.push(`fires ${row.fireTransition ?? 'its clock transition'} next`)
  if (row.lastFiredAge) bits.push(`last fired ${row.lastFiredAge}`)
  if (row.fires) bits.push(`${row.fires} fire${row.fires === 1 ? '' : 's'} recorded`)
  if (row.misses) bits.push(`${row.misses} missed`)
  if (row.armed && !row.armedByEvent) bits.push('no arming approval — an outward fire would be refused')
  return bits.join(' · ')
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

/**
 * One line answering "is the clock running?".
 *
 * Same posture as `sensingPhrase`: it says what the rows say. The scheduler ticks
 * faster than any legal cadence, so an armed cursor sitting in the past means the
 * clock is stopped - and that is the one reading a "scheduler: on" indicator could
 * never give, because the indicator would be on either way.
 */
function clockPhrase(s: Summary['schedules']): string {
  const armed = `${s.armed} armed cadence${s.armed === 1 ? '' : 's'}`
  if (!s.overdue) return `${armed} · the clock is current`
  return `${armed} · ${s.overdue} overdue — is the scheduler running?`
}

function Sidebar({ view, setView, summary }: { view: ViewName; setView: (v: ViewName) => void; summary: Summary | null }) {
  const items: { id: ViewName; label: string }[] = [
    { id: 'library', label: 'Library' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'system', label: 'System' },
    { id: 'schedule', label: 'Schedule' },
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
          {/* THE CLOCK'S OWN VITAL SIGN, on the same footing as sensing's and for
              the same reason: an armed cadence that is not firing looks exactly
              like a quiet one. `overdue` is computed from the cursors themselves,
              so it cannot claim a clock the rows do not show. */}
          {summary && summary.schedules.armed > 0 && (
            <small className="sensing-line">{clockPhrase(summary.schedules)}</small>
          )}
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
    if (requested === 'system' || requested === 'timeline' || requested === 'notifications' || requested === 'schedule') {
      setView(requested)
    }
  }, [])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [system, setSystem] = useState<SystemView | null>(null)
  const [library, setLibrary] = useState<LibraryView | null>(null)
  const [inbox, setInbox] = useState<InboxView | null>(null)
  const [timeline, setTimeline] = useState<TimelineView | null>(null)
  const [attention, setAttention] = useState<AttentionView | null>(null)
  const [effects, setEffects] = useState<EffectsView | null>(null)
  const [work, setWork] = useState<WorkView | null>(null)
  const [schedule, setSchedule] = useState<ScheduleView | null>(null)
  const [notifications, setNotifications] = useState<NotificationsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, sys, lib, inb, tl, att, eff, wk, sch, notes] = await Promise.all([
        fetchSummary(),
        fetchSystem(),
        fetchLibrary(),
        fetchInbox(),
        fetchTimeline(),
        fetchAttention(),
        fetchEffects(),
        fetchWork(),
        fetchSchedule(),
        fetchNotifications(),
      ])
      setSummary(s)
      setSystem(sys)
      setLibrary(lib)
      setInbox(inb)
      setTimeline(tl)
      setAttention(att)
      setEffects(eff)
      setWork(wk)
      setSchedule(sch)
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

  /**
   * A verdict on an inbox item that has no Library row. The SAME write path as every
   * other verdict - `applyTransition` on the task that owes it - which is the point:
   * a row rendered from the inbox is not a second kind of decision, it is the same
   * decision on something the Library was never going to list.
   */
  const onInboxVerdict = useCallback(
    async (item: InboxItem) => {
      if (!item.verdict) return
      setBusyId(item.objectId)
      setNotice(null)
      const result = await postVerdict(item.objectId, item.verdict.transition)
      setNotice(
        result.ok
          ? `${item.title} → ${result.status} (closed ${result.closed.join(', ') || 'nothing'}; event ${result.eventId})`
          : `refused: ${result.code} — ${result.message}`,
      )
      await refresh()
      setBusyId(null)
    },
    [refresh],
  )

  /**
   * The go-ahead on a piece of WORK. Same write path as any other verdict - it runs
   * `approve` on the `agent-task` through `applyTransition` - but the consequence is
   * different in kind: the outbox writes a run work order, and the RUN itself happens on
   * a machine afterwards. So the notice says the dispatch was queued rather than
   * claiming the work is done; the row's own state is what reports the outcome, when the
   * agent reports it back.
   */
  const onWorkVerdict = useCallback(
    async (row: WorkRow) => {
      if (!row.verdict) return
      setBusyId(row.id)
      setNotice(null)
      const result = await postVerdict(row.verdict.objectId, row.verdict.transition)
      if (result.ok) {
        const queued = result.effects?.done ?? 0
        setNotice(
          `${row.title} → ${result.status}` +
            (queued
              ? ` · ${queued} work order${queued === 1 ? '' : 's'} queued — a machine agent runs it next`
              : ' (nothing queued)'),
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
                inbox={inbox}
                attention={attention}
                effects={effects}
                work={work}
                highlighted={highlighted}
                onVerdict={onVerdict}
                onInboxVerdict={onInboxVerdict}
                onWorkVerdict={onWorkVerdict}
                onResolveAttention={onResolveAttention}
                onRefresh={refresh}
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
            {view === 'schedule' && schedule && <SchedulePane schedule={schedule} />}
            {view === 'timeline' && timeline && <TimelinePane timeline={timeline} />}
          </>
        )}
      </main>
    </div>
  )
}
