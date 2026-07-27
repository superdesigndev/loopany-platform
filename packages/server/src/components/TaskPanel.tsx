/**
 * <TaskPanel/> — the /tasks page's right-hand detail pane (worknode-style split
 * view, not an overlay): title, a compact meta line (P1 · EXPERIMENT · IDEA ·
 * owner · slug), a BODY box with the README, recent runs, and a COPY CONTEXT
 * button that puts an agent-ready context block on the clipboard. Lazy-fetches
 * the full detail via the same `getJobDetail` server fn the loop page uses.
 */
import { useEffect, useState } from 'react'

import { getJobDetail } from '../server/loopApi'
import type { JobDetail } from '../types'
import type { TaskRow } from '../server/taskTree'
import { TaskFileView } from './TaskFileView'
import { PRIORITY_COLOR, STATUS_COLOR } from './TaskTree'
import { cronText, rel } from '../lib/format'

export function TaskPanel({ row, onClose, onOpenLoop }: { row: TaskRow; onClose: () => void; onOpenLoop: (loopId: string) => void }) {
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)
    setCopied(false)
    getJobDetail({ data: row.loopId }).then(
      (d) => alive && setDetail(d),
      (e) => alive && setError(String(e)),
    )
    return () => {
      alive = false
    }
  }, [row.loopId])

  // ESC collapses the panel back to the full-width tree.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copyContext = (): void => {
    const meta = [
      row.priority,
      row.type,
      row.status,
      row.owner,
      row.parent ? `parent: ${row.parent}` : null,
      row.cron ? `cron: ${row.cron}` : null,
      row.follow_up_date ? `follow_up: ${row.follow_up_date}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    const block = `# ${row.title} (${row.slug ?? row.loopId})\n${meta}\n\n${detail?.taskFileContent ?? ''}`
    void navigator.clipboard.writeText(block).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const runs = (detail?.runs ?? []).slice(-5).reverse()

  return (
    <div className="min-w-0 px-7 py-6">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <h2 className="min-w-0 font-display text-[26px] font-semibold leading-tight text-display">{row.title}</h2>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={copyContext}
            className="cursor-pointer border border-wire bg-surface px-2.5 py-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary shadow-[2px_2px_0_0_var(--color-wire,#d4d4d4)] transition-colors hover:border-display hover:text-display"
          >
            {copied ? '✓ COPIED' : '⧉ COPY CONTEXT'}
          </button>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="cursor-pointer border border-wire bg-surface px-2 py-1.5 font-mono text-[11px] text-secondary transition-colors hover:border-display hover:text-display"
          >
            ✕
          </button>
        </div>
      </div>

      {/* The compact worknode meta line: P1 · EXPERIMENT · IDEA · owner · slug */}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12px]">
        {row.priority && <span style={{ color: PRIORITY_COLOR[row.priority] }}>{row.priority}</span>}
        {row.type && (
          <>
            <span className="text-wire">·</span>
            <span className="text-secondary">{row.type.toUpperCase()}</span>
          </>
        )}
        {row.status && (
          <>
            <span className="text-wire">·</span>
            <span style={{ color: STATUS_COLOR[row.status] }}>{row.status.toUpperCase()}</span>
          </>
        )}
        {row.owner && (
          <>
            <span className="text-wire">·</span>
            <span className="text-secondary">{row.owner.toUpperCase()}</span>
          </>
        )}
        <span className="text-wire">·</span>
        <span className="min-w-0 truncate text-secondary">{row.slug ?? row.loopId}</span>
      </div>

      {/* Loopany-specific execution line (a loop is a task with cron set). */}
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11.5px] text-secondary">
        <span>{row.cron ? `⟳ ${cronText(row.cron)} (${row.cron})${row.enabled ? '' : ' · paused'}` : 'manual — dispatch with loopany run'}</span>
        {detail?.job.goal && <span>· goal: {detail.job.goal}</span>}
        {detail?.taskFileSyncedAt && <span>· synced {rel(detail.taskFileSyncedAt)}</span>}
      </div>

      <div className="mt-6 font-mono text-[10.5px] tracking-[0.2em] text-secondary">BODY</div>
      <div className="mt-1.5 min-w-0 border border-wire bg-surface/40">
        {error && <div className="px-5 py-4 text-[13px] text-secondary">Couldn't load the task file: {error}</div>}
        {!detail && !error && <div className="px-5 py-4 font-mono text-[12px] text-secondary">loading…</div>}
        {detail &&
          (detail.taskFileContent ? (
            <TaskFileView content={detail.taskFileContent} />
          ) : (
            <div className="px-5 py-4 text-[13px] text-secondary">No task file synced yet.</div>
          ))}
      </div>

      {runs.length > 0 && (
        <>
          <div className="mt-6 font-mono text-[10.5px] tracking-[0.2em] text-secondary">RECENT RUNS</div>
          <div className="mt-1.5 space-y-1.5">
            {runs.map((r) => (
              <div key={r.id} className="flex min-w-0 items-baseline gap-2 font-mono text-[12px]">
                <span className={`shrink-0 text-[11px] ${r.outcome === 'error' ? 'text-[#c0392b]' : 'text-secondary'}`}>
                  {r.running ? '● running' : (r.outcome ?? '—')}
                </span>
                <span className="shrink-0 text-[11px] text-secondary">{rel(r.ts)}</span>
                <span className="min-w-0 truncate text-primary">{r.message ?? r.error ?? ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-7">
        <button
          onClick={() => onOpenLoop(row.loopId)}
          className="cursor-pointer border border-wire bg-surface px-3 py-1.5 font-mono text-[11.5px] tracking-[0.06em] text-secondary transition-colors hover:border-display hover:text-display"
        >
          OPEN FULL PAGE →
        </button>
      </div>
    </div>
  )
}
