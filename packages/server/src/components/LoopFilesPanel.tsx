import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactContent, ArtifactSummary } from '../types'
import { fmt, humanBytes } from '../lib/format'
import { buildFileEntries, isTaskEntry } from '../lib/fileEntries'
import { getArtifact, getArtifacts } from '../server/loopApi'
import { downloadHref } from './ArtifactFileRow'
import { TaskFileView } from './TaskFileView'

/**
 * The unified "Files" surface of the loop detail page — the loop's spec (its task
 * file) shown ALONGSIDE every live-synced artifact in ONE master-detail panel,
 * not two separate boxes. A file list (task file pinned first, then artifacts
 * path-sorted) drives a content viewer on the right; the task file is selected by
 * default. Text files render inline (markdown → formatted, else mono); binary /
 * oversize files offer the download route. The artifact list is fetched lazily by
 * loopId and self-polls so files appear as the loop writes them (Phase 1-2 reuse).
 */

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path)
const basename = (path: string) => path.split('/').pop() || path

/** Faint type tag shown after a file's size. */
function typeTag(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i)
  return m ? m[1]!.toLowerCase() : 'file'
}

export function LoopFilesPanel({
  loopId,
  taskFile,
  taskFileContent,
  taskFileSyncedAt,
  running,
}: {
  loopId: string
  /** The loop's task-file path (relative), or undefined when it has none. */
  taskFile?: string
  /** The task file's synced content (markdown), or null when not yet synced. */
  taskFileContent: string | null
  taskFileSyncedAt: string | null
  running?: boolean
}) {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const seq = useRef(0) // guards a stale list overwriting a fresh one

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const list = await getArtifacts({ data: { loopId } })
      if (mine === seq.current) setArtifacts(list)
    } catch {
      if (mine === seq.current) setArtifacts((prev) => prev ?? [])
    }
  }, [loopId])

  // Reset + fetch on loop change.
  useEffect(() => {
    setArtifacts(null)
    setSelected(null)
    void refresh()
  }, [loopId, refresh])

  // Keep the list live as the loop writes files — quick while running, calm otherwise.
  useEffect(() => {
    const t = setInterval(() => void refresh(), running ? 4_000 : 12_000)
    return () => clearInterval(t)
  }, [running, refresh])

  // Build the unified entry list (task FIRST, then path-sorted artifacts) — see
  // `buildFileEntries`: the task file IS the loop folder's README, so it appears
  // exactly once (badge the synced artifact, or a synthetic entry pre-first-sync).
  const entries = useMemo(() => buildFileEntries(taskFile, artifacts ?? []), [taskFile, artifacts])

  // Default selection: the task file, else the first artifact. Only auto-pick
  // when nothing is selected (or the prior pick vanished) so a manual choice and
  // the live polling don't fight.
  useEffect(() => {
    if (!entries.length) return
    if (selected && entries.some((e) => e.path === selected)) return
    setSelected(entries[0]!.path)
  }, [entries, selected])

  const active = entries.find((e) => e.path === selected) ?? null
  // The task row — synthetic OR a synced artifact badged as the task — always
  // renders from the loop record's `taskFileContent` (authoritative + always
  // present), not the artifact's own blob fetch. Same file, but this is robust to
  // a missing blob and avoids a redundant round-trip.
  const activeIsTask = isTaskEntry(active)

  return (
    <section className="min-w-0">
      <div className="mb-2.5 flex items-end justify-between gap-3 border-b border-hairline pb-1.5">
        <h2 className="font-mono text-[11px] tracking-[0.08em] text-secondary">
          files{artifacts ? ` (${entries.length})` : ''}
        </h2>
        <span className="font-mono text-[10.5px] tracking-[0.04em] text-disabled">spec + synced artifacts</span>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-xl border border-wire bg-surface px-5 py-10 text-center text-[13px] text-disabled">
          {artifacts == null ? '[ loading ]' : 'No files yet — the task file and synced artifacts appear here.'}
        </div>
      ) : (
        <div className="grid h-[min(600px,68vh)] grid-cols-1 overflow-hidden rounded-xl border border-wire bg-surface sm:grid-cols-[210px_1fr]">
          {/* file list */}
          <nav className="max-h-44 overflow-y-auto border-b border-hairline sm:max-h-none sm:border-b-0 sm:border-r">
            <ul className="py-1.5">
              {entries.map((e) => {
                const on = e.path === selected
                const isTask = isTaskEntry(e)
                return (
                  <li key={e.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(e.path)}
                      className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
                        on
                          ? 'border-display bg-raised'
                          : 'border-transparent hover:bg-raised/60'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate font-mono text-[12px] ${on ? 'text-display' : 'text-primary'}`}
                          title={e.path}
                        >
                          {basename(e.path)}
                        </span>
                        {e.path.includes('/') && (
                          <span className="block truncate font-mono text-[10px] text-disabled" title={e.path}>
                            {e.path}
                          </span>
                        )}
                      </span>
                      {isTask ? (
                        <span className="shrink-0 rounded-sm border border-wire px-1 font-mono text-[9px] tracking-[0.06em] text-secondary">
                          TASK
                        </span>
                      ) : (
                        <span className="shrink-0 font-mono text-[9px] tracking-[0.04em] text-disabled">
                          {typeTag(e.path)}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          {/* content viewer */}
          <div className="min-w-0 overflow-y-auto">
            {activeIsTask && active ? (
              <TaskEntryView path={active.path} content={taskFileContent} syncedAt={taskFileSyncedAt} />
            ) : active?.kind === 'artifact' ? (
              <ArtifactEntryView loopId={loopId} file={active.file} />
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
}

/** A small monospace caption strip above a file's content (path · meta). */
function ViewerHead({ path, meta }: { path: string; meta?: string }) {
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline bg-surface px-5 py-2.5">
      <span className="break-all font-mono text-[12px] text-primary">{path}</span>
      {meta && <span className="font-mono text-[10.5px] tracking-[0.04em] text-disabled">· {meta}</span>}
    </div>
  )
}

/** The task file pane — the loop's spec, rendered as formatted markdown. */
function TaskEntryView({ path, content, syncedAt }: { path: string; content: string | null; syncedAt: string | null }) {
  return (
    <>
      <ViewerHead path={path} meta={syncedAt ? `task file · synced ${fmt(syncedAt)}` : 'task file'} />
      {content == null ? (
        <div className="px-5 py-6 text-[13px] text-disabled">(syncs from the machine on the next run)</div>
      ) : (
        <TaskFileView content={content} />
      )}
    </>
  )
}

type Loaded = ArtifactContent | { loading: true }

/** The artifact pane — text inline (markdown formatted, else mono), or a
 *  download affordance for binary / oversize files. Fetches lazily per path. */
function ArtifactEntryView({ loopId, file }: { loopId: string; file: ArtifactSummary }) {
  const [loaded, setLoaded] = useState<Loaded>({ loading: true })
  const downloadable = file.binary && !file.oversize

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

  const meta = [file.size != null ? humanBytes(file.size) : '', `synced ${fmt(file.updatedAt)}`]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <ViewerHead path={file.path} meta={meta} />
      {'loading' in loaded ? (
        <div className="px-5 py-6 font-mono text-[12px] tracking-[0.08em] text-secondary">[ loading ]</div>
      ) : 'text' in loaded ? (
        isMarkdown(file.path) ? (
          <TaskFileView content={loaded.text || '(empty file)'} />
        ) : (
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap px-5 py-4 font-mono text-[12px] leading-relaxed text-secondary">
            {loaded.text || '(empty file)'}
          </pre>
        )
      ) : 'binary' in loaded ? (
        <div className="px-5 py-8 text-[13px] text-secondary">
          {loaded.oversize ? (
            <span className="text-disabled">Too large to preview — stored as metadata only.</span>
          ) : (
            <>
              Binary file — not previewable.{' '}
              {downloadable && (
                <a
                  href={downloadHref(loopId, file.path)}
                  download
                  className="text-interactive underline underline-offset-2 transition-colors hover:text-display"
                >
                  Download
                </a>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="px-5 py-6 font-mono text-[12px] text-accent">[ ERROR ] {loaded.error}</div>
      )}
    </>
  )
}
