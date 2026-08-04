import { fetchDoc, fetchDocs, type DocRow } from './api'
import { Markdown, SandboxedHtml } from './Render'
import { ArtifactRow, BigState, Drawer, DrawerHead, DrawerSection, Empty, Loading, Refusal, Section, Timeline, ViewHeader, When } from './parts'
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
 *
 * UNIT 8: this is the screen closest to the reference's Library, so it takes that
 * shape most directly — a document column of grouped rows, and the doc itself
 * read in the slide-in drawer. The grouping is by the one distinction that
 * changes how a doc is RENDERED (`format`), not by an editorial category the
 * kernel does not have.
 */
export function DocsPane({ selected, onSelect, onOpenLoop }: { selected: string | null; onSelect: (id: string | null) => void; onOpenLoop: (id: string) => void }) {
  const { data, error, loading } = useLiveView('docs', fetchDocs, affectsDocs)

  if (error && !data) return <BigState title="The library is not answering">{error.message}</BigState>
  if (!data && !error) return <Loading what="the library" />

  const docs = data?.docs ?? []
  const markdown = docs.filter((doc) => doc.format !== 'html')
  const html = docs.filter((doc) => doc.format === 'html')

  return (
    <div className="document-view">
      <ViewHeader
        eyebrow="Docs"
        title="Docs"
        description="One artifact format for everything: YAML front matter plus a body. The database columns are projections of that front matter."
        meta={`${docs.length} doc${docs.length === 1 ? '' : 's'}`}
      />

      {docs.length === 0 && <Empty>No docs yet. Run reports land here as they are filed.</Empty>}

      {markdown.length > 0 && (
        <Section title="Markdown" count={markdown.length}>
          <div className="artifact-list">
            {markdown.map((doc) => (
              <DocListRow key={doc.id} doc={doc} selected={doc.id === selected} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      )}

      {html.length > 0 && (
        <Section title="HTML" count={html.length}>
          <p className="ws-note-line">Always read inside a sandboxed frame with an opaque origin — it can never reach your session.</p>
          <div className="artifact-list">
            {html.map((doc) => (
              <DocListRow key={doc.id} doc={doc} selected={doc.id === selected} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      )}

      {loading && data && <p className="ws-refreshing">refreshing…</p>}

      {selected && (
        <Drawer kicker="Doc" onClose={() => onSelect(null)}>
          <DocDetail id={selected} onOpenLoop={onOpenLoop} />
        </Drawer>
      )}
    </div>
  )
}

function DocListRow({ doc, selected, onSelect }: { doc: DocRow; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <ArtifactRow
      icon={doc.format === 'html' ? 'html' : 'doc'}
      iconTone={doc.format === 'html' ? 'html' : 'doc'}
      title={doc.title ?? doc.id}
      source={
        <>
          {doc.creator?.title ?? doc.createdByLoop ?? 'authored by you'} · {Math.max(1, Math.round(doc.bytes / 1024))} KB
        </>
      }
      state={doc.format}
      stateTone={doc.format === 'html' ? 'html' : 'live'}
      when={doc.updatedAt}
      action={<span className="artifact-action">open ›</span>}
      selected={selected}
      onOpen={() => onSelect(doc.id)}
      ariaLabel={`Open ${doc.title ?? doc.id}`}
    />
  )
}

function DocDetail({ id, onOpenLoop }: { id: string; onOpenLoop: (id: string) => void }) {
  const { data, error } = useLiveView(`doc:${id}`, () => fetchDoc(id), affectsObject(id))
  if (error && !data) {
    return (
      <div className="preview-document">
        <Refusal error={error} />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="preview-document">
        <Loading what="the doc" />
      </div>
    )
  }
  const { doc } = data

  return (
    <article className="preview-document">
      <DrawerHead
        kicker={doc.format === 'html' ? 'HTML doc' : 'Markdown doc'}
        title={doc.title ?? doc.id}
        facets={
          <>
            <span className={`state-label ${doc.format === 'html' ? 'state-html' : 'state-live'}`}>{doc.format}</span>
            <code className="ws-id">{doc.id}</code>
          </>
        }
        meta={[
          [
            'from',
            data.creator ? (
              <button type="button" className="ws-link" onClick={() => onOpenLoop(data.creator!.id)}>
                {data.creator.title ?? data.creator.id}
              </button>
            ) : (
              'you'
            ),
          ],
          ['run', doc.createdByRun ? <code className="ws-id">{doc.createdByRun}</code> : '—'],
          ['filed', <When iso={doc.createdAt} />],
          ['updated', <When iso={doc.updatedAt} />],
        ]}
      />

      {doc.format === 'html' ? (
        <SandboxedHtml html={doc.body} title={doc.title ?? doc.id} />
      ) : doc.body.trim() ? (
        <Markdown>{doc.body}</Markdown>
      ) : (
        <Empty>This doc has no body.</Empty>
      )}

      {Object.keys(doc.payload ?? {}).length > 0 && (
        <DrawerSection title="Payload">
          <pre className="ws-source">{JSON.stringify(doc.payload, null, 2)}</pre>
        </DrawerSection>
      )}

      <DrawerSection title="Timeline">
        <Timeline events={data.timeline} emptyNote="No events on this doc." />
      </DrawerSection>
    </article>
  )
}
