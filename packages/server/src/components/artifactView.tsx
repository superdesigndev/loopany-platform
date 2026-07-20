import { useEffect, useState } from 'react'
import type { ArtifactContent, ArtifactSummary } from '../types'
import { artifactKind, type ArtifactKind } from '../lib/artifactKind'
import { getArtifact } from '../server/loopApi'
import { downloadHref, inlineHref } from './ArtifactFileRow'
import { TaskFileView } from './TaskFileView'

/**
 * Shared pieces of the artifact content viewer - one source for the Files
 * panel's detail pane AND the dashboard artifact primitives (`<loop-embed>`,
 * `<loop-calendar>`'s and `<loop-kanban>`'s detail), so the caption strip, the
 * binary/oversize copy, and the type-appropriate render can't drift between
 * surfaces.
 *
 * Display types (see `lib/artifactKind`):
 *  - HTML   → a STRICT sandboxed iframe (`sandbox="allow-scripts"`, deliberately
 *             NO `allow-same-origin`): user-machine-synced markup renders richly
 *             but in an opaque origin, so its scripts can't read the app's
 *             cookies/session or reach `parent` - stored-XSS is contained by
 *             design. A Preview/Source toggle exposes the raw markup too.
 *  - image  → an <img> pointed at the hardened inline route (`inlineHref`); the
 *             bytes are NEVER inlined into the app DOM (SVG is scriptable, so it
 *             rides as an image, which does not execute embedded scripts).
 *  - markdown → the shared markdown pipeline (Preview) with a raw Source toggle.
 *  - text   → monospace source.
 * Everything keeps a Download fallback; an oversize (metadata-only) artifact has
 * no synced bytes to render, so it says so rather than showing an empty pane.
 */

export const isMarkdown = (path: string): boolean => artifactKind(path) === 'markdown'

/** A small monospace caption strip above a file's content (path · meta [· action]). */
export function ViewerHead({
  path,
  meta,
  action,
}: {
  path: string
  meta?: string
  action?: React.ReactNode
}) {
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline bg-surface px-5 py-2.5">
      <span className="break-all font-mono text-label text-primary">{path}</span>
      {meta && <span className="font-mono text-caption text-disabled">· {meta}</span>}
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  )
}

/** The binary / oversize body - download affordance or the metadata-only note. */
export function BinaryNotice({
  loopId,
  path,
  oversize,
}: {
  loopId: string
  path: string
  oversize: boolean
}) {
  return (
    <div className="px-5 py-8 text-body text-secondary">
      {oversize ? (
        <span className="text-disabled">Too large to preview - stored as metadata only (no synced bytes).</span>
      ) : (
        <>
          Binary file - not previewable.{' '}
          <a
            href={downloadHref(loopId, path)}
            download
            className="text-interactive underline underline-offset-2 transition-colors hover:text-display"
          >
            Download
          </a>
        </>
      )}
    </div>
  )
}

type ViewMode = 'preview' | 'source'

/** The viewer's action strip: a Preview/Source toggle (renderable types only)
 *  plus an always-present Download. Sits just under the content head. */
function ViewerActions({
  loopId,
  path,
  mode,
  onMode,
  showToggle,
}: {
  loopId: string
  path: string
  mode?: ViewMode
  onMode?: (m: ViewMode) => void
  showToggle: boolean
}) {
  return (
    <div className="flex items-center gap-2 border-b border-hairline bg-transparent px-5 py-1.5">
      {showToggle && mode && onMode && (
        <div className="inline-flex overflow-hidden rounded-control border border-hairline">
          {(['preview', 'source'] as ViewMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onMode(m)}
              className={`cursor-pointer border-none px-2.5 py-0.5 text-caption font-medium transition-colors ${
                mode === m ? 'bg-raised text-display' : 'bg-transparent text-secondary hover:text-display'
              }`}
            >
              {m === 'preview' ? 'Preview' : 'Source'}
            </button>
          ))}
        </div>
      )}
      <a
        href={downloadHref(loopId, path)}
        download
        className="ml-auto shrink-0 text-caption font-medium text-interactive underline underline-offset-2 transition-colors hover:text-display"
      >
        Download ↓
      </a>
    </div>
  )
}

/**
 * Rendered HTML in a STRICT sandbox. `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin` is the load-bearing isolation: the frame gets an opaque
 * origin, so document.cookie is empty, storage is inaccessible, and `parent`
 * access throws a cross-origin SecurityError - synced markup can render (styles
 * + its own scripts run) yet can't touch the app's session or DOM. `srcDoc`
 * keeps the bytes off any navigable app-origin URL. Bounded height with internal
 * scroll; a white backdrop matches what report HTML expects regardless of theme.
 */
function HtmlPreview({ html }: { html: string }) {
  return (
    <iframe
      title="Rendered HTML artifact (sandboxed)"
      srcDoc={html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="h-[min(70vh,620px)] w-full border-0 bg-white"
    />
  )
}

/** An image artifact, rendered from the hardened inline route (never inlined
 *  into the app DOM). Falls back to a download prompt if the bytes won't load. */
function ImageView({ loopId, file }: { loopId: string; file: ArtifactSummary }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="min-w-0">
      <ViewerActions loopId={loopId} path={file.path} showToggle={false} />
      {failed ? (
        <div className="px-5 py-8 text-body text-secondary">
          Couldn't load this image.{' '}
          <a
            href={downloadHref(loopId, file.path)}
            download
            className="text-interactive underline underline-offset-2 transition-colors hover:text-display"
          >
            Download
          </a>{' '}
          instead.
        </div>
      ) : (
        <div className="flex justify-center overflow-auto px-5 py-6">
          <img
            src={inlineHref(loopId, file.path)}
            alt={file.path}
            onError={() => setFailed(true)}
            className="max-w-full rounded-control border border-hairline bg-white object-contain"
          />
        </div>
      )}
    </div>
  )
}

type Loaded = ArtifactContent | { loading: true }

/** A text-bearing artifact (html / markdown / plain text): fetch the bytes, then
 *  render per its kind with a Preview/Source toggle (html + markdown) + download. */
function TextArtifactView({ loopId, file, kind }: { loopId: string; file: ArtifactSummary; kind: ArtifactKind }) {
  const [loaded, setLoaded] = useState<Loaded>({ loading: true })
  const [mode, setMode] = useState<ViewMode>('preview')

  useEffect(() => {
    let alive = true
    setLoaded({ loading: true })
    getArtifact({ data: { loopId, path: file.path } })
      .then((c) => alive && setLoaded(c))
      .catch((e) => alive && setLoaded({ error: String(e) }))
    return () => {
      alive = false
    }
  }, [loopId, file.path, file.updatedAt])

  if ('loading' in loaded) return <div className="px-5 py-6 text-body text-disabled">Loading…</div>
  // A pending/absent-blob text file (mid-sync) or an unexpected binary marker.
  if ('binary' in loaded) return <BinaryNotice loopId={loopId} path={file.path} oversize={loaded.oversize} />
  if ('error' in loaded) return <div className="px-5 py-6 text-body text-accent">Couldn't load this file - {loaded.error}</div>

  const text = loaded.text || '(empty file)'
  const renderable = kind === 'html' || kind === 'markdown'
  const showSource = !renderable || mode === 'source'

  return (
    <div className="min-w-0">
      <ViewerActions
        loopId={loopId}
        path={file.path}
        mode={mode}
        onMode={setMode}
        showToggle={renderable}
      />
      {kind === 'html' && !showSource ? (
        <HtmlPreview html={loaded.text || ''} />
      ) : kind === 'markdown' && !showSource ? (
        <TaskFileView content={text} />
      ) : (
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap px-5 py-4 font-mono text-label leading-relaxed text-secondary">
          {text}
        </pre>
      )}
    </div>
  )
}

/**
 * One artifact's content body, dispatched by display kind (see `artifactKind`).
 * Oversize → metadata-only note (no bytes); image → hardened <img>; other binary
 * → download; text-bearing → the fetch-and-render viewer.
 */
export function ArtifactBody({ loopId, file }: { loopId: string; file: ArtifactSummary }) {
  const kind = artifactKind(file.path)

  // Oversize is metadata-only regardless of type: no synced bytes to render.
  if (file.oversize) return <BinaryNotice loopId={loopId} path={file.path} oversize />
  // Images (incl. SVG) render via the inline route, never inlined into the DOM.
  // Key by path AND updatedAt so a new file resets the inner state (failed) and a
  // re-synced same-path image (no-store, unchanged src URL) remounts to refetch.
  if (kind === 'image')
    return <ImageView key={`${file.path}:${file.updatedAt ?? ''}`} loopId={loopId} file={file} />
  // A genuinely binary non-image (NUL bytes, no renderer) → download only.
  if (file.binary) return <BinaryNotice loopId={loopId} path={file.path} oversize={false} />
  // html / markdown / plain text.
  return <TextArtifactView key={file.path} loopId={loopId} file={file} kind={kind} />
}
