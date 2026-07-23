import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'

import type { TodoItemView, TodoListView, TodoMember, TodoOutput, TodoPatch, TodoPriority, TodoStatus } from '../types'
import { getTodoOutput, listTodos, patchTodo } from '../server/loopApi'
import { rel, tsShort } from '../lib/format'
import { selectCls, useHydrated } from './ui'
import { ArtifactBody } from './artifactView'
import { TaskFileView } from './TaskFileView'

/**
 * The team-global To-Do board: every meaningful loop run lands here as one
 * actionable row (ingested server-side — see `server/todo.ts`). The interaction
 * is a familiar row-board: a flat list of rows with inline-editable cells
 * (priority / status / assignee), sortable column headers, Active vs Archive
 * tabs, and expand-a-row to read the run's full output as a rendered HTML report.
 *
 * Persistence is team-wide and DB-backed; edits survive independently of the run
 * data. Live updates ride the same fetch-then-set poll the dashboard uses (no new
 * realtime stack) — a new item appears without a manual refresh.
 */

type SortKey = 'priority' | 'title' | 'loop' | 'status' | 'assignee' | 'date'
type SortDir = 'asc' | 'desc'

/** Column headers, in board order. The shortcut letter mirrors Rows' keyboard
 *  affordance (press the key to sort by that column). */
const COLUMNS: Array<{ key: SortKey; label: string; hint: string }> = [
  { key: 'priority', label: 'Priority', hint: 'p' },
  { key: 'title', label: 'Item', hint: 'i' },
  { key: 'loop', label: 'Loop', hint: 'l' },
  { key: 'status', label: 'Status', hint: 's' },
  { key: 'assignee', label: 'Assignee', hint: 'a' },
  { key: 'date', label: 'Produced', hint: 'd' },
]

const STATUS_LABEL: Record<TodoStatus, string> = { new: 'New', in_progress: 'In progress', done: 'Done' }
const PRIORITY_LABEL: Record<TodoPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' }
/** Sort rank so High < Medium < Low ascending (most urgent first). */
const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 }
const STATUS_RANK: Record<TodoStatus, number> = { new: 0, in_progress: 1, done: 2 }

/** A calm status dot colour, reusing the Rubik palette the loop cards use. */
function priorityDot(p: TodoPriority): string {
  return p === 'high' ? 'bg-rubik-red' : p === 'medium' ? 'bg-rubik-amber' : 'bg-disabled'
}

/** Compare two items on the active sort key (stable within equal keys). */
function compareItems(a: TodoItemView, b: TodoItemView, key: SortKey): number {
  switch (key) {
    case 'priority':
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    case 'status':
      return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    case 'title':
      return a.title.localeCompare(b.title)
    case 'loop':
      return a.loopName.localeCompare(b.loopName)
    case 'assignee':
      return (a.assigneeLabel ?? '~').localeCompare(b.assigneeLabel ?? '~')
    case 'date':
      return a.producedAt < b.producedAt ? -1 : a.producedAt > b.producedAt ? 1 : 0
  }
}

export function TodoPage({ teamId }: { teamId?: string }) {
  return (
    <main className="mx-auto min-w-0 max-w-[1180px] px-8 pb-16 pt-10 max-sm:px-4">
      <div className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-display">To-Do</h1>
        <p className="text-label text-secondary">Everything your loops produced, as one actionable list.</p>
        {teamId ? (
          <Link to="/t/$teamId" params={{ teamId }} className={backLink}>
            ← Back to loops
          </Link>
        ) : (
          <Link to="/" className={backLink}>
            ← Back to loops
          </Link>
        )}
      </div>
      {/* Re-key on the team so a /t/A → /t/B navigation re-seeds the fetch state. */}
      <TodoBoard key={teamId} teamId={teamId} />
    </main>
  )
}

const backLink = 'ml-auto text-label text-secondary hover:underline'

function TodoBoard({ teamId }: { teamId?: string }) {
  const [data, setData] = useState<TodoListView | null>(null)
  const [tab, setTab] = useState<'active' | 'archive'>('active')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'date', dir: 'desc' })
  const [expanded, setExpanded] = useState<string | null>(null)
  // A local pulse so an inline edit reflects instantly while the write is in
  // flight (the poll reconciles it shortly after) — never wait a full poll.
  const [pending, setPending] = useState<Record<string, Partial<TodoItemView>>>({})
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const refetch = useCallback(async () => {
    try {
      const next = await listTodos({ data: teamId })
      setData(next)
      // Drop optimistic overlays the server has now caught up on.
      setPending((prev) => {
        const kept: Record<string, Partial<TodoItemView>> = {}
        for (const it of next.items) {
          const p = prev[it.id]
          if (!p) continue
          const stale =
            (p.status === undefined || p.status === it.status) &&
            (p.priority === undefined || p.priority === it.priority) &&
            (p.assigneeUserId === undefined || p.assigneeUserId === it.assigneeUserId) &&
            (p.archived === undefined || p.archived === it.archived)
          if (!stale) kept[it.id] = p
        }
        return kept
      })
    } catch {
      /* keep what we have; next tick retries */
    }
  }, [teamId])

  useEffect(() => {
    void refetch()
  }, [refetch])

  // Poll fetch-then-set (like the dashboard), pausing while a row is expanded so
  // a fresh list can't yank the open report out from under the reader.
  const expandedRef = useRef<string | null>(null)
  expandedRef.current = expanded
  useEffect(() => {
    const t = setInterval(() => {
      if (!expandedRef.current) void refetch()
    }, 8_000)
    return () => clearInterval(t)
  }, [refetch])

  const applyPatch = useCallback(
    async (id: string, patch: TodoPatch) => {
      setPending((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
      const res = await patchTodo({ data: { id, patch } })
      if (res?.error) {
        // Roll the optimistic overlay back on rejection, then refetch truth.
        setPending((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
      void refetch()
    },
    [refetch],
  )

  const merged = useMemo(
    () => (data?.items ?? []).map((it) => ({ ...it, ...pending[it.id] })),
    [data, pending],
  )
  const activeCount = merged.filter((i) => !i.archived).length
  const archiveCount = merged.filter((i) => i.archived).length

  const rows = useMemo(() => {
    const inTab = merged.filter((i) => (tab === 'active' ? !i.archived : i.archived))
    const sorted = [...inTab].sort((a, b) => compareItems(a, b, sort.key))
    if (sort.dir === 'desc') sorted.reverse()
    return sorted
  }, [merged, tab, sort])

  const onSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'date' ? 'desc' : 'asc' }))
  }, [])

  // Keyboard shortcuts for sorting (press a column's hint letter), skipped while
  // typing in a field. Mirrors the Rows keyboard affordance.
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

  const canEdit = data?.canEdit ?? false
  const members = data?.members ?? []

  if (!data) return <div className="py-16 text-center text-body text-disabled">Loading…</div>

  return (
    <div className="min-w-0">
      {/* Tabs with counts. */}
      <div className="mb-4 flex items-center gap-2">
        <TabButton active={tab === 'active'} onClick={() => setTab('active')} label="Active" count={activeCount} />
        <TabButton active={tab === 'archive'} onClick={() => setTab('archive')} label="Archive" count={archiveCount} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-card border border-hairline bg-surface py-16 text-center">
          <div className="text-[15px] text-secondary">
            {tab === 'active' ? 'No active items yet' : 'Nothing archived'}
          </div>
          {tab === 'active' && (
            <div className="mt-1.5 text-body text-disabled">
              As your loops run and produce results, they show up here.
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-hairline bg-surface">
          {/* Sortable header row. */}
          <div className={`${rowGrid} border-b border-hairline bg-raised/60 px-3 py-2`}>
            <span />
            {COLUMNS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => onSort(c.key)}
                title={`Sort by ${c.label.toLowerCase()} (${c.hint})`}
                className="group flex min-w-0 items-center gap-1 text-left text-caption font-semibold uppercase tracking-wide text-secondary transition-colors hover:text-display"
              >
                <span className="truncate">{c.label}</span>
                <span className="text-disabled">{sort.key === c.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span>
              </button>
            ))}
            <span />
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
    </div>
  )
}

/* The board's column grid — a leading expand caret, the six cells, a trailing
   actions cell. Shared by the header and every row so they stay aligned. */
const rowGrid =
  'grid items-center gap-3 [grid-template-columns:22px_minmax(90px,0.8fr)_minmax(160px,2.4fr)_minmax(90px,1fr)_minmax(120px,1.1fr)_minmax(90px,1fr)_minmax(96px,0.9fr)_112px]'

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-meta font-medium transition-colors ${
        active ? 'bg-display text-paper' : 'text-secondary hover:bg-raised hover:text-display'
      }`}
    >
      {label}
      <span className={`rounded-full px-1.5 text-caption ${active ? 'bg-paper/20 text-paper' : 'bg-raised text-disabled'}`}>
        {count}
      </span>
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
    <div className="border-b border-hairline last:border-b-0">
      <div className={`${rowGrid} px-3 py-2.5 transition-colors hover:bg-raised/40`}>
        {/* Expand caret. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse item' : 'Expand item'}
          className="flex size-5 cursor-pointer items-center justify-center rounded text-disabled transition-colors hover:text-display"
        >
          <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
        </button>

        {/* Priority (inline select). */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`size-2 shrink-0 rounded-full ${priorityDot(item.priority)}`} aria-hidden />
          <InlineSelect
            value={item.priority}
            disabled={!canEdit}
            ariaLabel="Change priority"
            onChange={(v) => onPatch({ priority: v as TodoPriority })}
            options={(['high', 'medium', 'low'] as TodoPriority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
          />
        </div>

        {/* Title — the run's derived summary; a check to mark done fast. */}
        <div className="flex min-w-0 items-center gap-2">
          {canEdit && (
            <input
              type="checkbox"
              checked={done}
              aria-label={done ? 'Mark not done' : 'Mark done'}
              onChange={(e) => onPatch({ status: e.target.checked ? 'done' : 'new' })}
              className="size-4 shrink-0 cursor-pointer accent-[color:var(--color-display)]"
            />
          )}
          <button
            type="button"
            onClick={onToggle}
            className={`min-w-0 truncate text-left text-body transition-colors hover:text-display ${
              done ? 'text-disabled line-through' : 'text-primary'
            }`}
            title={item.title}
          >
            {item.failed && <span className="mr-1.5 align-middle text-rubik-red" title="Run failed">⚠</span>}
            {item.title}
          </button>
        </div>

        {/* Source loop → its detail page. */}
        <Link
          to="/loops/$loopId"
          params={{ loopId: item.loopId }}
          className="min-w-0 truncate text-label text-secondary transition-colors hover:text-display hover:underline"
          title={`${item.loopName}${item.machineName ? ` · ${item.machineName}` : ''}`}
        >
          {item.loopName}
        </Link>

        {/* Status (inline select). */}
        <InlineSelect
          value={item.status}
          disabled={!canEdit}
          ariaLabel="Change status"
          onChange={(v) => onPatch({ status: v as TodoStatus })}
          options={(['new', 'in_progress', 'done'] as TodoStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
        />

        {/* Assignee (inline select of team members). */}
        <InlineSelect
          value={item.assigneeUserId ?? ''}
          disabled={!canEdit || members.length === 0}
          ariaLabel="Assign to a team member"
          onChange={(v) => onPatch({ assigneeUserId: v || null })}
          options={[{ value: '', label: members.length ? 'Unassigned' : '—' }, ...members.map((m) => ({ value: m.userId, label: m.label }))]}
        />

        {/* Produced date. */}
        <span className="truncate text-label text-secondary" title={new Date(item.producedAt).toLocaleString()}>
          {tsShort(item.producedAt)}
        </span>

        {/* Row actions: archive / restore. */}
        <div className="flex items-center justify-end gap-1.5">
          {canEdit && (
            <button
              type="button"
              onClick={() => onPatch({ archived: !item.archived })}
              className="cursor-pointer rounded-full border border-wire bg-surface px-2.5 py-1 text-caption font-medium text-secondary transition-colors hover:bg-raised hover:text-display"
            >
              {item.archived ? 'Restore' : 'Archive'}
            </button>
          )}
        </div>
      </div>

      {expanded && <TodoDetail item={item} />}
    </div>
  )
}

/** A compact inline `<select>` for a row cell (the shared field styling, sized
 *  down and auto-width so it sits in a dense row). */
function InlineSelect({
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
      className={`${selectCls} min-w-0 truncate py-1 pl-2 pr-6 text-label disabled:cursor-default disabled:opacity-70`}
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
 * The expanded row: the run's output rendered as a styled HTML report (captain
 * addendum). If the run produced an HTML artifact, that artifact IS the report
 * (the shared sandboxed `ArtifactBody`); otherwise its final report renders
 * through the shared markdown pipeline (`TaskFileView`). Loop output is untrusted
 * — both paths keep the existing sandbox/sanitizer posture.
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

  return (
    <div className="border-t border-hairline bg-raised/30">
      {/* A calm report header: the run's shape + provenance. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-2.5 text-caption text-secondary">
        <span className="font-mono text-disabled">{item.loopName}</span>
        {item.machineName && <span className="text-disabled">· {item.machineName}</span>}
        <span className="text-disabled">· {rel(item.producedAt)}</span>
        {item.outcome && <span className="text-disabled">· {item.failed ? 'failed' : item.outcome}</span>}
      </div>
      <div className="mx-4 mb-4 overflow-hidden rounded-control border border-hairline bg-surface">
        {'loading' in out ? (
          <div className="px-5 py-8 text-body text-disabled">Loading report…</div>
        ) : 'error' in out ? (
          <div className="px-5 py-8 text-body text-accent">Couldn&apos;t load this report — {out.error}</div>
        ) : out.kind === 'artifact' ? (
          // The run's own HTML artifact — the shared sandboxed viewer.
          <ArtifactBody loopId={out.loopId} file={out.file} />
        ) : out.kind === 'markdown' ? (
          // The run's final report, rendered through the shared markdown pipeline.
          hydrated ? <TaskFileView content={out.content} /> : <div className="px-5 py-8 text-body text-disabled">Loading report…</div>
        ) : (
          <div className="px-5 py-8 text-body text-disabled">This run produced no report output.</div>
        )}
      </div>
    </div>
  )
}
