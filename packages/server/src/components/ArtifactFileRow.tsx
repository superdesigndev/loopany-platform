import { useState } from 'react'
import type { ArtifactContent, ArtifactSummary } from '../types'
import { fmt, humanBytes } from '../lib/format'
import { getArtifact } from '../server/loopApi'

/** Human byte size - "1.8 KB", "3.4 MB" ("" when unknown). */
export function fmtBytes(n: number | null): string {
  return n == null ? '' : humanBytes(n)
}

/** Download URL for one artifact - the path is segment-encoded so a nested path
 *  (`data/raw.json`) round-trips and can't be mistaken for extra route segments. */
export function downloadHref(loopId: string, path: string): string {
  const enc = path
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `/api/artifact/${encodeURIComponent(loopId)}/${enc}`
}

/** Inline render URL for an image artifact - the same bytes as `downloadHref`
 *  but served with the real image content-type + `inline` disposition (see the
 *  route). Used as an <img> src; never for a document the browser navigates to. */
export function inlineHref(loopId: string, path: string): string {
  return `${downloadHref(loopId, path)}?view=inline`
}

type Loaded = ArtifactContent | { loading: true }

/**
 * One artifact row, shared by the loop "Files" view (Phase 2) and the run-detail
 * recorded-files list (historical runs with no snapshot). A text file expands its
 * content inline (lazy `getArtifact`), a binary/oversize file is a download link.
 * Owns its own expand+fetch state so it can be dropped into either list.
 */
export function ArtifactFileRow({ loopId, file }: { loopId: string; file: ArtifactSummary }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const downloadable = file.binary && !file.oversize

  async function toggle() {
    // Binary/oversize are download-only - no inline expand.
    if (file.binary || file.oversize) return
    if (loaded) {
      setLoaded(null)
      return
    }
    setLoaded({ loading: true })
    try {
      setLoaded(await getArtifact({ data: { loopId, path: file.path } }))
    } catch (e) {
      setLoaded({ error: String(e) })
    }
  }

  return (
    <li className="text-meta">
      <div className="flex items-baseline gap-2">
        {downloadable ? (
          <a
            href={downloadHref(loopId, file.path)}
            download
            className="break-all font-mono text-interactive underline underline-offset-2 transition-colors hover:text-display"
          >
            {file.path}
          </a>
        ) : file.oversize ? (
          <span className="break-all font-mono text-primary">{file.path}</span>
        ) : (
          <button
            type="button"
            onClick={() => void toggle()}
            className="cursor-pointer break-all border-none bg-transparent p-0 text-left font-mono text-primary underline-offset-2 transition-colors hover:text-display hover:underline"
          >
            {file.path}
          </button>
        )}
        <span className="shrink-0 font-mono text-micro text-disabled">{fmtBytes(file.size)}</span>
        {file.oversize && (
          <span className="shrink-0 text-micro font-medium text-secondary">too large · metadata only</span>
        )}
        {downloadable && <span className="shrink-0 text-micro font-medium text-secondary">download</span>}
        <span className="ml-auto shrink-0 font-mono text-micro text-disabled">{fmt(file.updatedAt)}</span>
      </div>
      {loaded && (
        <div className="mt-1.5">
          {'loading' in loaded ? (
            <div className="text-label text-disabled">Loading…</div>
          ) : 'text' in loaded ? (
            <pre className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-control border border-hairline bg-raised px-4 py-3 text-label leading-relaxed text-secondary">
              {loaded.text || '(empty file)'}
            </pre>
          ) : 'error' in loaded ? (
            <div className="text-label text-accent">Couldn't load this file - {loaded.error}</div>
          ) : (
            <div className="text-label text-disabled">(binary - use the download link)</div>
          )}
        </div>
      )}
    </li>
  )
}

/** A recorded artifact whose blob is no longer synced - non-clickable, with a
 *  subtle hint rather than a dead link. */
export function UnavailableFileRow({ path }: { path: string }) {
  return (
    <li className="text-meta">
      <div className="flex items-baseline gap-2">
        <span className="break-all font-mono text-disabled">{path}</span>
        <span className="shrink-0 text-micro font-medium text-disabled">not available</span>
      </div>
    </li>
  )
}
