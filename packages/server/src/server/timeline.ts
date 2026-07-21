/**
 * Timeline assembly — lanes + marks for the cross-loop run view.
 *
 * Kept OUT of `loopApi.ts` so the interesting part (projecting future cron fires
 * and folding runs into marks) is a plain function over plain data, testable
 * without the Start RPC runtime or a DB.
 *
 * The projection is what makes this view answer "which loop runs every day and
 * at what time" — a history-only timeline cannot. It is a PURE computation over
 * the loop's cron + timezone (croner), so it stays inside the zero-exec
 * invariant: the server evaluates a schedule, it never runs anything.
 */
import { Cron } from 'croner'

import type { TimelineRun } from '../db/store.js'
import type { Loop } from '../db/schema.js'
import type { TimelineData, TimelineLoop, TimelineMachine, TimelineMark } from '../types.js'
import { cronText } from '../lib/format.js'

/** Hard ceiling on projected fires PER LOOP per window. A `* * * * *` loop over a
 *  month would otherwise generate ~43k marks and swamp both wire and DOM; the
 *  view is a schedule read, not a log, so a bounded sample is the honest answer. */
export const MAX_PROJECTED_PER_LOOP = 400

export function toTimelineLoop(loop: Loop): TimelineLoop {
  return {
    id: loop.id,
    name: loop.name ?? loop.id,
    cron: loop.cron,
    timezone: loop.timezone ?? null,
    enabled: loop.enabled,
    completedAt: loop.completedAt ?? null,
    cadence: cronText(loop.cron),
    machineId: loop.machineId,
  }
}

/**
 * The device-filter options, derived from the loops in scope (never the full
 * machine list) so the filter can't offer a machine that empties the view.
 *
 * A machine's `name` is empty until its daemon connects, so fall back to
 * hostname, then a short id — a blank option is unpickable.
 */
export function timelineMachines(
  loops: TimelineLoop[],
  machines: Array<{ id: string; name: string; hostname: string | null }>,
): TimelineMachine[] {
  const counts = new Map<string, number>()
  for (const l of loops) counts.set(l.machineId, (counts.get(l.machineId) ?? 0) + 1)
  const byId = new Map(machines.map((m) => [m.id, m]))
  return [...counts.entries()]
    .map(([id, loopCount]) => {
      const m = byId.get(id)
      // A loop can outlive its machine row (deleted machine); label it honestly
      // rather than dropping the option and orphaning those lanes from the filter.
      const label = m?.name?.trim() || m?.hostname?.trim() || `${id.slice(0, 10)}…`
      return { id, label, loopCount }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Future fires for one loop inside `(after, to)`, in the LOOP's own timezone.
 *
 * Returns [] for a disabled or completed loop (it will not fire), and for any
 * cron croner rejects — a bad expression is a lane with no ghosts, never a
 * thrown request. A pinned one-shot (`nextRunAt`) is emitted first and the cron
 * walk continues past it, matching what the scheduler actually does.
 */
export function projectFires(loop: Loop, after: Date, to: Date): string[] {
  if (!loop.enabled || loop.completedAt) return []
  const out: string[] = []
  if (loop.nextRunAt) {
    const pinned = new Date(loop.nextRunAt)
    if (pinned > after && pinned <= to) out.push(pinned.toISOString())
  }
  let probe: Cron | undefined
  try {
    probe = new Cron(loop.cron, { paused: true, ...(loop.timezone ? { timezone: loop.timezone } : {}) })
    let cursor = after
    for (let i = 0; i < MAX_PROJECTED_PER_LOOP; i++) {
      const next = probe.nextRun(cursor)
      if (!next || next > to) break
      const iso = next.toISOString()
      if (!out.includes(iso)) out.push(iso)
      cursor = next
    }
  } catch {
    // Unparseable cron ⇒ no projection. `cronText` already falls back to the
    // raw expression, so the lane still identifies itself honestly.
  } finally {
    probe?.stop()
  }
  return out.sort()
}

/** A persisted run → a mark. Mirrors `toRunSummary`'s derivations so the lane and
 *  the loop card can never disagree about what a run looked like. */
export function runToMark(r: TimelineRun): TimelineMark {
  return {
    loopId: r.loopId,
    ts: r.ts,
    runId: r.id,
    kind: 'run',
    running: r.phase === 'pending' || r.phase === 'running',
    canceled: r.phase === 'canceled',
    role: r.role,
    outcome: r.outcome ?? 'silent',
    status: r.status ?? null,
    durationMs: r.durationMs ?? null,
    costUsd: r.costUsd ?? null,
    message: r.message ?? null,
    error: r.error ?? null,
  }
}

export function projectedMark(loopId: string, ts: string): TimelineMark {
  return {
    loopId,
    ts,
    runId: null,
    kind: 'projected',
    running: false,
    canceled: false,
    role: 'exec',
    outcome: null,
    status: null,
    durationMs: null,
    costUsd: null,
    message: null,
    error: null,
  }
}

/** Window spend, total and per loop. Null costs are EXCLUDED, never coerced to 0 —
 *  a workflow-only or codex/grok run has unknown spend, not zero spend. */
export function sumCosts(marks: TimelineMark[]): TimelineData['totals'] {
  const byLoop: Record<string, number> = {}
  let costUsd = 0
  let runCount = 0
  for (const m of marks) {
    if (m.kind !== 'run') continue
    runCount++
    if (m.costUsd == null) continue
    costUsd += m.costUsd
    byLoop[m.loopId] = (byLoop[m.loopId] ?? 0) + m.costUsd
  }
  // Float noise: sub-cent drift accumulates over a month of runs.
  const round = (n: number) => Math.round(n * 1e4) / 1e4
  for (const k of Object.keys(byLoop)) byLoop[k] = round(byLoop[k]!)
  return { runCount, costUsd: round(costUsd), byLoop }
}
