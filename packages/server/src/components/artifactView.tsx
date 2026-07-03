import { useEffect, useState } from 'react'
import type { ArtifactContent, ArtifactSummary } from '../types'
import { getArtifact } from '../server/loopApi'
import { downloadHref } from './ArtifactFileRow'
import { TaskFileView } from './TaskFileView'

/**
 * Shared pieces of the artifact content viewer - one source for the Files
 * panel's detail pane AND the dashboard artifact primitives (`<loop-embed>`,
 * `<loop-calendar>`'s and `<loop-kanban>`'s detail), so the caption strip, the
 * binary/oversize copy, and the text/markdown render can't drift between surfaces.
 */

export const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)

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
      <span className="break-all font-mono text-[12px] text-primary">{path}</span>
      {meta && <span className="font-mono text-[10.5px] tracking-[0.04em] text-disabled">· {meta}</span>}
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
    <div className="px-5 py-8 text-[13px] text-secondary">
      {oversize ? (
        <span className="text-disabled">Too large to preview — stored as metadata only.</span>
      ) : (
        <>
          Binary file — not previewable.{' '}
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

type Loaded = ArtifactContent | { loading: true }

/**
 * One artifact's content body - text inline (markdown formatted, else mono),
 * binary/oversize → the download notice. Fetches lazily per path (same
 * lifecycle the Files panel viewer has always used).
 */
export function ArtifactBody({ loopId, file }: { loopId: string; file: ArtifactSummary }) {
  const [loaded, setLoaded] = useState<Loaded>({ loading: true })

  useEffect(() => {
    let alive = true
    if (file.binary || file.oversize) {
      setLoaded({ binary: true, size: file.size, oversize: file.oversize })
      return
    }
    setLoaded({ loading: true })
    getArtifact({ data: { loopId, path: file.path } })
      .then((c) => alive && setLoaded(c))
      .catch((e) => alive && setLoaded({ error: String(e) }))
    return () => {
      alive = false
    }
  }, [loopId, file.path, file.binary, file.oversize, file.size, file.updatedAt])

  if ('loading' in loaded)
    return <div className="px-5 py-6 font-mono text-[12px] tracking-[0.08em] text-secondary">[ loading ]</div>
  if ('text' in loaded)
    return isMarkdown(file.path) ? (
      <TaskFileView content={loaded.text || '(empty file)'} />
    ) : (
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap px-5 py-4 font-mono text-[12px] leading-relaxed text-secondary">
        {loaded.text || '(empty file)'}
      </pre>
    )
  if ('binary' in loaded) return <BinaryNotice loopId={loopId} path={file.path} oversize={loaded.oversize} />
  return <div className="px-5 py-6 font-mono text-[12px] text-accent">[ ERROR ] {loaded.error}</div>
}
