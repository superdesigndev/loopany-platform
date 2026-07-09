// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopDetailView } from './LoopDetailView'
import type { JobDetail } from '../types'

/**
 * End-to-end render guard for the cross-team-link fix (fm/team-url-design).
 *
 * The bug: a direct link to a loop in a team you belong to returned "loop not
 * found" unless that team was your ACTIVE team. The server fix authorizes by
 * membership; the UI half is this: when a member opens a loop that isn't their
 * active team, the loop still renders (in its own team context) and the header
 * surfaces (1) a quiet team chip and (2) an explicit "Switch to this team"
 * banner/button — it must NOT silently switch the active team. When the loop IS
 * the active team (or no team context), neither the chip nor the banner shows.
 *
 * getJobDetail carries `team = {id, name, isActive}`; these tests render the real
 * LoopDetailView against each shape and assert the end-user surface.
 */

const h = vi.hoisted(() => ({ detail: null as JobDetail | null }))

vi.mock('../server/loopApi', () => ({
  getJobDetail: vi.fn(async () => h.detail),
  loadOlderRuns: vi.fn(async () => []),
  deleteJob: vi.fn(async () => ({})),
  evolveJob: vi.fn(async () => ({})),
  patchJob: vi.fn(async () => ({})),
  requestEdit: vi.fn(async () => ({})),
  runJob: vi.fn(async () => ({})),
}))

vi.mock('../server/notifyFns', () => ({
  listChannels: vi.fn(async () => []),
}))

// The page renders TanStack <Link>s + useNavigate; outside a router they throw.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => createElement('span', null, children),
  useNavigate: () => () => {},
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detailWithTeam = (team: JobDetail['team']): JobDetail =>
  ({
    job: {
      id: 'l1',
      cron: '0 6 * * *',
      taskFile: '/tmp/react-doctor/README.md',
      exec: { executor: 'claude', workdir: '/tmp/react-doctor' },
      agent: 'claude-code',
    },
    summary: {
      id: 'l1',
      name: 'Daily react-doctor triage',
      cron: '0 6 * * *',
      kind: 'open',
      enabled: true,
      notify: 'auto',
      nextRun: '2026-07-08T13:00:00.000Z',
      running: false,
      lastRunTs: null,
      graduation: null,
      goal: null,
      runs: [],
      runCount: 0,
      totalCostUsd: null,
    },
    taskFileContent: null,
    taskFileSyncedAt: null,
    machine: { id: 'm1', name: 'repro-box', online: true, presence: 'online', lastSeen: null },
    team,
    runs: [],
  }) as unknown as JobDetail

let host: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(LoopDetailView, { id: 'l1' }))
  })
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

describe('loop detail cross-team header', () => {
  it('a member viewing a cross-team loop sees the team chip + explicit switch banner', async () => {
    h.detail = detailWithTeam({ id: 'team-b', name: 'Acme Web', isActive: false })
    await mount()
    const text = host!.textContent ?? ''
    // The banner (the explicit, non-silent switch affordance).
    expect(text).toContain('Viewing a loop in Acme Web')
    expect(text).toContain('not your active team')
    expect(text).toContain('Switch to this team')
    // The quiet team chip in the header.
    expect(text).toContain('Acme Web')
    // The loop itself renders (NOT "not found") — its name is present.
    expect(text).toContain('Daily react-doctor triage')

    // Write the rendered header as an evidence artifact.
    const header = host!.querySelector('header')
    const dir = mkdtempSync(join(tmpdir(), 'adscaile-evidence-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'loop-header-cross-team.html'), header?.outerHTML ?? '', 'utf8')
  })

  it('the switch banner is a button that sets the team cookie and does NOT silently switch', async () => {
    h.detail = detailWithTeam({ id: 'team-b', name: 'Acme Web', isActive: false })
    await mount()
    // No cookie was written just by rendering the cross-team loop.
    expect(document.cookie).not.toContain('adscaile.team')
    const btn = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes('Switch to this team'))
    expect(btn).toBeTruthy()
    // Clicking the button is the ONLY thing that writes the active-team cookie.
    // (jsdom has no navigation; stub reload so the handler doesn't throw.)
    Object.defineProperty(window, 'location', { value: { ...window.location, reload: () => {} }, writable: true })
    await act(async () => {
      btn!.click()
    })
    expect(document.cookie).toContain('adscaile.team=team-b')
  })

  it('a loop in the caller’s ACTIVE team shows no chip and no switch banner', async () => {
    h.detail = detailWithTeam({ id: 'team-a', name: 'Acme Web', isActive: true })
    await mount()
    const text = host!.textContent ?? ''
    expect(text).not.toContain('Switch to this team')
    expect(text).not.toContain('Viewing a loop in')
    expect(text).toContain('Daily react-doctor triage')
  })

  it('open mode (no team context) shows no chip and no switch banner', async () => {
    h.detail = detailWithTeam(null)
    await mount()
    const text = host!.textContent ?? ''
    expect(text).not.toContain('Switch to this team')
    expect(text).not.toContain('Viewing a loop in')
    expect(text).toContain('Daily react-doctor triage')
  })
})
