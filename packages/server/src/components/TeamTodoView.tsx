import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Dialog } from '@base-ui/react/dialog'

import type { TodoItemView, TodoListView, TodoMember, TodoOutput, TodoPatch, TodoPriority, TodoStatus } from '../types'
import { getTodoOutput, patchTodo } from '../server/loopApi'
import { tsShort } from '../lib/format'
import { useHydrated } from './ui'
import { markdownToReportDoc } from '../lib/todoReport'

/**
 * The team To-Do panel: every meaningful loop run lands here as one quiet row
 * (ingested server-side — see `server/todo.ts`). It lives on the dashboard as the
 * LEFT column beside the loops (see `DashboardView`); it is presentational — the
 * dashboard owns the fetch/poll and passes `data`, so there is ONE poll and the
 * layout can key off the item count.
 *
 * The interaction targets a calm row board: one flat list, thin quiet headers,
 * inline edits whose affordances only surface on hover/focus, and expand-a-row to
 * read the run's full output as a rendered HTML report. Kept lean on purpose —
 * sort, Active/Archive, inline status/priority/assignee, mark-done, expand.
 */

type SortKey = 'priority' | 'title' | 'status' | 'assignee'
type SortDir = 'asc' | 'desc'

/** Column headers, in board order (the shortcut letter mirrors the Rows keyboard
 *  affordance — press the key to sort by that column). */
const COLUMNS: Array<{ key: SortKey; label: string; hint: string }> = [
  { key: 'priority', label: 'Priority', hint: 'p' },
  { key: 'title', label: 'Item', hint: 'i' },
  { key: 'status', label: 'Status', hint: 's' },
  { key: 'assignee', label: 'Assignee', hint: 'a' },
]

const STATUS_LABEL: Record<TodoStatus, string> = { new: 'New', in_progress: 'In progress', done: 'Done' }
const PRIORITY_LABEL: Record<TodoPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 }
const STATUS_RANK: Record<TodoStatus, number> = { new: 0, in_progress: 1, done: 2 }

/** A quiet priority dot (reusing the Rubik palette the loop cards use). */
function priorityDot(p: TodoPriority): string {
  return p === 'high' ? 'bg-rubik-red' : p === 'medium' ? 'bg-rubik-amber' : 'bg-disabled'
}

function compareItems(a: TodoItemView, b: TodoItemView, key: SortKey): number {
  switch (key) {
    case 'priority':
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || cmpDate(b, a)
    case 'status':
      return STATUS_RANK[a.status] - STATUS_RANK[b.status] || cmpDate(b, a)
    case 'title':
      return a.title.localeCompare(b.title)
    case 'assignee':
      return (a.assigneeLabel ?? '~').localeCompare(b.assigneeLabel ?? '~')
  }
}
const cmpDate = (a: TodoItemView, b: TodoItemView) => (a.producedAt < b.producedAt ? -1 : a.producedAt > b.producedAt ? 1 : 0)

/**
 * The dashboard's left column. `data` is the team's todo list (owned by the
 * dashboard's poll); `onChanged` asks the dashboard to refetch after an edit so
 * server truth reconciles the optimistic overlay.
 */
export function TodoPanel({ data, onChanged }: { data: TodoListView; onChanged?: () => void }) {
  const [tab, setTab] = useState<'active' | 'archive'>('active')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'priority', dir: 'asc' })
  const [expanded, setExpanded] = useState<string | null>(null)
  // Optimistic overlay so an inline edit reflects instantly; the poll reconciles.
  const [pending, setPending] = useState<Record<string, Partial<TodoItemView>>>({})

  // Drop overlays the incoming data has caught up on (keyed comparison).
  useEffect(() => {
    setPending((prev) => {
      if (!Object.keys(prev).length) return prev
      const kept: Record<string, Partial<TodoItemView>> = {}
      for (const it of data.items) {
        const p = prev[it.id]
        if (!p) continue
        const caughtUp =
          (p.status === undefined || p.status === it.status) &&
          (p.priority === undefined || p.priority === it.priority) &&
          (p.assigneeUserId === undefined || p.assigneeUserId === it.assigneeUserId) &&
          (p.archived === undefined || p.archived === it.archived)
        if (!caughtUp) kept[it.id] = p
      }
      return kept
    })
  }, [data])

  const applyPatch = useCallback(
    async (id: string, patch: TodoPatch) => {
      setPending((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
      const res = await patchTodo({ data: { id, patch } })
      if (res?.error) {
        setPending((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
      onChanged?.()
    },
    [onChanged],
  )

  const merged = useMemo(() => data.items.map((it) => ({ ...it, ...pending[it.id] })), [data.items, pending])
  const activeCount = merged.filter((i) => !i.archived).length
  const archiveCount = merged.filter((i) => i.archived).length

  const rows = useMemo(() => {
    const inTab = merged.filter((i) => (tab === 'active' ? !i.archived : i.archived))
    const sorted = [...inTab].sort((a, b) => compareItems(a, b, sort.key))
    if (sort.dir === 'desc') sorted.reverse()
    return sorted
  }, [merged, tab, sort])

  const onSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  // Keyboard sort shortcuts (skipped while typing / in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const col = COLUMNS.find((c) => c.hint === e.key.toLowerCase())
      if (col) {
        e.preventDefault()
        onSort(col.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSort])

  const canEdit = data.canEdit
  const members = data.members

  return (
    <section className="min-w-0">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-body font-semibold text-display">To-Do</h2>
        <div className="flex items-center gap-3 text-label">
          <Tab active={tab === 'active'} onClick={() => setTab('active')} label="Active" count={activeCount} />
          <Tab active={tab === 'archive'} onClick={() => setTab('archive')} label="Archive" count={archiveCount} />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-10 text-body text-disabled">
          {tab === 'active' ? 'Nothing to do right now.' : 'Nothing archived.'}
        </p>
      ) : (
        <div className="min-w-0">
          {/* Thin, quiet header row. */}
          <div className={`${rowGrid} border-b border-hairline pb-2 text-caption uppercase tracking-wide text-disabled`}>
            <span />
            {COLUMNS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => onSort(c.key)}
                title={`Sort by ${c.label.toLowerCase()} (${c.hint})`}
                className="flex min-w-0 items-center gap-1 text-left uppercase tracking-wide transition-colors hover:text-secondary"
              >
                <span className="truncate">{c.label}</span>
                {sort.key === c.key && <span className="text-secondary">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
              </button>
            ))}
          </div>

          {rows.map((it) => (
            <TodoRow
              key={it.id}
              item={it}
              members={members}
              canEdit={canEdit}
              expanded={expanded === it.id}
              onToggle={() => setExpanded((cur) => (cur === it.id ? null : it.id))}
              onPatch={(patch) => applyPatch(it.id, patch)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/* The column grid — a leading caret, the four cells. Shared by the header and
   every row so they stay aligned. Title flexes; the rest are quiet fixed cells
   that truncate rather than ever scroll the page. */
const rowGrid =
  'grid items-center gap-2.5 [grid-template-columns:16px_minmax(74px,auto)_minmax(0,1fr)_minmax(88px,auto)_minmax(84px,auto)]'

function Tab({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer border-b-2 pb-0.5 font-medium transition-colors ${
        active ? 'border-display text-display' : 'border-transparent text-disabled hover:text-secondary'
      }`}
    >
      {label} <span className="tabular-nums text-disabled">{count}</span>
    </button>
  )
}

function TodoRow({
  item,
  members,
  canEdit,
  expanded,
  onToggle,
  onPatch,
}: {
  item: TodoItemView
  members: TodoMember[]
  canEdit: boolean
  expanded: boolean
  onToggle: () => void
  onPatch: (patch: TodoPatch) => void
}) {
  const done = item.status === 'done'
  return (
    <div className="group border-b border-hairline last:border-b-0">
      <div className={`${rowGrid} py-2.5`}>
        {/* Expand caret — quiet until hover. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse item' : 'Expand item'}
          className={`flex size-4 cursor-pointer items-center justify-center rounded text-disabled transition-all group-hover:text-secondary ${
            expanded ? 'rotate-90 text-secondary' : ''
          }`}
        >
          ›
        </button>

        {/* Priority — a dot + a bare inline select. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`size-2 shrink-0 rounded-full ${priorityDot(item.priority)}`} aria-hidden />
          <BareSelect
            value={item.priority}
            disabled={!canEdit}
            ariaLabel="Change priority"
            onChange={(v) => onPatch({ priority: v as TodoPriority })}
            options={(['high', 'medium', 'low'] as TodoPriority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
          />
        </div>

        {/* Item — the run's derived summary + a quiet loop · time caption. A
            mark-done check surfaces on hover (always visible once done). */}
        <div className="flex min-w-0 items-start gap-2">
          {canEdit && (
            <input
              type="checkbox"
              checked={done}
              aria-label={done ? 'Mark not done' : 'Mark done'}
              onChange={(e) => onPatch({ status: e.target.checked ? 'done' : 'new' })}
              className={`mt-0.5 size-3.5 shrink-0 cursor-pointer accent-[color:var(--color-display)] transition-opacity ${
                done ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
              }`}
            />
          )}
          <div className="min-w-0">
            <button
              type="button"
              onClick={onToggle}
              className={`block min-w-0 max-w-full truncate text-left text-body transition-colors hover:text-display ${
                done ? 'text-disabled line-through' : 'text-primary'
              }`}
              title={item.title}
            >
              {item.failed && <span className="mr-1 align-middle text-rubik-red" title="Run failed">⚠</span>}
              {item.title}
            </button>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-disabled">
              <Link
                to="/loops/$loopId"
                params={{ loopId: item.loopId }}
                className="min-w-0 truncate transition-colors hover:text-secondary hover:underline"
                title={item.loopName}
              >
                {item.loopName}
              </Link>
              <span aria-hidden>·</span>
              <span className="shrink-0" title={new Date(item.producedAt).toLocaleString()}>
                {tsShort(item.producedAt)}
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onPatch({ archived: !item.archived })}
                  className="ml-1 shrink-0 cursor-pointer text-disabled opacity-0 transition-opacity hover:text-secondary hover:underline group-hover:opacity-100 focus:opacity-100"
                >
                  {item.archived ? 'Restore' : 'Archive'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Status — a bare inline select. */}
        <BareSelect
          value={item.status}
          disabled={!canEdit}
          ariaLabel="Change status"
          onChange={(v) => onPatch({ status: v as TodoStatus })}
          options={(['new', 'in_progress', 'done'] as TodoStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
        />

        {/* Assignee — a bare inline select of team members (disabled in open mode). */}
        <BareSelect
          value={item.assigneeUserId ?? ''}
          disabled={!canEdit || members.length === 0}
          ariaLabel="Assign to a team member"
          onChange={(v) => onPatch({ assigneeUserId: v || null })}
          options={[{ value: '', label: members.length ? 'Unassigned' : '—' }, ...members.map((m) => ({ value: m.userId, label: m.label }))]}
        />
      </div>

      {expanded && <TodoDetail item={item} />}
    </div>
  )
}

/** A calm inline `<select>`: looks like plain quiet text, revealing a subtle
 *  border + raised fill only on hover/focus (the "affordance on hover" feel). */
function BareSelect({
  value,
  options,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
  ariaLabel: string
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="min-w-0 max-w-full cursor-pointer truncate rounded border border-transparent bg-transparent py-0.5 pl-1 pr-1.5 text-label text-secondary outline-none transition-colors [appearance:none] hover:border-hairline hover:bg-raised focus-visible:border-hairline focus-visible:bg-raised disabled:cursor-default disabled:border-transparent disabled:bg-transparent disabled:opacity-60"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/**
 * The expanded row: the run's output as ONE consistent HTML report. A run's own
 * HTML artifact is shown as-is; a markdown/text report is wrapped into the SAME
 * styled report document (`markdownToReportDoc`). Both render through the single
 * `HtmlReportView` (a sandboxed iframe) — no text-vs-html branching in the UI.
 */
function TodoDetail({ item }: { item: TodoItemView }) {
  const [out, setOut] = useState<TodoOutput | { loading: true } | { error: string }>({ loading: true })
  const hydrated = useHydrated()

  useEffect(() => {
    let alive = true
    setOut({ loading: true })
    getTodoOutput({ data: { id: item.id } })
      .then((o) => alive && setOut(o))
      .catch((e) => alive && setOut({ error: String(e) }))
    return () => {
      alive = false
    }
  }, [item.id])

  // Turn every source into ONE HTML document: an artifact is used as-is; markdown/
  // text is wrapped into the styled report doc (needs the DOM sanitizer, so it
  // waits for hydration). `null` ⇒ nothing to render.
  const doc = useMemo(() => {
    if ('loading' in out || 'error' in out) return null
    if (out.kind === 'html') return out.html
    if (out.kind === 'markdown') return hydrated ? markdownToReportDoc(out.content) : null
    return null
  }, [out, hydrated])

  return (
    <div className="mb-3 ml-[26px] overflow-hidden rounded-control border border-hairline bg-surface">
      {'loading' in out || ('kind' in out && out.kind !== 'empty' && doc === null) ? (
        <div className="px-5 py-8 text-body text-disabled">Loading report…</div>
      ) : 'error' in out ? (
        <div className="px-5 py-8 text-body text-accent">Couldn&apos;t load this report — {out.error}</div>
      ) : doc !== null ? (
        <HtmlReportView html={doc} title={item.title} />
      ) : (
        <div className="px-5 py-8 text-body text-disabled">This run produced no report output.</div>
      )}
    </div>
  )
}

/** The exact sandbox posture of the app's HTML-artifact viewer: `allow-scripts`
 *  WITHOUT `allow-same-origin`, so the frame gets an opaque origin (no cookies, no
 *  storage, no `parent` access). Loop output is untrusted; this is the load-bearing
 *  containment, identical inline and fullscreen. */
const SANDBOX = 'allow-scripts'

function ReportFrame({ html, className }: { html: string; className: string }) {
  return (
    <iframe
      title="Report (sandboxed)"
      srcDoc={html}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      className={className}
    />
  )
}

/**
 * The unified report view: the HTML document in a sandboxed iframe, plus a
 * Fullscreen affordance. Fullscreen is a Base UI Dialog (focus trap + Esc + scroll
 * lock, the app's modal convention) whose popup covers the whole viewport with the
 * SAME sandboxed frame — the sandbox rules are unchanged in fullscreen.
 */
function HtmlReportView({ html, title }: { html: string; title: string }) {
  const [full, setFull] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setFull(true)}
        aria-label="Open report fullscreen"
        className="absolute right-2 top-2 z-10 inline-flex cursor-pointer items-center gap-1 rounded-control border border-hairline bg-surface/90 px-2 py-1 text-caption font-medium text-secondary backdrop-blur transition-colors hover:text-display"
      >
        <span aria-hidden>⤢</span> Fullscreen
      </button>
      <ReportFrame html={html} className="h-[min(70vh,620px)] w-full border-0 bg-white" />

      <Dialog.Root open={full} onOpenChange={(o) => !o && setFull(false)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[900] bg-black/40 backdrop-blur-[6px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup className="fixed inset-0 z-[901] flex flex-col bg-white outline-none transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            <div className="flex items-center justify-between gap-3 border-b border-hairline bg-surface px-4 py-2">
              <span className="min-w-0 truncate text-label font-medium text-display" title={title}>{title}</span>
              <Dialog.Close
                aria-label="Close fullscreen"
                className="shrink-0 cursor-pointer rounded-full border-none bg-transparent px-2 py-0.5 text-[15px] leading-none text-disabled transition-colors hover:text-display focus-visible:text-display focus-visible:outline-none"
              >
                ✕
              </Dialog.Close>
            </div>
            <ReportFrame html={html} className="min-h-0 w-full flex-1 border-0 bg-white" />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
