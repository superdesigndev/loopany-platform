// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceView } from './WorkspaceView'
import type { InboxItem, InboxView, LibraryArtifact, LibraryView, Summary } from './api'

/**
 * "NEEDS YOU" IS RENDERED FROM THE ACCOUNT, NOT FROM THE LIBRARY.
 *
 * The live reproduction this pins (E2E finding #2): the section used to be
 * `library.artifacts.filter(a => a.needsHuman)` while the badge counted open
 * human-verdict obligations. The Library lists CONTENT, so a gate on an object with
 * no Library row — a plain Task, which is exactly what a run escalating its own
 * findings produces — was COUNTED and never SHOWN. The API said 13; the section
 * header said 11; two verdicts a person owed were invisible.
 *
 * So the two properties asserted here are the two that failed:
 *
 *   1. every open obligation is RENDERED, including one with no artifact row
 *   2. the header count and the rendered list are the same number, always —
 *      because they now read the same rows
 *
 * Rendered for real (jsdom + `createRoot`) rather than read out of the source: the
 * defect was a rendering one, and a source-shaped guard would have passed on the
 * broken version too.
 */

const h = vi.hoisted(() => ({
  library: null as unknown as LibraryView,
  inbox: null as unknown as InboxView,
  summary: null as unknown as Summary,
  verdicts: [] as { objectId: string; transition: string }[],
}))

vi.mock('./api', () => ({
  fetchSummary: async () => h.summary,
  fetchSystem: async () => ({ nodes: [], edges: [], bands: [] }),
  fetchLibrary: async () => h.library,
  fetchInbox: async () => h.inbox,
  fetchTimeline: async () => ({ events: [], total: 0 }),
  fetchAttention: async () => ({ items: [], counts: {} }),
  fetchEffects: async () => ({ items: [], unsettled: 0 }),
  fetchWork: async () => ({ items: [], awaiting: 0, inFlight: 0 }),
  fetchSchedule: async () => ({ items: [], armed: 0, overdue: 0 }),
  fetchNotifications: async () => ({ items: [], unread: 0 }),
  postAttention: async () => ({ ok: true }),
  postNotificationsRead: async () => ({ ok: true, marked: 0 }),
  postVerdict: async (objectId: string, transition: string) => {
    h.verdicts.push({ objectId, transition })
    return { ok: true, replay: false, status: 'decided', eventId: 'ev-probe', closed: ['policy-verdict'], actions: [] }
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A doc the Library lists, whose shepherd holds an open verdict — the case the old
 *  filter DID render. */
function artifact(over: Partial<LibraryArtifact> = {}): LibraryArtifact {
  return {
    id: 'obj-doc-1',
    category: 'Reports & notes',
    title: 'A report with a shepherd',
    source: 'Daily digest',
    state: 'Awaiting decision',
    age: '2h ago',
    icon: 'report',
    kind: 'document',
    html: '<p>body</p>',
    needsHuman: true,
    verdict: { objectId: 'obj-rev-1', transition: 'decide', label: 'Your call', obligation: 'policy-verdict' },
    bodyAvailable: true,
    published: false,
    ...over,
  }
}

/** A gate on a plain Task with NO Library row — the case that was invisible. */
function bareItem(over: Partial<InboxItem> = {}): InboxItem {
  return {
    objectId: 'obj-task-probe',
    key: 'e2e-verdict',
    class: 'human-verdict',
    label: 'Your call on the policy',
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
    title: 'A1 probe · a fire that opened a human gate',
    type: 'decision-review',
    source: 'Scratch survey (scheduled)',
    verdict: { transition: 'decide', label: 'Your call' },
    ...over,
  }
}

function summaryWith(needsYou: number): Summary {
  return {
    loops: 1,
    artifacts: 1,
    needsYou,
    watching: 0,
    mirrors: 0,
    events: 10,
    pendingActions: 0,
    attention: 0,
    notifications: 0,
    unreadNotifications: 0,
    effectsInFlight: 0,
    sensing: { mirrors: 0, unobserved: 0, stale: 0, lastObservedAt: null },
    work: { awaiting: 0, inFlight: 0 },
    schedules: { armed: 1, overdue: 0 },
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(WorkspaceView))
  })
}

/** The rendered rows of the "Needs you" section, and the number its header shows. */
function needsYouSection() {
  const section = host!.querySelector('.needs-section')!
  const rows = [...section.querySelectorAll('.artifact-list > article')]
  const count = Number(section.querySelector('.section-heading span:last-of-type')?.textContent ?? 'NaN')
  return { section, rows, count }
}

beforeEach(() => {
  h.verdicts = []
  h.library = { categories: ['Reports & notes'], artifacts: [artifact()], needsYou: 1, total: 1, truncated: 0 }
  h.inbox = { items: [] }
  h.summary = summaryWith(1)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('the "Needs you" list is the inbox, not a Library filter', () => {
  it('renders a gate on an artifact-less Task, and counts it', async () => {
    // THE LIVE REPRO: three open obligations, only one of which the Library can see.
    h.inbox = {
      items: [
        { ...bareItem(), objectId: 'obj-rev-1', key: 'policy-verdict', reviews: 'obj-doc-1', title: 'A report with a shepherd' },
        bareItem({ objectId: 'obj-task-a1', title: 'A1 probe · a clock fire that opens a human gate' }),
        bareItem({ objectId: 'obj-task-b3', key: 'e2e-verdict', title: 'B3 probe · close refused' }),
      ],
    }
    h.summary = summaryWith(3)
    await render()

    const { rows, count } = needsYouSection()
    expect(rows).toHaveLength(3)
    expect(count).toBe(3)
    // The two previously-invisible ones are on screen, by name.
    const text = rows.map((r) => r.textContent ?? '').join('\n')
    expect(text).toContain('A1 probe · a clock fire that opens a human gate')
    expect(text).toContain('B3 probe · close refused')
    // …and ACTIONABLE: every row offers the transition that discharges it.
    for (const row of rows) expect(row.querySelector('button.verdict-button')).toBeTruthy()
  })

  it('keeps the header count equal to the rendered list, whatever the inbox holds', async () => {
    for (const n of [0, 1, 4]) {
      h.inbox = { items: Array.from({ length: n }, (_, i) => bareItem({ objectId: `obj-task-${i}`, title: `owed ${i}` })) }
      h.summary = summaryWith(n)
      await render()
      const { rows, count } = needsYouSection()
      expect(rows).toHaveLength(n)
      expect(count).toBe(n)
      expect(count).toBe(h.summary.needsYou)
      act(() => root?.unmount())
      host?.remove()
    }
  })

  it('renders an artifact-backed item as its full Library row, once', async () => {
    h.inbox = { items: [{ ...bareItem(), objectId: 'obj-rev-1', key: 'policy-verdict', reviews: 'obj-doc-1' }] }
    await render()

    const { rows } = needsYouSection()
    expect(rows).toHaveLength(1)
    // The CONTENT row, with its preview affordance - not the minimal fallback.
    expect(rows[0]!.id).toBe('artifact-obj-doc-1')
    expect(rows[0]!.className).toContain('is-previewable')
    // And it is not ALSO listed under its category below: one obligation, one row.
    expect(host!.querySelectorAll('#artifact-obj-doc-1')).toHaveLength(1)
  })

  it('sends the verdict on the TASK that owes it, for a row with no artifact', async () => {
    h.inbox = { items: [bareItem({ objectId: 'obj-task-probe' })] }
    h.summary = summaryWith(1)
    await render()

    const button = needsYouSection().rows[0]!.querySelector('button.verdict-button') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    // The write path is the same one every other verdict takes: the object that
    // holds the obligation, and the transition the server resolved for it.
    expect(h.verdicts).toEqual([{ objectId: 'obj-task-probe', transition: 'decide' }])
  })

  it('says plainly when an obligation has no declared verdict, instead of a dead button', async () => {
    const { verdict: _drop, ...noVerdict } = bareItem()
    h.inbox = { items: [noVerdict] }
    await render()
    const row = needsYouSection().rows[0]!
    expect(row.querySelector('button.verdict-button')).toBeNull()
    expect(row.textContent).toContain('No verdict declared')
  })
})
