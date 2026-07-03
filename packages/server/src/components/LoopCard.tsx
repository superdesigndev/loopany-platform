import { useMemo, useState } from 'react'
import type { JobSummary, RunSummary } from '../types'
import { cronText, dotLabel, fmt, isClosed, isCompleted, lastRunOf, rel } from '../lib/format'
import { mergeRuns } from '../lib/runs'
import { loadOlderRuns } from '../server/loopApi'
import { Timeline, WINDOW } from './Timeline'
import { Pill, useHydrated } from './ui'

export function LoopCard({
  job,
  onOpen,
  onPickRun,
}: {
  job: JobSummary
  onOpen: (id: string) => void
  onPickRun: (id: string, run: RunSummary) => void
}) {
  const en = job.enabled
  const last = lastRunOf(job)
  const completed = isCompleted(job)
  // A closed loop still working toward its goal (not yet completed) → the quiet
  // "Goal" chip. Completed closed loops read via the Completed badge instead.
  const closedActive = isClosed(job) && !completed
  const hydrated = useHydrated()

  // The loader seeds `job.runs` with the newest page; we lazily fetch OLDER
  // pages on demand and keep them here. The merged list (job's fresh newest page
  // wins on overlap, so live status updates survive a poll) is what the timeline
  // renders. `older` are strictly before the newest page, so no holes form.
  const [older, setOlder] = useState<RunSummary[]>([])
  // Common case (never paged): no older runs, so skip the merge entirely — this
  // runs on every poll for every card.
  const runs = useMemo(
    () => (older.length ? mergeRuns(job.runs ?? [], older) : (job.runs ?? [])),
    [job.runs, older],
  )

  const loadMore = async (): Promise<number> => {
    const oldest = runs[0]
    if (!oldest) return 0
    const more = await loadOlderRuns({ data: { loopId: job.id, beforeTs: oldest.ts, limit: WINDOW } })
    if (more.length) setOlder((prev) => mergeRuns(prev, more))
    return more.length
  }

  // The whole card is a mouse hit-area (convenience), but the keyboard/screen-
  // reader entry point is the real <button> around the title — so we never nest
  // a button inside a button (the timeline's run blocks are buttons too).
  return (
    <div
      onClick={() => onOpen(job.id)}
      className={`mb-[18px] cursor-pointer rounded-card border border-hairline bg-surface px-[26px] pb-5 pt-[22px] shadow-card transition-colors hover:border-wire ${
        en ? '' : 'opacity-60'
      }`}
      style={{ animation: 'fadeIn .25s cubic-bezier(0.25,0.1,0.25,1) both' }}
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpen(job.id)
          }}
          className="cursor-pointer rounded-sm text-left text-[17px] font-semibold tracking-[-0.01em] text-display outline-none focus-visible:ring-2 focus-visible:ring-interactive focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
          {job.name}
        </button>
        {job.running && (
          <Pill tone="running" dot="pulse">
            Running
          </Pill>
        )}
        {job.graduation && <Pill>{job.graduation}</Pill>}
        {completed && (
          <Pill tone="success" dot="green">
            Completed
          </Pill>
        )}
        {!completed && closedActive && (
          <Pill tone="success" title={job.goal ?? undefined}>
            Goal
          </Pill>
        )}
        {!completed && !en && <Pill>Paused</Pill>}
        <div className="ml-auto whitespace-nowrap text-meta text-secondary">
          <span className="text-primary" title={job.cron}>
            {cronText(job.cron)}
          </span>
          <span className="mx-2.5 text-wire">·</span>
          {job.kind}
        </div>
      </div>

      <Timeline
        job={job}
        runs={runs}
        total={job.runCount}
        onLoadMore={loadMore}
        onPickRun={(run) => onPickRun(job.id, run)}
      />

      <div className="mt-[18px] flex items-center gap-2 text-label text-secondary">
        <span>{job.runCount} runs</span>
        {last && (
          <span>
            · last {dotLabel(last)}
            {hydrated && ` · ${rel(last.ts)}`}
          </span>
        )}
      </div>

      {completed && (
        <div className="mt-1.5 text-label text-success">
          Completed{job.completedAt ? ` · ${fmt(job.completedAt)}` : ''}
          {job.completionReason && <span className="text-secondary"> - {job.completionReason}</span>}
        </div>
      )}
    </div>
  )
}
