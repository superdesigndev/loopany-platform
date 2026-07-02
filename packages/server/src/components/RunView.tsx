import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ArtifactSummary, JobDetail, RunDiffResult, RunSummary, TranscriptResult } from '../types'
import { dur, fmt } from '../lib/format'
import { cancelRun, getArtifacts, getJobDetail, getRunDiff, getTranscript, loadOlderRuns } from '../server/loopApi'
import { ArtifactFileRow, UnavailableFileRow } from './ArtifactFileRow'
import { DiffView } from './DiffView'
import { TranscriptView } from './TranscriptView'
import { btn, btnDanger, StatusPill } from './ui'
import { LoadErrorCard } from './actionUi'

/** A section card — mirrors the loop page's `rounded-2xl border-wire bg-surface`
 *  panels with the mono instrument-panel label. `min-w-0` so wide inner content
 *  (a diff / transcript line) scrolls inside the card, never widens the page. */
function Card({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl border border-wire bg-surface px-6 py-5">
      <div className="mb-3.5 border-b border-hairline pb-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary">
        {label}
        {count != null && <span className="text-disabled"> ({count})</span>}
      </div>
      {children}
    </section>
  )
}

/** A stacked key/value field for the metadata rail — a mono label over its value. */
function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-disabled">{k}</div>
      <div className="min-w-0 text-[13px] text-primary">{children}</div>
    </div>
  )
}

/** A calm, non-bracket loading line (retires the old modal-era bracket placeholder). */
function Loading() {
  return <div className="text-[13px] text-disabled">Loading…</div>
}

/** A friendly, expand-on-click payload block (system prompt / user query). */
function Fold({ title, sub, body }: { title: string; sub?: string; body: string }) {
  return (
    <details className="group mb-2 min-w-0 overflow-hidden rounded-md border border-hairline bg-surface">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3.5 py-2.5 font-mono text-[12px] tracking-[0.04em] text-primary marker:content-['']">
        <span aria-hidden className="shrink-0 text-[10px] text-disabled transition-transform group-open:rotate-90">▸</span>
        {title}
        {sub && <span className="tracking-normal text-secondary">{sub}</span>}
      </summary>
      <pre className="m-0 max-h-[360px] min-w-0 overflow-auto whitespace-pre-wrap break-words border-t border-hairline bg-raised px-4 py-3.5 font-mono text-[12.5px] leading-relaxed text-secondary">
        {body}
      </pre>
    </details>
  )
}

/** Historical fallback for a run with no snapshot (predates Phase 3): the run's
 *  recorded produced-file list, reusing the Phase 2 file viewer. Files still
 *  synced to the loop expand/download inline; ones with no synced blob render
 *  non-clickable with a subtle hint instead of a dead link. */
function RecordedFiles({ run }: { run: RunSummary }) {
  const artifacts = run.artifacts ?? []
  const [live, setLive] = useState<ArtifactSummary[] | null>(null)
  useEffect(() => {
    let alive = true
    getArtifacts({ data: { loopId: run.loopId } })
      .then((d) => alive && setLive(d))
      .catch(() => alive && setLive([]))
    return () => {
      alive = false
    }
  }, [run.loopId])

  const byPath = new Map((live ?? []).map((f) => [f.path, f]))
  if (live == null) return <Loading />
  return (
    <ul className="space-y-1">
      {artifacts.map((a) => {
        const f = byPath.get(a.path)
        return f ? (
          <ArtifactFileRow key={a.path} loopId={run.loopId} file={f} />
        ) : (
          <UnavailableFileRow key={a.path} path={a.path} />
        )
      })}
    </ul>
  )
}

/** Per-run artifact diff vs the previous run (Phase 3), rendered as a colored diff
 *  view. Lazy by runId; degrades to a calm fallback for runs with no snapshot. */
function Changes({ run }: { run: RunSummary }) {
  const [data, setData] = useState<RunDiffResult | null>(null)
  useEffect(() => {
    if (run.running) return // snapshot is captured at finalize — nothing to diff yet
    let alive = true
    getRunDiff({ data: { runId: run.id } })
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ hasSnapshot: false, files: [] }))
    return () => {
      alive = false
    }
  }, [run.id, run.running])

  if (run.running)
    return (
      <Card label="changes">
        <div className="text-[13px] text-disabled">File changes appear once the run finishes.</div>
      </Card>
    )
  if (!data)
    return (
      <Card label="changes">
        <Loading />
      </Card>
    )
  if (!data.hasSnapshot) {
    // Runs predating Phase 3 have no diff snapshot — fall back to the run's
    // recorded produced-file list so the file surface isn't lost.
    if ((run.artifacts?.length ?? 0) > 0)
      return (
        <Card label="files" count={run.artifacts?.length ?? 0}>
          <RecordedFiles run={run} />
        </Card>
      )
    return (
      <Card label="changes">
        <div className="text-[13px] text-disabled">
          No recorded file changes for this run (an earlier run); runs from now on track what changed.
        </div>
      </Card>
    )
  }
  return (
    <Card label="changes" count={data.files.length}>
      {data.files.length === 0 ? (
        <div className="text-[13px] text-disabled">No files changed since the previous run.</div>
      ) : (
        <DiffView files={data.files} />
      )}
    </Card>
  )
}

function Transcript({ runId, running }: { runId: string; running?: boolean }) {
  const [data, setData] = useState<TranscriptResult | null>(null)
  // Keyed on `running` too: a run opened mid-flight has only a partial trace (or
  // none yet), so refetch once it settles to pull the complete transcript.
  useEffect(() => {
    let alive = true
    getTranscript({ data: { runId } })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setData({ error: String(e) }))
    return () => {
      alive = false
    }
  }, [runId, running])

  if (!data) return <Loading />
  if ('error' in data)
    return <div className="text-[13px] text-accent">Couldn't load the execution trace — {data.error}</div>
  return (
    <div className="min-w-0">
      {data.system && <Fold title="system prompt" sub="standing instructions · current version" body={data.system} />}
      {data.query && <Fold title="user query" sub="actual payload sent" body={data.query} />}
      <div className="mt-3">
        <TranscriptView steps={data.steps} />
      </div>
    </div>
  )
}

// The coding agent's session id behind this run — handy for resuming that session
// in your agent (e.g. `claude --resume <id>`) or feeding the auto-evolve context.
// Mono + click-to-copy.
function SessionId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(id)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      title="Copy session id"
      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-left font-mono text-[12px] text-secondary transition-colors hover:text-display"
    >
      <span className="truncate">{id}</span>
      <span aria-hidden className="shrink-0 text-[10px] tracking-[0.08em] text-disabled">
        {copied ? '✓ copied' : 'copy'}
      </span>
    </button>
  )
}

/** A header chip — mirrors the loop page's wire-outline mono chip. */
function Chip({ children, tone = 'wire' }: { children: React.ReactNode; tone?: 'wire' | 'hairline' }) {
  const border = tone === 'hairline' ? 'border-hairline text-secondary' : 'border-wire text-display'
  return (
    <span className={`inline-flex h-5 items-center rounded border px-2 font-mono text-[10.5px] tracking-[0.06em] ${border}`}>
      {children}
    </span>
  )
}

/** How many older pages to walk back looking for a run not in the latest set
 *  (cursor paging via loadOlderRuns) before giving up — a safety bound so a bad
 *  runId can't page the whole history. 64 × 100/page covers very deep histories. */
const MAX_OLDER_PAGES = 64

/**
 * Run detail PAGE body — its own route (`/loops/$loopId/runs/$runId`). Resolves
 * the run by id from the loop's detail payload (reusing getJobDetail, no new
 * backend); a run older than that latest window is located by paging backward
 * with the existing `loadOlderRuns` cursor fn. Self-polls while it's in flight.
 *
 * Layout mirrors the loop detail page: a header card (name / status pill / chips
 * + action toolbar), then a two-column main — the meaty content (Changes diff +
 * Execution trace + Report) in a wide `minmax(0,1fr)` column, the run metadata in
 * a capped right rail. `min-w-0` everywhere + panes that scroll their own wide
 * content keep the page free of horizontal scroll at any width.
 */
export function RunDetailView({ loopId, runId }: { loopId: string; runId: string }) {
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [olderRun, setOlderRun] = useState<RunSummary | null>(null) // located via backward paging
  const [searchDone, setSearchDone] = useState(false) // backward search settled (found or exhausted)
  const [err, setErr] = useState<string | null>(null)

  // Initial load — surfaces a fatal error if the loop itself can't be read.
  const load = useCallback(async () => {
    try {
      setDetail(await getJobDetail({ data: loopId }))
      setErr(null) // clear a prior transient error on success
    } catch (e) {
      setErr(String(e))
    }
  }, [loopId])

  // Silent background refresh (the live-run poll) — a transient failure keeps the
  // stale data on screen rather than bricking the page on the `if (err)` guard.
  const poll = useCallback(async () => {
    try {
      setDetail(await getJobDetail({ data: loopId }))
    } catch {
      /* keep what we have; the next tick retries */
    }
  }, [loopId])

  useEffect(() => {
    setDetail(null)
    setOlderRun(null)
    setSearchDone(false)
    setErr(null)
    void load()
  }, [loopId, runId, load])

  const run = detail?.runs.find((r) => r.id === runId) ?? olderRun

  // Not in the latest window → walk older pages by cursor until we find it or run
  // out (try/finally so searchDone always settles, even on a transient failure —
  // otherwise the page would hang on the loading guard).
  useEffect(() => {
    if (!detail || run || searchDone) return
    let alive = true
    void (async () => {
      try {
        let cursor = detail.runs.length ? detail.runs[detail.runs.length - 1]!.ts : new Date().toISOString()
        for (let i = 0; i < MAX_OLDER_PAGES && alive; i++) {
          const page = await loadOlderRuns({ data: { loopId, beforeTs: cursor, limit: 100 } })
          if (!page.length) break
          const hit = page.find((r) => r.id === runId)
          if (hit) {
            if (alive) setOlderRun(hit)
            return
          }
          cursor = page[0]!.ts // loadOlderRuns returns oldest-first; page back from the oldest
        }
      } finally {
        if (alive) setSearchDone(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [detail, run, searchDone, loopId, runId])

  // Keep a live run streaming in (its transcript + diff settle once it finishes).
  const running = !!run?.running
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void poll(), 3_000)
    return () => clearInterval(t)
  }, [running, poll])

  async function onStop() {
    if (!run) return
    if (!confirm('Stop this run? It will be marked canceled.')) return
    const r = await cancelRun({ data: run.id })
    if (r?.error) {
      alert(`Stop failed: ${r.error}`)
      return
    }
    await load()
  }

  if (err) return <LoadErrorCard title="Couldn't load this run." detail={err} onRetry={() => void load()} />
  // Still loading while the loop detail is in flight, or while the backward
  // search for an older run hasn't settled yet.
  if (!detail || (!run && !searchDone)) return <Loading />
  if (!run)
    return (
      <div className="rounded-2xl border border-wire bg-surface px-6 py-10 text-center">
        <div className="text-[14px] text-secondary">This run is no longer available.</div>
        <Link
          to="/loops/$loopId"
          params={{ loopId }}
          className="mt-3 inline-block font-mono text-[12px] tracking-[0.08em] text-interactive underline underline-offset-2 hover:text-display"
        >
          ← back to the loop
        </Link>
      </div>
    )

  const jobName = detail.summary.name
  const roleChip = run.role || null
  return (
    <>
      {/* header card — mirrors the loop detail page */}
      <header className="rounded-2xl border border-wire bg-surface px-6 pb-5 pt-[22px]">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[26px] font-medium leading-tight tracking-tight text-display">Run · {jobName}</h1>
              <StatusPill run={run} colorText />
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono text-[12.5px] tracking-[0.02em] text-secondary">
              <span className="text-primary">{fmt(run.ts)}</span>
              <span className="text-wire">·</span>
              {roleChip && <Chip tone="hairline">{roleChip}</Chip>}
              {run.durationMs != null && <Chip>{dur(run.durationMs)}</Chip>}
              <code className="font-mono text-disabled">{run.id}</code>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2.5 border-t border-hairline pt-4">
          <Link to="/loops/$loopId" params={{ loopId }} className={btn}>
            View the whole loop →
          </Link>
          {run.running && (
            <button type="button" onClick={onStop} className={btnDanger}>
              Stop run
            </button>
          )}
        </div>
      </header>

      {/* two-column main: meaty content wide, metadata in a capped rail */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <div className="flex min-w-0 flex-col gap-6">
          {run.message && (
            <Card label="report">
              <div className="whitespace-pre-wrap break-words rounded-md border border-hairline bg-raised px-4 py-3.5 text-[13px] leading-relaxed text-primary">
                {run.message}
              </div>
            </Card>
          )}

          <Changes run={run} />

          {run.control && run.control.length > 0 && (
            <Card label="control actions" count={run.control.length}>
              <ul className="space-y-1.5">
                {run.control.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[12px]">
                    <span className="text-display">{c.command}</span>
                    <span className="min-w-0 break-all text-secondary">{JSON.stringify(c.args)}</span>
                    <span aria-hidden className="text-wire">→</span>
                    <span className="text-primary">{c.result}</span>
                    {c.detail && <span className="text-disabled">({c.detail})</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card label="execution">
            {run.sessionId ? (
              <Transcript runId={run.id} running={run.running} />
            ) : (
              <div className="text-[13px] text-disabled">
                This run has no recorded session (an earlier run); runs from now on include the execution trace.
              </div>
            )}
          </Card>
        </div>

        {/* metadata rail */}
        <div className="flex min-w-0 flex-col gap-6">
          <Card label="details">
            <div className="space-y-3.5">
              <Field k="state">
                <StatusPill run={run} colorText />
              </Field>
              {run.status && <Field k="status">{run.status}</Field>}
              {run.durationMs != null && <Field k="duration">{dur(run.durationMs)}</Field>}
              {run.sample != null && <Field k="sample">{String(run.sample)}</Field>}
              {run.state != null && (
                <Field k="run state">
                  <code className="block break-all font-mono text-[12px] text-secondary">{JSON.stringify(run.state)}</code>
                </Field>
              )}
              {run.error && (
                <Field k="error">
                  <span className="break-words" style={{ color: 'var(--color-run-error)' }}>
                    {run.error}
                  </span>
                </Field>
              )}
              {run.sessionId && (
                <Field k="session">
                  <SessionId id={run.sessionId} />
                </Field>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
