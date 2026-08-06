// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LoopsPane } from './LoopsPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ID = 'loop-parity-7f3a91'
const RUN = 'run-parity-4c1e'

const health = {
  lastOutcome: 'success', lastRunAt: '2026-08-06T01:00:00.000Z', consecutiveFailures: 1,
  runs7d: { success: 4, failure: 1 }, costs7d: { usd: 1.26 },
}

const recentRuns = [
  {
    id: RUN, state: 'done', scope: 'routine', reason: 'clock', role: 'exec', outcome: 'ok', status: 'success',
    startedAt: '2026-08-06T01:00:00.000Z', finishedAt: '2026-08-06T01:02:00.000Z', durationMs: 120_000,
    reportDoc: null, summary: 'Found and fixed one stale backup.', costUsd: 0.42, attempts: 1, progress: null, error: null,
    metrics: { score: 91, failures: 1 }, sessionId: 'session-parity-abcdef123456', artifacts: [{ path: 'reports/backup.md', kind: 'created' }],
  },
  {
    id: 'run-parity-old', state: 'done', scope: 'routine', reason: 'clock', role: 'exec', outcome: 'ok', status: 'success',
    startedAt: '2026-08-05T01:00:00.000Z', finishedAt: '2026-08-05T01:01:00.000Z', durationMs: 60_000,
    reportDoc: null, summary: 'Backups healthy.', costUsd: 0.21, attempts: 1, progress: null, error: null,
    metrics: { score: 82, failures: 0 }, sessionId: null, artifacts: null,
  },
]

const listRow = {
  id: ID, title: 'Backup steward', status: 'active', cron: '0 7 * * *', timezone: 'UTC', cronText: 'daily 07:00',
  nextFire: '2026-08-07T07:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-06T01:02:00.000Z',
  health, openTasks: 3, questionsWaiting: 0,
}

const loopView = {
  cursorSeq: 21,
  loop: {
    ...listRow, enabled: true, notify: 'auto', channelId: 'channel-1', model: null, agent: 'claude-code', allowControl: true,
    ui: '<section><h3>Daily score board</h3><p>Latest score: {{score}}</p></section><loop-chart series="score:Score:%"></loop-chart><loop-embed file="reports/*.md"></loop-embed><loop-calendar></loop-calendar><loop-kanban></loop-kanban>',
    stateSchema: [{ key: 'score', label: 'Quality score', unit: '%' }], hasWorkflow: true,
    workdir: '/srv/backups', body: '## Spec\n\nVerify every backup.', payload: {}, source: 'prod',
  },
  health, runCount: 2, totalCostUsd: 0.63, charterHistory: [],
  openTasks: { watching: [], created: [], questions: [] }, recentRuns,
  channels: [{ id: 'channel-1', type: 'web-push', name: 'Ops phone' }], mirrors: [], events: [],
}

const runView = {
  cursorSeq: 22,
  loop: { id: ID, title: 'Backup steward' },
  run: {
    ...recentRuns[0],
    usage: { inputTokens: 1200, outputTokens: 260, cacheReadTokens: 800, numTurns: 3 },
    control: [{ command: 'reschedule', args: { minutes: 30 }, result: 'accepted', detail: 'next run moved' }],
    transcript: [
      { kind: 'text', text: 'Inspecting the backup manifest.' },
      { kind: 'tool', name: 'Read', input: '{"file_path":"reports/manifest.json"}' },
      { kind: 'result', text: '3 files checked' },
    ],
  },
}

type Call = { url: string; method: string; body?: Record<string, unknown> }

function stubFetch() {
  const calls: Call[] = []
  const response = (body: unknown, status = 200) => Promise.resolve({
    ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)),
  } as Response)
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ url, method, body })
    if (url === `/api/views/run/${RUN}`) return response(runView)
    if (url === `/api/loops/${ID}/pause`) return response({
      changed: true, loop: { id: ID, status: 'paused' },
      warning: { code: 'TASKS_STILL_WATCHED', openTasks: 3, message: `${ID} was paused while still watching 3 open tasks.`, hint: 'Transfer or close them.' },
    })
    if (url === `/api/loops/${ID}/config`) return response({ changed: true, config: body })
    if (url === `/api/views/loop/${ID}`) return response(loopView)
    if (url === '/api/views/loops') return response({ cursorSeq: 21, loops: [listRow] })
    return response({ error: { code: 'NOT_FOUND', message: url } }, 404)
  }))
  return calls
}

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root && host) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
  vi.unstubAllGlobals()
})

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(LoopsPane, { selected: ID, onSelect: () => {}, onOpenTask: () => {} }))
  })
  return host
}

const button = (el: HTMLElement, text: RegExp) => [...el.querySelectorAll('button')].find((candidate) => text.test(candidate.textContent ?? ''))

function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function selectValue(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('workspace loop management parity', () => {
  it('renders history, metric trends and safe custom panels, then opens the complete run detail', async () => {
    stubFetch()
    const el = await mount()

    expect(el.textContent).toContain('Run history · 2')
    expect(el.textContent).toContain('Quality score')
    expect(el.textContent).toContain('91%')
    expect(el.textContent).toContain('Daily score board')
    expect(el.textContent).not.toContain('data source is retired')
    expect(el.innerHTML).not.toMatch(/loop-(embed|calendar|kanban)/)

    const run = el.querySelector<HTMLButtonElement>(`button[aria-label="Open run ${RUN}"]`)
    expect(run).toBeTruthy()
    await act(async () => run!.click())

    expect(el.textContent).toContain('Execution trace')
    expect(el.textContent).toContain('Inspecting the backup manifest.')
    expect(el.textContent).toContain('3 files checked')
    expect(el.textContent).toContain('Found and fixed one stale backup.')
    expect(el.textContent).toContain('$0.42')
    expect(el.textContent).toContain('session-parity-abcdef123456')
    expect(el.textContent).toContain('reports/backup.md')
  })

  it('pauses with the server warning and round-trips the owner-managed settings', async () => {
    const calls = stubFetch()
    const el = await mount()

    await act(async () => button(el, /^Pause$/)!.click())
    expect(el.textContent).toContain('paused while still watching 3 open tasks')
    expect(el.textContent).toContain('Transfer or close them.')
    expect(calls).toContainEqual({ url: `/api/loops/${ID}/pause`, method: 'POST', body: {} })

    await act(async () => button(el, /^Edit settings$/)!.click())
    const labels = [...el.querySelectorAll<HTMLLabelElement>('.ws-loop-form label')]
    const control = (name: string) => labels.find((label) => label.textContent?.startsWith(name))!.querySelector('input, select')!
    await act(async () => {
      inputValue(control('Name') as HTMLInputElement, 'Backup steward daily')
      inputValue(control('Schedule') as HTMLInputElement, '15 9 * * *')
      inputValue(control('Timezone') as HTMLInputElement, 'Asia/Singapore')
      selectValue(control('Notify') as HTMLSelectElement, 'never')
      selectValue(control('Coding agent') as HTMLSelectElement, 'codex')
      inputValue(control('Model') as HTMLInputElement, 'gpt-5.6-codex')
    })
    await act(async () => button(el, /^Save settings$/)!.click())

    expect(el.textContent).toContain('Saved.')
    const config = calls.find((call) => call.url === `/api/loops/${ID}/config`)
    expect(config).toEqual({
      url: `/api/loops/${ID}/config`, method: 'PATCH', body: {
        name: 'Backup steward daily', cron: '15 9 * * *', timezone: 'Asia/Singapore',
        notify: 'never', channelId: 'channel-1', model: 'gpt-5.6-codex', agent: 'codex',
      },
    })
  })
})
