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
