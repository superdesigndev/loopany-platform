// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { postRunNow, ViewError } from './api'
import { LoopsPane } from './LoopsPane'

/**
 * RUN NOW — the workspace Loops screen's one write (unit 11).
 *
 * Two things are worth pinning and they are different in kind. The first is the
 * ACTION PATH: the button must reach `POST /api/loops/:id/run-now` and hand the
 * queue's own answer back, including the `alreadyQueued` case the one-queued-run
 * discipline produces. Generic server refusals remain rendered verbatim — code,
 * sentence and hint — instead of being restated in client copy that could drift.
 *
 * The fixture loop is PAUSED on purpose (captain ruling 2026-08-04): pause
 * governs the cadence, so the button fires a parked loop for real and the screen
 * has nothing special to say about it. Both halves are driven through the real
 * component with a stubbed `fetch` rather than asserted against the source,
 * because "the button is offered" and "the hint reached the screen" are both
 * rendering facts.
 *
 * NB the source-reading guard at the bottom keeps its path in a VARIABLE — Vite
 * statically rewrites the literal `new URL('./x', import.meta.url)` form into an
 * asset URL, which `fileURLToPath` then rejects.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SERVER_REFUSAL = {
  error: {
    code: 'NOT_FOUND',
    message: 'loop-7f3a91 is no longer in this production team',
    hint: 'refresh the production loop roster',
  },
}

const loopRow = (over: Record<string, unknown> = {}) => ({
  id: 'loop-7f3a91',
  title: 'Nightly backup check',
  status: 'paused',
  cron: '0 7 * * *',
  timezone: 'UTC',
  cronText: 'every day at 07:00',
  nextFire: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  health: { lastOutcome: 'ok', lastRunAt: '2026-08-03T07:00:00.000Z', consecutiveFailures: 0, runs7d: { success: 3, failure: 0 }, costs7d: { usd: 0.12 } },
  openTasks: 0,
  questionsWaiting: 0,
  ...over,
})

const loopView = (over: Record<string, unknown> = {}) => ({
  cursorSeq: 12,
  loop: { ...loopRow(over), workdir: '/srv/backups', body: 'Check the backup ran.', payload: {} },
  health: loopRow().health,
  charterHistory: [],
  openTasks: { watching: [], created: [], questions: [] },
  recentRuns: [],
  events: [],
})

/** A `fetch` stub routed by URL. Returns the run-now responses in order, so a
 *  test can stage "refused, then accepted" without re-stubbing mid-flight. */
function stubFetch(runNow: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string }[] = []
  const json = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) } as Response)
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.includes('/run-now')) {
      const next = runNow.shift() ?? { status: 200, body: { queued: true, alreadyQueued: false, run: null } }
      return json(next.status, next.body)
    }
    if (url.includes('/api/views/loop/')) return json(200, loopView())
    if (url.includes('/api/views/loops')) return json(200, { cursorSeq: 12, loops: [loopRow()] })
    return json(200, {})
  })
  vi.stubGlobal('fetch', impl)
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

/** Mount the Loops screen with the loop's drawer already open. */
async function mountDrawer() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(LoopsPane, { selected: 'loop-7f3a91', onSelect: () => {}, onOpenTask: () => {} }))
  })
  return host
}

const runNowButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((button) => /run now/i.test(button.textContent ?? ''))

describe('the action path', () => {
  it('posts to the loop\'s run-now route and returns the queue\'s answer', async () => {
    const calls = stubFetch([{ status: 200, body: { queued: true, alreadyQueued: false, run: { id: 'run-4c1e', state: 'queued', reason: 'manual' } } }])

    await expect(postRunNow('loop-7f3a91')).resolves.toEqual({
      queued: true,
      alreadyQueued: false,
      run: { id: 'run-4c1e', state: 'queued', reason: 'manual' },
    })
    expect(calls).toEqual([{ url: '/api/loops/loop-7f3a91/run-now', method: 'POST' }])
  })

  it('encodes the loop id rather than splicing it into the path raw', async () => {
    const calls = stubFetch([{ status: 200, body: { queued: true, alreadyQueued: false, run: null } }])
    await postRunNow('loop a/b')
    expect(calls[0]!.url).toBe('/api/loops/loop%20a%2Fb/run-now')
  })

  it('surfaces a refusal as a ViewError carrying the code, sentence and hint', async () => {
    stubFetch([{ status: 404, body: SERVER_REFUSAL }, { status: 404, body: SERVER_REFUSAL }])
    await expect(postRunNow('loop-7f3a91')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: SERVER_REFUSAL.error.message,
      hint: SERVER_REFUSAL.error.hint,
    })
    await expect(postRunNow('loop-7f3a91')).rejects.toBeInstanceOf(ViewError)
  })
})

describe('the drawer offers the fire and reports what the queue said', () => {
  it('renders the button and, on a fresh queue, names the run', async () => {
    stubFetch([{ status: 200, body: { queued: true, alreadyQueued: false, run: { id: 'run-4c1e', state: 'queued', reason: 'manual' } } }])
    const el = await mountDrawer()

    const button = runNowButton(el)
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(el.textContent).toContain('Queued.')
    expect(el.textContent).toContain('run-4c1e')
  })

  it('reports an already-queued run as the one that will carry this fire', async () => {
    stubFetch([{ status: 200, body: { queued: false, alreadyQueued: true, run: { id: 'run-0b22', state: 'queued', reason: 'clock' } } }])
    const el = await mountDrawer()
    await act(async () => runNowButton(el)!.click())

    expect(el.textContent).toContain('already had a run queued')
    expect(el.textContent).toContain('run-0b22')
  })
})

describe('a paused loop fires directly — pause governs the cadence, not the button', () => {
  it('offers the button on a paused loop rather than pre-hiding it', async () => {
    stubFetch([])
    const el = await mountDrawer()
    const button = runNowButton(el)
    expect(el.textContent).toContain('paused')
    expect(button).toBeTruthy()
    expect(button!.disabled).toBe(false)
  })

  it('queues the run and reports it, with no refusal on screen', async () => {
    stubFetch([{ status: 200, body: { queued: true, alreadyQueued: false, run: { id: 'run-5e77', state: 'queued', reason: 'manual' } } }])
    const el = await mountDrawer()
    await act(async () => runNowButton(el)!.click())

    expect(el.querySelector('.ws-refusal')).toBeNull()
    expect(el.textContent).toContain('Queued.')
    expect(el.textContent).toContain('run-5e77')
    // The loop is still paused, and the screen still says so — firing did not
    // resume it and the drawer never claims it did.
    expect(el.textContent).toContain('paused')
  })
})

describe('a server refusal stays visible and the action remains retryable', () => {
  it('renders the refusal verbatim — code, sentence and hint', async () => {
    stubFetch([{ status: 404, body: SERVER_REFUSAL }])
    const el = await mountDrawer()
    await act(async () => runNowButton(el)!.click())

    const refusal = el.querySelector('.ws-refusal')
    expect(refusal).toBeTruthy()
    expect(refusal!.textContent).toContain('NOT_FOUND')
    expect(refusal!.textContent).toContain(SERVER_REFUSAL.error.message)
    expect(refusal!.textContent).toContain(SERVER_REFUSAL.error.hint)
    // The refusal replaces nothing: the act stays available.
    expect(runNowButton(el)!.disabled).toBe(false)
  })

  it('clears a stale refusal when the loop is fired again and accepted', async () => {
    stubFetch([
      { status: 404, body: SERVER_REFUSAL },
      { status: 200, body: { queued: true, alreadyQueued: false, run: { id: 'run-9d40', state: 'queued', reason: 'manual' } } },
    ])
    const el = await mountDrawer()
    await act(async () => runNowButton(el)!.click())
    expect(el.querySelector('.ws-refusal')).toBeTruthy()

    await act(async () => runNowButton(el)!.click())
    expect(el.querySelector('.ws-refusal')).toBeNull()
    expect(el.textContent).toContain('run-9d40')
  })
})

describe('the production lifecycle stays server-authored', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  /** Bounded to each function: the file holds several, and a slice running to
   *  EOF would sweep in whatever was appended after it. */
  const fn = (source: string, name: string) => {
    const start = source.indexOf(`function ${name}(`)
    expect(start, `${name} must exist`).toBeGreaterThan(-1)
    const next = source.indexOf('\nfunction ', start + 1)
    return source.slice(start, next === -1 ? undefined : next)
  }

  it('never gates the fire on a status the client read', () => {
    expect(fn(read('./LoopsPane.tsx'), 'RunNow')).not.toMatch(/status\s*[!=]==?\s*['"](active|paused|retired)['"]/)
  })

  it('ports pause/resume without counting watched tasks in the client', () => {
    const pane = read('./LoopsPane.tsx')
    const lifecycle = fn(pane, 'Lifecycle')
    expect(lifecycle).toContain('postLifecycle')
    expect(lifecycle).not.toMatch(/openTasks\s*[><=]/)

    const api = read('./api.ts')
    expect(api).toMatch(/'pause'\s*\|\s*'resume'/)
    expect(api).toContain('/api/loops/${encodeURIComponent(loopId)}/${verb}')
  })
})
