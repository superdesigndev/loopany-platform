// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunDetailView } from './RunView'
import type { JobDetail, RunSummary } from '../types'

/**
 * Regression guard for the run-detail LIVE-ACTIVITY parity fix.
 *
 * The bug: while a run executed, its own detail page showed nothing about what it
 * was doing (Report/Changes/Transcript all settle only at finalize), even though
 * the loop page's Runs list — which links to it — streamed the run's progress
 * (`{step, label}` heartbeat). The fix surfaces that same progress on the run page
 * as an "Activity" card, rendered ONLY while `run.running`. These tests pin BOTH
 * halves: the card appears (with the live step + label) for an in-flight run, and
 * is entirely absent for a terminal run (so settled pages are unchanged).
 */

// The detail payload the page loads is swapped per test via this hoisted holder
// (vi.mock's factory is hoisted above imports, so it can't close over a later const).
const h = vi.hoisted(() => ({ detail: null as JobDetail | null }))

vi.mock('../server/loopApi', () => ({
  getJobDetail: vi.fn(async () => h.detail),
  loadOlderRuns: vi.fn(async () => []),
  getArtifacts: vi.fn(async () => []),
  getRunDiff: vi.fn(async () => ({ hasSnapshot: false, files: [] })),
  getTranscript: vi.fn(async () => ({ steps: [] })),
  cancelRun: vi.fn(async () => ({})),
}))

// The page renders TanStack <Link>s; outside a router they throw. Swap for a plain
// anchor — routing isn't what this test exercises.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => createElement('span', null, children),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseRun: RunSummary = {
  id: 'r1',
  loopId: 'l1',
  ts: '2026-07-07T05:58:18.000Z',
  outcome: 'new',
  status: null,
  message: null,
  durationMs: null,
  costUsd: null,
  usage: null,
  error: null,
  state: null,
  control: null,
  sessionId: null,
  artifacts: null,
  progress: null,
}

const detailFor = (run: RunSummary): JobDetail =>
  ({
    job: { taskFile: '/tmp/live-demo/README.md', exec: { workdir: '/tmp/live-demo' } },
    summary: { name: 'Live Demo Loop' },
    taskFileContent: null,
    taskFileSyncedAt: null,
    machine: { id: 'm1', name: 'repro-box', online: true, presence: 'online', lastSeen: null },
    runs: [run],
  }) as unknown as JobDetail

let host: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(RunDetailView, { loopId: 'l1', runId: 'r1' }))
  })
  // Flush the getJobDetail promise the load effect kicked off.
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

describe('run detail live activity', () => {
  it('shows the live progress step + label for an in-flight run', async () => {
    h.detail = detailFor({
      ...baseRun,
      running: true,
      progress: { step: 34, label: 'Running npx react-doctor@latest' },
    })
    await mount()
    const text = host!.textContent ?? ''
    expect(text).toContain('Activity')
    expect(text).toContain('step 34')
    expect(text).toContain('Running npx react-doctor@latest')
    expect(text).toContain('updates live')
  })

  it('shows a starting placeholder before the first heartbeat lands', async () => {
    h.detail = detailFor({ ...baseRun, running: true, progress: null })
    await mount()
    const text = host!.textContent ?? ''
    expect(text).toContain('Activity')
    expect(text).toMatch(/waiting for the first heartbeat/i)
  })

  it('renders NO activity card for a terminal run (settled page unchanged)', async () => {
    h.detail = detailFor({
      ...baseRun,
      running: false,
      status: 'new',
      message: 'Opened PR #42 fixing the worst issue.',
      durationMs: 190_000,
      costUsd: 0.42,
    })
    await mount()
    const text = host!.textContent ?? ''
    expect(text).not.toContain('Activity')
    expect(text).not.toContain('updates live')
    // The terminal report still shows — the fix is additive, not a replacement.
    expect(text).toContain('Opened PR #42 fixing the worst issue.')
  })
})
