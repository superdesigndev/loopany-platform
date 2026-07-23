// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TodoItemView, TodoListView } from '../types'

const { listTodos, patchTodo, getTodoOutput } = vi.hoisted(() => ({
  listTodos: vi.fn(),
  patchTodo: vi.fn(async () => ({ ok: true })),
  getTodoOutput: vi.fn(async () => ({ kind: 'markdown' as const, content: '# Report body' })),
}))

vi.mock('../server/loopApi', () => ({ listTodos, patchTodo, getTodoOutput }))
// The router Link + the heavy report viewers are out of scope for the board test.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => createElement('a', {}, children as never),
}))
vi.mock('./artifactView', () => ({ ArtifactBody: () => createElement('div', { 'data-testid': 'artifact' }) }))
vi.mock('./TaskFileView', () => ({ TaskFileView: ({ content }: { content: string }) => createElement('div', { 'data-testid': 'md' }, content) }))

import { TodoPage } from './TeamTodoView'

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
  listTodos.mockReset()
  patchTodo.mockClear()
  getTodoOutput.mockClear()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(TodoPage, { teamId: 'team-a' }))
  })
  // Let the mount refetch resolve.
  await act(async () => {})
  return host!
}

it('renders rows and Active/Archive tab counts', async () => {
  listTodos.mockResolvedValue(
    view([item({ id: 'a', title: 'Active one' }), item({ id: 'b', title: 'Archived one', archived: true })]),
  )
  const el = await mount()
  expect(el.textContent).toContain('Active one')
  // The archived item is on the other tab, not shown in Active.
  expect(el.textContent).not.toContain('Archived one')
  // Tab counts: Active 1, Archive 1.
  const tabs = Array.from(el.querySelectorAll('button')).filter((b) => /^(Active|Archive)/.test(b.textContent ?? ''))
  expect(tabs.find((b) => b.textContent?.startsWith('Active'))?.textContent).toContain('1')
  expect(tabs.find((b) => b.textContent?.startsWith('Archive'))?.textContent).toContain('1')
})

it('an inline status edit calls patchTodo', async () => {
  listTodos.mockResolvedValue(view([item({ id: 'a' })]))
  const el = await mount()
  const statusSelect = Array.from(el.querySelectorAll('select')).find(
    (s) => s.getAttribute('aria-label') === 'Change status',
  ) as HTMLSelectElement
  expect(statusSelect).toBeTruthy()
  await act(async () => {
    statusSelect.value = 'done'
    statusSelect.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(patchTodo).toHaveBeenCalledWith({ data: { id: 'a', patch: { status: 'done' } } })
})

it('the mark-done checkbox sets status done', async () => {
  listTodos.mockResolvedValue(view([item({ id: 'a' })]))
  const el = await mount()
  const cb = el.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => {
    cb.click()
  })
  expect(patchTodo).toHaveBeenCalledWith({ data: { id: 'a', patch: { status: 'done' } } })
})

it('expanding a row loads and renders the report', async () => {
  listTodos.mockResolvedValue(view([item({ id: 'a', title: 'Open me' })]))
  const el = await mount()
  const caret = el.querySelector('button[aria-label="Expand item"]') as HTMLButtonElement
  await act(async () => {
    caret.click()
  })
  await act(async () => {})
  expect(getTodoOutput).toHaveBeenCalledWith({ data: { id: 'a' } })
  expect(el.querySelector('[data-testid="md"]')?.textContent).toContain('# Report body')
})

it('sorting by title reorders the rows', async () => {
  listTodos.mockResolvedValue(
    view([item({ id: 'a', title: 'Zebra' }), item({ id: 'b', title: 'Apple' })]),
  )
  const el = await mount()
  const titles = () =>
    Array.from(el.querySelectorAll('button[title]'))
      .map((b) => b.getAttribute('title'))
      .filter((t) => t === 'Zebra' || t === 'Apple')
  // Default sort is date-desc (both same-ish); click the Item header → title asc.
  const header = Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith('Item')) as HTMLButtonElement
  await act(async () => header.click())
  expect(titles()[0]).toBe('Apple')
})
