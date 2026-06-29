import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArtifactContent, ArtifactSummary } from '../types'
import { fmt } from '../lib/format'
import { getArtifact, getArtifacts } from '../server/loopApi'
import { ModalSection } from './Modal'

/** Human byte size — "1.8 KB", "3.4 MB". */
function fmtBytes(n: number | null): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Download URL for one artifact — the path is segment-encoded so a nested path
 *  (`data/raw.json`) round-trips and can't be mistaken for extra route segments. */
function downloadHref(loopId: string, path: string): string {
  const enc = path.split('/').map(encodeURIComponent).join('/')
  return `/api/artifact/${encodeURIComponent(loopId)}/${enc}`
}

type Loaded = ArtifactContent | { loading: true }

/**
 * The "Files" section of the loop detail — the loop's CURRENT live-synced files
 * (Phase 2). The list is fetched lazily by loopId (like getTranscript) so the
 * detail payload stays small; clicking a text file pulls its content inline,
 * a binary/oversize file is a download link. Self-polls while open so files
 * appear as the loop writes them (faster while a run is live).
 */
export function FilesView({ loopId, running }: { loopId: string; running?: boolean }) {
  const [files, setFiles] = useState<ArtifactSummary[] | null>(null)
  const [open, setOpen] = useState<Record<string, Loaded>>({})
  const seq = useRef(0) // guards against a stale list overwriting a fresh one

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const list = await getArtifacts({ data: { loopId } })
      if (mine === seq.current) setFiles(list)
    } catch {
      if (mine === seq.current) setFiles((prev) => prev ?? [])
    }
  }, [loopId])

  // Reset + fetch on loop change.
  useEffect(() => {
    setFiles(null)
    setOpen({})
    void refresh()
  }, [loopId, refresh])

  // Keep the list live as the loop writes files — quick while running, calm otherwise.
  useEffect(() => {
    const t = setInterval(() => void refresh(), running ? 4_000 : 12_000)
    return () => clearInterval(t)
  }, [running, refresh])

  async function toggle(file: ArtifactSummary) {
    // Binary/oversize are download-only — no inline expand (the row is an <a>).
    if (file.binary || file.oversize) return
    const path = file.path
    const isOpen = !!open[path]
    if (isOpen) {
      setOpen((o) => {
        const next = { ...o }
        delete next[path]
        return next
      })
      return
    }
    setOpen((o) => ({ ...o, [path]: { loading: true } }))
    try {
      const content = await getArtifact({ data: { loopId, path } })
      setOpen((o) => ({ ...o, [path]: content }))
    } catch (e) {
      setOpen((o) => ({ ...o, [path]: { error: String(e) } }))
    }
  }

  return (
    <>
      <ModalSection>files{files ? ` (${files.length})` : ''}</ModalSection>
      {files == null ? (
        <div className="font-mono text-[12px] tracking-[0.08em] text-secondary">[ Loading ]</div>
      ) : files.length === 0 ? (
        <div className="text-[13px] text-disabled">(no files synced yet — syncs as the loop writes files)</div>
      ) : (
        <ul className="space-y-1">
          {files.map((f) => {
            const loaded = open[f.path]
            const downloadable = f.binary && !f.oversize
            return (
              <li key={f.path} className="font-mono text-[12.5px]">
                <div className="flex items-baseline gap-2">
                  {downloadable ? (
                    <a
                      href={downloadHref(loopId, f.path)}
                      download
                      className="break-all text-interactive underline underline-offset-2 transition-colors hover:text-display"
                    >
                      {f.path}
                    </a>
                  ) : f.oversize ? (
                    <span className="break-all text-primary">{f.path}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void toggle(f)}
                      className="cursor-pointer break-all border-none bg-transparent p-0 text-left text-primary underline-offset-2 transition-colors hover:text-display hover:underline"
                    >
                      {f.path}
                    </button>
                  )}
                  <span className="shrink-0 text-[10px] tracking-[0.06em] text-disabled">{fmtBytes(f.size)}</span>
                  {f.oversize && (
                    <span className="shrink-0 text-[10px] tracking-[0.06em] text-secondary">too large · metadata only</span>
                  )}
                  {downloadable && (
                    <span className="shrink-0 text-[10px] tracking-[0.06em] text-secondary">download</span>
                  )}
                  <span className="ml-auto shrink-0 text-[10px] tracking-[0.06em] text-disabled">{fmt(f.updatedAt)}</span>
                </div>
                {loaded && (
                  <div className="mt-1.5">
                    {'loading' in loaded ? (
                      <div className="font-mono text-[11px] tracking-[0.08em] text-secondary">[ Loading ]</div>
                    ) : 'text' in loaded ? (
                      <pre className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-hairline bg-raised px-4 py-3 text-[12px] leading-relaxed text-secondary">
                        {loaded.text || '(empty file)'}
                      </pre>
                    ) : 'error' in loaded ? (
                      <div className="font-mono text-[12px] text-accent">[ ERROR ] {loaded.error}</div>
                    ) : (
                      <div className="text-[12px] text-disabled">(binary — use the download link)</div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
