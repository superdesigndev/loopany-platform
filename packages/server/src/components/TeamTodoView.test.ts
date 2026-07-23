// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TodoItemView, TodoListView, TodoOutput } from '../types'

const { patchTodo, getTodoOutput } = vi.hoisted(() => ({
  patchTodo: vi.fn(async () => ({ ok: true })),
  getTodoOutput: vi.fn(async (): Promise<TodoOutput> => ({ kind: 'markdown', content: '# Report body' })),
}))

vi.mock('../server/loopApi', () => ({ patchTodo, getTodoOutput }))
// The router Link is out of scope for the panel test.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => createElement('a', {}, children as never),
}))

import { TodoPanel } from './TeamTodoView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item = (over: Partial<TodoItemView>): TodoItemView => ({
  id: 'i1',
  loopId: 'loop1',
  loopName: 'Digest',
  runId: 'r1',
  machineId: 'm1',
  machineName: 'Laptop',
  role: 'exec',
  outcome: 'exec',
  runStatus: 'new',
  failed: false,
  title: 'Alpha item',
  producedAt: '2026-07-20T08:00:00.000Z',
  status: 'new',
  priority: 'medium',
  assigneeUserId: null,
  assigneeLabel: null,
  archived: false,
  ...over,
})

const view = (items: TodoItemView[], over: Partial<TodoListView> = {}): TodoListView => ({
  items,
  members: [{ userId: 'u1', label: 'Ada' }],
  canEdit: true,
  ...over,
})

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  patchTodo.mockClear()
  getTodoOutput.mockClear()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(data: TodoListView, onChanged?: () => void) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(TodoPanel, { data, onChanged }))
  })
  return host!
}

it('renders rows and Active/Archive tab counts', async () => {
  const el = await mount(
    view([item({ id: 'a', title: 'Active one' }), item({ id: 'b', title: 'Archived one', archived: true })]),
  )
  expect(el.textContent).toContain('Active one')
  // The archived item is on the other tab, not shown in Active.
  expect(el.textContent).not.toContain('Archived one')
  const tabs = Array.from(el.querySelectorAll('button')).filter((b) => /^(Active|Archive)\s/.test(b.textContent ?? ''))
  expect(tabs.find((b) => b.textContent?.startsWith('Active'))?.textContent).toContain('1')
  expect(tabs.find((b) => b.textContent?.startsWith('Archive'))?.textContent).toContain('1')
})

it('an inline status edit calls patchTodo and onChanged', async () => {
  const onChanged = vi.fn()
  const el = await mount(view([item({ id: 'a' })]), onChanged)
  const statusSelect = Array.from(el.querySelectorAll('select')).find(
    (s) => s.getAttribute('aria-label') === 'Change status',
  ) as HTMLSelectElement
  await act(async () => {
    statusSelect.value = 'done'
    statusSelect.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(patchTodo).toHaveBeenCalledWith({ data: { id: 'a', patch: { status: 'done' } } })
  expect(onChanged).toHaveBeenCalled()
})

it('the mark-done checkbox sets status done', async () => {
  const el = await mount(view([item({ id: 'a' })]))
  const cb = el.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => {
    cb.click()
  })
  expect(patchTodo).toHaveBeenCalledWith({ data: { id: 'a', patch: { status: 'done' } } })
})

it('archive moves an item to the Archive tab', async () => {
  const el = await mount(view([item({ id: 'a' })]))
  const archiveBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Archive' && !/^Archive\s/.test(b.textContent ?? '')) as HTMLButtonElement
  await act(async () => archiveBtn.click())
  expect(patchTodo).toHaveBeenCalledWith({ data: { id: 'a', patch: { archived: true } } })
})

it('expanding a row renders the HTML report in a sandboxed iframe', async () => {
  getTodoOutput.mockResolvedValueOnce({ kind: 'markdown', content: '# Report body\n\nhello' })
  const el = await mount(view([item({ id: 'a', title: 'Open me' })]))
  const caret = el.querySelector('button[aria-label="Expand item"]') as HTMLButtonElement
  await act(async () => {
    caret.click()
  })
  await act(async () => {})
  expect(getTodoOutput).toHaveBeenCalledWith({ data: { id: 'a' } })
  const iframe = el.querySelector('iframe') as HTMLIFrameElement
  expect(iframe).toBeTruthy()
  // Sandbox posture unchanged: scripts allowed, NO same-origin.
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
  const srcdoc = iframe.getAttribute('srcdoc') ?? ''
  expect(srcdoc).toContain('<!doctype html>')
  expect(srcdoc).toContain('Report body')
  // Fullscreen affordance present.
  expect(el.querySelector('button[aria-label="Open report fullscreen"]')).toBeTruthy()
})

it("renders a run's HTML artifact as-is (no markdown wrapping)", async () => {
  const raw = '<!doctype html><html><body><h1>Artifact report</h1></body></html>'
  getTodoOutput.mockResolvedValueOnce({ kind: 'html', html: raw })
  const el = await mount(view([item({ id: 'a' })]))
  const caret = el.querySelector('button[aria-label="Expand item"]') as HTMLButtonElement
  await act(async () => caret.click())
  await act(async () => {})
  const iframe = el.querySelector('iframe') as HTMLIFrameElement
  expect(iframe.getAttribute('srcdoc')).toBe(raw)
})

it('opening fullscreen mounts a full-viewport sandboxed frame with a close control', async () => {
  getTodoOutput.mockResolvedValueOnce({ kind: 'markdown', content: '# Full me' })
  const el = await mount(view([item({ id: 'a' })]))
  await act(async () => (el.querySelector('button[aria-label="Expand item"]') as HTMLButtonElement).click())
  await act(async () => {})
  await act(async () => (el.querySelector('button[aria-label="Open report fullscreen"]') as HTMLButtonElement).click())
  await act(async () => {})
  // Base UI portals the dialog to the body; both the inline + fullscreen frames exist.
  const frames = document.querySelectorAll('iframe')
  expect(frames.length).toBeGreaterThanOrEqual(2)
  expect(document.querySelector('button[aria-label="Close fullscreen"]')).toBeTruthy()
  frames.forEach((f) => expect(f.getAttribute('sandbox')).toBe('allow-scripts'))
})

it('sorting by title reorders the rows', async () => {
  const el = await mount(view([item({ id: 'a', title: 'Zebra' }), item({ id: 'b', title: 'Apple' })]))
  const titleOf = () =>
    Array.from(el.querySelectorAll('button[aria-label="Expand item"]')).map((caret) => {
      const row = caret.closest('.group') as HTMLElement
      return Array.from(row.querySelectorAll('button[title]')).map((b) => b.getAttribute('title')).find((t) => t === 'Zebra' || t === 'Apple')
    })
  const header = Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim().toLowerCase().startsWith('item')) as HTMLButtonElement
  await act(async () => header.click())
  expect(titleOf()[0]).toBe('Apple')
})
