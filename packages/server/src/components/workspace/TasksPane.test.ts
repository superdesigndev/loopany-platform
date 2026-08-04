// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskCard, TasksView, TaskView } from './api'
import { TasksPane } from './TasksPane'
import { TASKS_VIEW_STORAGE_KEY } from './taskList'

/**
 * THE TASKS SCREEN, driven the way a person drives it.
 *
 * Four things are pinned here because all four are captain rulings rather than
 * implementation details: the list is what you land on and it is grouped by loop,
 * the layout choice survives a remount, EVERY write happens from the drawer
 * (rows and cards only open it), and there is NO CLOSE BUTTON anywhere — a task
 * ends when its watcher closes it, so the composer that tells the watcher what
 * to do is what replaced it. The fifth is an accessibility promise: closing the
 * drawer hands the keyboard back to the row that opened it.
 *
 * The network is a stub router over the real endpoints, so the assertions are
 * about which request the UI makes, not about a mocked module's call count.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TASKS: TasksView = {
  cursorSeq: 12,
  now: '2026-08-04T09:00:00.000Z',
  truncated: false,
  counts: { question: 1, total: 1 },
  loops: [{ id: 'loop-a', title: 'Alpha watch' }, { id: 'loop-b', title: 'Beta watch' }],
  columns: [
    {
      key: 'waiting', label: 'Waiting on you', rule: 'A question is pending.',
      tasks: [{
        id: 'task-ask', title: 'Revert or wait?', status: 'open', followUpAt: null, pendingQuestion: 'Revert or wait?',
        watcher: 'loop-a', watcherLoop: { id: 'loop-a', title: 'Alpha watch' }, createdByLoop: 'loop-a',
        creator: { id: 'loop-a', title: 'Alpha watch' }, createdAt: '', updatedAt: '', due: false, column: 'waiting',
      }],
    },
    {
      key: 'due', label: 'Due', rule: 'The follow-up date has arrived.',
      tasks: [{
        id: 'task-due', title: 'Nightly backup check', status: 'open', followUpAt: '2026-08-01T09:00:00.000Z',
        pendingQuestion: null, watcher: 'loop-a', watcherLoop: { id: 'loop-a', title: 'Alpha watch' },
        createdByLoop: 'loop-a', creator: { id: 'loop-a', title: 'Alpha watch' },
        createdAt: '', updatedAt: '', due: true, column: 'due',
      }],
    },
    {
      key: 'watched', label: 'Watched', rule: 'A loop is watching.',
      tasks: [{
        id: 'task-held', title: 'Follow the migration', status: 'open', followUpAt: null, pendingQuestion: null,
        watcher: 'loop-b', watcherLoop: { id: 'loop-b', title: 'Beta watch' }, createdByLoop: 'loop-b',
        creator: { id: 'loop-b', title: 'Beta watch' }, createdAt: '', updatedAt: '', due: false, column: 'watched',
      }],
    },
    { key: 'closed', label: 'Closed', rule: 'Closed is one-way.', tasks: [] },
  ],
}

/** One external item on the held task, so the drawer's External-items section
 *  has something real to render — kind, coords, note, and no state. */
const MIRROR = {
  id: 'mirror-3f9a21c04b7e', externalKind: 'github-pr', coords: 'superdesigndev/loopany-platform#57',
  note: 'seed article PR', href: 'https://github.com/superdesigndev/loopany-platform/pull/57',
  attachedTo: ['task-held'], createdByLoop: 'loop-b', createdAt: '', updatedAt: '2026-08-04T08:00:00.000Z',
}

const taskView = (id: string): TaskView => {
  const card: TaskCard = TASKS.columns.flatMap((column) => column.tasks).find((task) => task.id === id)!
  return {
    cursorSeq: 12,
    task: {
      id: card.id, title: card.title, body: '', status: card.status, payload: {}, pendingQuestion: card.pendingQuestion,
      watcher: card.watcher, followUpAt: card.followUpAt, createdAt: '', updatedAt: '', closedAt: null,
    },
    execution: {}, mirrors: id === 'task-held' ? [MIRROR] : [], due: card.due,
    creator: card.creator ?? null, watcherLoop: card.watcherLoop ?? null, timeline: [], runs: [],
  }
}

let calls: { method: string; url: string; body: unknown }[] = []
let root: Root | null = null
let host: HTMLElement | null = null

function render(selected: string | null, onSelect: (id: string | null) => void) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(TasksPane, { selected, onSelect, onOpenLoop: () => {} })))
}

/** Re-render with a new `selected`, the way the shell does. */
async function rerender(selected: string | null, onSelect: (id: string | null) => void) {
  await act(async () => {
    root!.render(createElement(TasksPane, { selected, onSelect, onOpenLoop: () => {} }))
  })
}

/** React tracks the last value it wrote to an input; assigning `.value`
 *  directly makes the change event look like a no-op and the handler never
 *  fires. Going through the prototype setter is what a real keystroke does. */
async function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const text = () => host!.textContent ?? ''
const buttons = () => [...host!.querySelectorAll('button')]
const byText = (label: string) => buttons().find((button) => (button.textContent ?? '').trim() === label)
const click = async (element: Element | null | undefined) => {
  expect(element, 'element to click').toBeTruthy()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  calls = []
  window.localStorage.clear()
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.startsWith('/api/views/tasks')) return json(TASKS)
    if (url.startsWith('/api/views/task/')) return json(taskView(decodeURIComponent(url.split('/').pop()!)))
    if (url.endsWith('/verdict')) return json({ run: { id: 'run-1', alreadyQueued: false } })
    if (url.endsWith('/directive')) return json({ run: { id: 'run-2', alreadyQueued: false } })
    return json({ changed: true })
  })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.unstubAllGlobals()
})

function json(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response
}

async function mount(selected: string | null = null, onSelect: (id: string | null) => void = () => {}) {
  render(selected, onSelect)
  await act(async () => {})
}

describe('the default view is a list, grouped by loop', () => {
  it('lands on the list with a section per loop, and no pool section', async () => {
    await mount()
    const headings = [...host!.querySelectorAll('h2')].map((h) => h.textContent)
    expect(headings).toEqual(['Alpha watch', 'Beta watch'])
    expect(host!.querySelector('.board')).toBeNull()
    expect(byText('List')!.getAttribute('aria-pressed')).toBe('true')
  })

  /** Every task shows the loop on the hook for it — in both views. */
  it('names a watcher on every card, and never the word unclaimed', async () => {
    await mount()
    expect(text()).not.toMatch(/unclaimed/i)
    await click(byText('Board'))
    const meta = [...host!.querySelectorAll('.board-card-meta')].map((cell) => cell.textContent ?? '')
    expect(meta.length).toBe(3)
    for (const cell of meta) expect(cell).toMatch(/Alpha watch|Beta watch/)
    expect(text()).not.toMatch(/unclaimed/i)
  })

  it('keeps the question and overdue badges on the rows', async () => {
    await mount()
    const badges = [...host!.querySelectorAll('.artifact-badges')].map((cell) => cell.textContent)
    expect(badges).toContain('question')
    expect(badges).toContain('overdue')
  })

  it('shows the safety-floor counter in BOTH views, and only the surviving branch', async () => {
    await mount()
    for (const view of ['List', 'Board']) {
      await click(byText(view))
      const strip = host!.querySelector('.count-strip')!.textContent ?? ''
      expect(strip).toMatch(/questions waiting on you/)
      expect(strip).not.toMatch(/orphan|unwatched/i)
    }
  })
})

describe('the layout toggle is remembered', () => {
  it('persists the board choice and lands there on the next mount', async () => {
    await mount()
    await click(byText('Board'))
    expect(host!.querySelector('.board')).not.toBeNull()
    expect(window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY)).toBe('board')

    act(() => root!.unmount())
    host!.remove()
    await mount()
    expect(host!.querySelector('.board')).not.toBeNull()
    expect(byText('Board')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('goes back to the list, and remembers that too', async () => {
    window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, 'board')
    await mount()
    await click(byText('List'))
    expect(host!.querySelector('.board')).toBeNull()
    expect(window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY)).toBe('list')
  })
})

describe('rows and cards are entrances — nothing else', () => {
  it('offers no write control on a row', async () => {
    await mount()
    expect(host!.querySelector('.artifact-row select')).toBeNull()
    expect(buttons().some((button) => /hand off|Send/.test(button.textContent ?? ''))).toBe(false)
  })

  it('offers no write control on a card either', async () => {
    await mount()
    await click(byText('Board'))
    expect(host!.querySelector('.board-card select')).toBeNull()
    expect(host!.querySelector('.board-card-actions')).toBeNull()
  })

  it('opens the drawer from a row, and from a card', async () => {
    const onSelect = vi.fn()
    await mount(null, onSelect)
    await click(host!.querySelector('.artifact-row'))
    expect(onSelect).toHaveBeenCalledWith('task-ask')

    onSelect.mockClear()
    await click(byText('Board'))
    await click(host!.querySelector('.board-card-title'))
    expect(onSelect).toHaveBeenCalledWith('task-ask')
  })
})

describe('the drawer is the one write surface', () => {
  const wrote = (method: string, match: RegExp) => calls.find((call) => call.method === method && match.test(call.url))

  it('hands a task to another loop through the picker — never back to nothing', async () => {
    await mount('task-held')
    const select = host!.querySelector<HTMLSelectElement>('.task-actions select')!
    // The loop already watching it is not offered: that write changes nothing.
    expect([...select.options].map((option) => option.value)).toEqual(['', 'loop-a'])
    await act(async () => {
      select.value = 'loop-a'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(wrote('PATCH', /\/api\/tasks\/task-held$/)!.body).toEqual({ watcher: 'loop-a' })
  })

  // RELEASE IS GONE. `watcher: null` is a kernel refusal, so an affordance for
  // it would advertise a write that cannot succeed.
  it('offers no release, and sends no null watcher', async () => {
    await mount('task-held')
    expect(byText('release')).toBeUndefined()
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false)
  })

  /**
   * THE CLOSE ACTION IS GONE (captain direction 2026-08-04). A task ends when
   * its watcher closes it, so the drawer offers no way for a person to settle
   * the record while the world it describes carries on unchanged.
   */
  it('offers no close control, and never posts to /close', async () => {
    for (const id of ['task-held', 'task-ask']) {
      await mount(id)
      expect(byText('close…')).toBeUndefined()
      expect(buttons().some((button) => /close/i.test(button.textContent ?? '') && !/Close$/.test(button.getAttribute('aria-label') ?? ''))).toBe(false)
      expect(host!.querySelector('.note-scrim')).toBeNull()
      act(() => root!.unmount())
      host!.remove()
    }
    expect(calls.some((call) => /\/close$/.test(call.url))).toBe(false)
  })

  // A task that is asking cannot be closed by anyone, so answering IS the move —
  // and it is available without leaving for the Inbox.
  it('answers a pending question through the composer', async () => {
    await mount('task-ask')
    await type(host!.querySelector<HTMLTextAreaElement>('textarea')!, 'Revert it.')
    await click(byText('Send answer'))
    expect(wrote('POST', /\/verdict$/)!.body).toEqual({ answer: 'Revert it.' })
    expect(text()).toMatch(/answer recorded/)
  })

  /**
   * THE OTHER MODE, and the one that replaces close: with no question pending
   * the same composer leaves a DIRECTIVE, which queues a run for the watcher to
   * act on. Same box, same free text, different endpoint — the person is told
   * which conversation they are in by the label and the button, not by choosing
   * a control.
   */
  it('leaves a directive when no question is pending, on the same composer', async () => {
    await mount('task-held')
    // The mode is legible without reading code: the composer names the watcher
    // and the submit button says what it will do.
    expect(text()).toMatch(/Tell Beta watch/)
    expect(byText('Approve')).toBeUndefined()
    await type(host!.querySelector<HTMLTextAreaElement>('textarea')!, 'Drop this bet — close the PR, then close the task.')
    await click(byText('Send directive'))
    expect(wrote('POST', /\/directive$/)!.body).toEqual({ directive: 'Drop this bet — close the PR, then close the task.' })
    expect(text()).toMatch(/directive left/)
    expect(text()).toMatch(/run-2/)
  })
})

/**
 * EXTERNAL ITEMS — the mirrors attached to the task, rendered as what they are:
 * where to look. The assertion that matters most is the NEGATIVE one — no
 * status is shown, because a mirror has none and the kernel has nowhere to keep
 * one.
 */
describe('the drawer shows what the task depends on outside the system', () => {
  it('renders each mirror as kind, coords and note, with the coords as the link', async () => {
    await mount('task-held')
    const section = [...host!.querySelectorAll('.preview-section')].find((s) => /External items/.test(s.textContent ?? ''))!
    expect(section).toBeTruthy()
    expect(section.textContent).toMatch(/superdesigndev\/loopany-platform#57/)
    expect(section.textContent).toMatch(/seed article PR/)
    expect(section.textContent).toMatch(/github-pr/)
    const link = section.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://github.com/superdesigndev/loopany-platform/pull/57')
    // Off-site, so it opens away from the app and carries no referrer or opener.
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toMatch(/noopener/)
  })

  it('shows no external STATE, because a mirror is a pointer and never a cache', async () => {
    await mount('task-held')
    const section = [...host!.querySelectorAll('.preview-section')].find((s) => /External items/.test(s.textContent ?? ''))!
    expect(section.textContent).not.toMatch(/open|merged|closed|draft|stale/i)
  })

  it('says so plainly when nothing external is attached', async () => {
    await mount('task-ask')
    const section = [...host!.querySelectorAll('.preview-section')].find((s) => /External items/.test(s.textContent ?? ''))!
    expect(section.textContent).toMatch(/Nothing external is attached/)
  })
})

describe('the drawer hands the keyboard back', () => {
  it('restores focus to the row that opened it', async () => {
    let selected: string | null = null
    const onSelect = (id: string | null) => { selected = id }
    await mount(null, onSelect)
    const row = host!.querySelector<HTMLButtonElement>('.artifact-row')!
    await click(row)
    await rerender(selected, onSelect)
    expect(host!.querySelector('.artifact-preview')).not.toBeNull()

    await click(host!.querySelector('.preview-close')!)
    await rerender(selected, onSelect)
    expect(host!.querySelector('.artifact-preview')).toBeNull()
    expect(document.activeElement).toBe(row)
  })
})
