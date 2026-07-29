import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'

import {
  fetchLibrary,
  fetchSummary,
  fetchSystem,
  fetchTimeline,
  postVerdict,
  type LibraryArtifact,
  type LibraryView,
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

type ViewName = 'library' | 'system' | 'timeline'

const GLYPHS: Record<string, string> = {
  library: '▤',
  system: '⌘',
  timeline: '◷',
  pr: '⑂',
  post: '✎',
  report: '◫',
  doc: '□',
  observe: '⌁',
  run: '↻',
  artifact: '◇',
  decision: '✓',
  chevron: '›',
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
        <p>{artifact.source}</p>
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

function LibraryPane({
  library,
  highlighted,
  onVerdict,
  busyId,
}: {
  library: LibraryView
  highlighted: string[]
  onVerdict: (a: LibraryArtifact) => void
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

function Sidebar({ view, setView, summary }: { view: ViewName; setView: (v: ViewName) => void; summary: Summary | null }) {
  const items: { id: ViewName; label: string }[] = [
    { id: 'library', label: 'Library' },
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
            {item.id === 'library' && summary && <b>{summary.needsYou}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-status">
        <span />
        <div>
          <strong>{summary ? `${summary.loops} armed loop classes` : 'loading…'}</strong>
          <small>{summary ? `${summary.events} events · ${summary.pendingActions} pending actions` : ''}</small>
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
    if (requested === 'system' || requested === 'timeline') setView(requested)
  }, [])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [system, setSystem] = useState<SystemView | null>(null)
  const [library, setLibrary] = useState<LibraryView | null>(null)
  const [timeline, setTimeline] = useState<TimelineView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, sys, lib, tl] = await Promise.all([fetchSummary(), fetchSystem(), fetchLibrary(), fetchTimeline()])
      setSummary(s)
      setSystem(sys)
      setLibrary(lib)
      setTimeline(tl)
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
        setNotice(`${artifact.title} → ${result.status} (closed ${result.closed.join(', ') || 'nothing'}; event ${result.eventId})`)
      } else {
        setNotice(`refused: ${result.code} — ${result.message}`)
      }
      await refresh()
      setBusyId(null)
    },
    [refresh],
  )

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
              <LibraryPane library={library} highlighted={highlighted} onVerdict={onVerdict} busyId={busyId} />
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
