import { fetchDoc, fetchDocs, type DocRow } from './api'
import { Markdown, SandboxedHtml } from './Render'
import { Empty, Loading, Refusal, Timeline, When } from './parts'
import { affectsDocs, affectsObject, useLiveView } from './useLiveView'

/**
 * THE DOC LIBRARY — content we author, plus every run report (a report IS a doc,
 * and reports were the first residents of this kind).
 *
 * The render path is chosen by `format`, and the two paths never mix:
 *  - `markdown` → client-side components, raw inline HTML not rendered;
 *  - `html`     → a sandboxed iframe with an opaque origin, and nothing else.
 *
 * `format: html` is a DOC-only narrow door. It is always sandbox-rendered and is
 * excluded from body diffs and global restyling — which is precisely why tasks
 * and loops don't get it: their bodies feed diffs, verdicts and prompts.
 */
export function DocsPane({ selected, onSelect, onOpenLoop }: { selected: string | null; onSelect: (id: string | null) => void; onOpenLoop: (id: string) => void }) {
  const { data, error, loading } = useLiveView('docs', fetchDocs, affectsDocs)
  return (
    <div className="ws-split">
      <div className="ws-pane ws-list-pane">
        <header className="ws-pane-head">
          <div>
            <h1>Docs</h1>
            <p>One artifact format for everything: YAML front matter plus a body. The database columns are projections of that front matter.</p>
          </div>
        </header>
        {error && !data ? <Refusal error={error} /> : null}
        {!data && !error ? <Loading what="the library" /> : null}
        {data && data.docs.length === 0 && <Empty>No docs yet. Run reports land here as they are filed.</Empty>}
        {data && (
          <ul className="ws-rows">
            {data.docs.map((doc) => (
              <DocListItem key={doc.id} doc={doc} selected={doc.id === selected} onSelect={onSelect} />
            ))}
          </ul>
        )}
        {loading && data && <p className="ws-refreshing">refreshing…</p>}
      </div>
      <div className="ws-pane ws-detail-pane">
        {selected ? <DocDetail id={selected} onOpenLoop={onOpenLoop} /> : <Empty>Select a doc to read it.</Empty>}
      </div>
    </div>
  )
}

function DocListItem({ doc, selected, onSelect }: { doc: DocRow; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={`ws-row ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(doc.id)}>
        <span className="ws-row-title">{doc.title ?? doc.id}</span>
        <span className="ws-row-meta">
          <span className={`ws-badge ws-badge-${doc.format}`}>{doc.format}</span>
          <span className="ws-row-watcher">{doc.creator?.title ?? (doc.createdByLoop ?? 'authored by you')}</span>
          <span className="ws-cost">{Math.max(1, Math.round(doc.bytes / 1024))} KB</span>
          <When iso={doc.updatedAt} />
        </span>
      </button>
    </li>
  )
}

function DocDetail({ id, onOpenLoop }: { id: string; onOpenLoop: (id: string) => void }) {
  const { data, error } = useLiveView(`doc:${id}`, () => fetchDoc(id), affectsObject(id))
  if (error && !data) return <Refusal error={error} />
  if (!data) return <Loading what="the doc" />
  const { doc } = data

  return (
    <article className="ws-detail">
      <header className="ws-detail-head">
        <h2>{doc.title ?? doc.id}</h2>
        <code className="ws-id">{doc.id}</code>
        <div className="ws-detail-facets">
          <span className={`ws-badge ws-badge-${doc.format}`}>{doc.format}</span>
          <span className="ws-facet">
            from{' '}
            {data.creator ? (
              <button type="button" className="ws-link" onClick={() => onOpenLoop(data.creator!.id)}>
                {data.creator.title ?? data.creator.id}
              </button>
            ) : (
              'you'
            )}
          </span>
          {doc.createdByRun && <code className="ws-id">{doc.createdByRun}</code>}
          <When iso={doc.updatedAt} prefix="updated" />
        </div>
      </header>

      {doc.format === 'html' ? (
        <SandboxedHtml html={doc.body} title={doc.title ?? doc.id} />
      ) : doc.body.trim() ? (
        <Markdown>{doc.body}</Markdown>
      ) : (
        <Empty>This doc has no body.</Empty>
      )}

      {Object.keys(doc.payload ?? {}).length > 0 && (
        <section>
          <h3>Payload</h3>
          <pre className="ws-source">{JSON.stringify(doc.payload, null, 2)}</pre>
        </section>
      )}

      <section>
        <h3>Timeline</h3>
        <Timeline events={data.timeline} emptyNote="No events on this doc." />
      </section>
    </article>
  )
}
