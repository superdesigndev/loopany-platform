import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard: a QUEUED run must never be presented as a RUNNING one.
 *
 * The bug (2026-08-10). `toRunSummary` mapped BOTH open phases onto one flag —
 * `running: r.phase === "pending" || r.phase === "running"` — and `JobSummary.running`
 * came from `hasOpenRun`, which is likewise phase-agnostic. Three surfaces consumed
 * that single flag, so a run merely QUEUED for a machine that was asleep or shut:
 *
 *   1. rendered a pulsing "Running" badge, claiming work was under way;
 *   2. put the loop and run pages on their 3s LIVE poll cadence; and
 *   3. disabled "Run once" with the tooltip "A run is already in progress".
 *
 * (1) and (3) are lies. (2) is a load amplifier that never stops: a genuinely
 * running run is bounded by RUN_TIMEOUT_MS (~20min), so its 3s cadence is
 * self-limiting, but a queued run survives for DEFERRED_MAX_MS (7 days), so every
 * such page hammered the server at the live rate for as long as the machine stayed
 * away. Fleet-wide, dozens of deferred runs meant dozens of permanently-fast pages.
 *
 * These are SOURCE-level guards because the coupling is what regresses: someone
 * re-collapsing the phases, or re-gating a fast poll on the wrong flag, is the exact
 * mistake being prevented. Path stays in a VARIABLE — vite statically rewrites a
 * literal `new URL('./x', import.meta.url)` into an asset URL (see CLAUDE.md).
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** Slice between two markers, asserting BOTH exist and are ordered. A bare
 *  `indexOf` pair silently yields an empty string when a marker is removed, which
 *  would make every negative assertion below pass vacuously - the exact way a
 *  source-reading guard rots into a no-op. */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  const b = src.indexOf(end)
  expect(a, `missing marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(b, `missing marker: ${end}`).toBeGreaterThan(a)
  const slice = src.slice(a, b)
  expect(slice.length).toBeGreaterThan(0)
  return slice
}

const adapters = read('../server/adapters.ts')
const detail = read('./LoopDetailView.tsx')
const runView = read('./RunView.tsx')
const card = read('./LoopCard.tsx')

describe('the adapter keeps queued and running apart', () => {
  it('never collapses pending into running', () => {
    expect(adapters).not.toMatch(/running:\s*r\.phase === "pending"/)
    expect(adapters).toContain('running: r.phase === "running"')
    expect(adapters).toContain('queued: r.phase === "pending"')
  })

  it('derives the loop-level flags from the phase split, not a phase-agnostic probe', () => {
    expect(adapters).not.toMatch(/running:\s*await store\.hasOpenRun/)
    expect(adapters).toContain('store.openRunPhases(loop.id)')
    expect(adapters).toContain('running: open.running')
    expect(adapters).toContain('queued: open.queued')
  })
})

describe('the fast poll is reserved for a genuinely executing run', () => {
  it('gates the loop page 3s cadence on running alone', () => {
    expect(detail).toContain("const running = !!detail?.summary.running")
    expect(detail).toMatch(/load\(true\), running \? 3_000 : 8_000/)
    // The queued flag must NOT feed the fast cadence.
    expect(detail).not.toMatch(/\(running \|\| queued\) \? 3_000/)
  })

  it('polls a queued run page on a calm cadence, never the live one', () => {
    expect(runView).toMatch(/running \? 3_000 : 15_000/)
    expect(runView).toContain('const queued = !run?.running && !!run?.queued')
  })
})

describe('queued never renders as running', () => {
  it('shows a distinct, non-pulsing queued state on the loop page', () => {
    expect(detail).toMatch(/!s\.running && s\.queued/)
    expect(detail).toContain('queuedLabel')
  })

  it('shows a distinct queued pill on the loop card', () => {
    expect(card).toMatch(/!job\.running && job\.queued/)
  })

  it('shows the still QueuedActivity card, not the live one, for a queued run', () => {
    expect(runView).toContain('function QueuedActivity')
    expect(runView).toMatch(/!run\.running && run\.queued/)
  })

  it('does not claim a run is in progress when it is only queued', () => {
    expect(detail).toMatch(/s\.queued\s*\n?\s*\?\s*queuedReason/)
  })
})

/**
 * `runPulseStyle` is the LIVE signal light (`ui.tsx`: an infinite breathing
 * animation). Applying it to a queued surface makes the same false activity claim
 * the badge fix removed, just in a smaller place - so the pulse must be gated on
 * `running`, never on a condition a queued run also satisfies.
 */
describe('the live pulse never appears on a queued surface', () => {
  it('gives the queued edit-run branch a still dot and honest wording', () => {
    // The edit banner must branch on queued BEFORE running, and that branch must
    // not carry the pulse or claim the edit is being applied.
    expect(detail).toMatch(/editRun\.queued \? \(/)
    const queuedBranch = between(detail, 'editRun.queued ? (', 'editRun.running ? (')
    expect(queuedBranch).not.toContain('runPulseStyle')
    expect(queuedBranch).not.toContain('Applying your edit')
    expect(queuedBranch).toContain('Edit queued')
  })

  it('pulses the run-list progress dot only while executing', () => {
    expect(detail).toMatch(/style=\{x\.running \? runPulseStyle : undefined\}/)
  })

  it('keeps the not-yet-visible edit-queued line still as well', () => {
    const branch = between(detail, '{!editRun ? (', 'editRun.queued ? (')
    expect(branch).not.toContain('runPulseStyle')
  })
})

/**
 * Cancellation regression: before the split, `running` covered `pending`, so a queued
 * run DID show the stop control. The server accepts both phases (`loopApi.cancelRun`),
 * and a queued run is the one that can linger for days - losing its only cancel path
 * would be a regression introduced by the split itself.
 */
describe('a queued run can still be cancelled from the UI', () => {
  it('offers the control for both open states', () => {
    expect(runView).toMatch(/\(run\.running \|\| run\.queued\) && \(/)
    expect(runView).toMatch(/run\.running \? 'Stop run' : 'Cancel run'/)
  })
})
