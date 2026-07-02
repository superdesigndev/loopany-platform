import { useMemo, useState } from 'react'
import type { JobSummary, RunSummary } from '../types'
import { cronText, dotLabel, isDone, lastRunOf, rel } from '../lib/format'
import { mergeRuns } from '../lib/runs'
import { loadOlderRuns } from '../server/loopApi'
import { Timeline, WINDOW } from './Timeline'
import { runPulseStyle, useHydrated } from './ui'

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
  const done = isDone(job)
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
      className={`mb-[18px] cursor-pointer rounded-2xl border border-wire bg-surface px-[26px] pb-5 pt-[22px] transition-colors hover:border-display ${
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
          className="cursor-pointer rounded-sm text-left text-[19px] font-medium tracking-tight text-display outline-none focus-visible:ring-2 focus-visible:ring-display focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
          {job.name}
        </button>
        {job.running && (
          <span className="inline-flex h-5 items-center gap-1.5 rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-display">
            <span className="size-1.5 rounded-full" style={runPulseStyle} />
            Running
          </span>
        )}
        {job.graduation && (
          <span className="inline-flex h-5 items-center rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-secondary">
            {job.graduation}
          </span>
        )}
        {done && (
          <span className="inline-flex h-5 items-center rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-display">
            Done
          </span>
        )}
        {!done && !en && (
          <span className="inline-flex h-5 items-center rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-secondary">
            Paused
          </span>
        )}
        <div className="ml-auto whitespace-nowrap font-mono text-[12.5px] tracking-[0.04em] text-secondary">
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

      <div className="mt-[18px] flex items-center gap-2 font-mono text-[11.5px] tracking-[0.04em] text-secondary">
        <span>{job.runCount} runs</span>
        {last && (
          <span>
            · last {dotLabel(last)}
            {hydrated && ` · ${rel(last.ts)}`}
          </span>
        )}
      </div>
    </div>
  )
}
