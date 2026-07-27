import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'

import { countReviewQueue, getAuthState, listTaskScopes, listTasks } from '../server/loopApi'
import { authClient, useSession } from '../lib/auth-client'
import type { TaskRow } from '../server/taskTree'
import { TaskTree, STATUS_COLOR } from '../components/TaskTree'
import { TaskPanel } from '../components/TaskPanel'
import { LoopLogo } from '../components/LoopLogo'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'

/**
 * /tasks — the team's task tree as a worknode-style SPLIT view: compact
 * monospace tree on the left, the selected task's detail on the right.
 * Read-only v1: work-state lives in each task's README on its machine; this
 * page renders the server's derived index.
 */
type Scopes = { teams: Array<{ id: string; name: string }>; machines: Array<{ id: string; name: string }> }
const EMPTY_SCOPES: Scopes = { teams: [], machines: [] }

export const Route = createFileRoute('/tasks')({
  ssr: false,
  loader: async () => {
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { rows: [] as TaskRow[], scopes: EMPTY_SCOPES, reviewCount: 0, auth }
    }
    const [rows, scopes, reviewCount] = await Promise.all([listTasks(), listTaskScopes(), countReviewQueue()])
    return { rows, scopes, reviewCount, auth }
  },
  component: Gate,
  errorComponent: LoadError,
})

function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-[1180px] px-8 pt-12">
      <LoadErrorCard title="Couldn't load the task tree." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

function Gate() {
  const { auth } = Route.useLoaderData() ?? { auth: { enabled: false } }
  const { data: session, isPending } = useSession()
  if (auth?.enabled && !isPending && !session) return <SignIn />
  return <TasksPage />
}

const LEGEND = ['idea', 'todo', 'in-progress', 'follow-up', 'done', 'archived'] as const

/** A compact monospace scope picker (team / device), styled like the header's
 *  other controls. Hidden entirely when there's nothing to choose between — a
 *  single-team, single-machine account should see no chrome it can't use. */
function ScopeSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  allLabel: string
  options: Array<{ id: string; name: string; n: number }>
}) {
  if (options.length < 2) return null
  return (
    <label className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] tracking-[0.1em] text-secondary">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[220px] truncate border border-wire bg-surface px-1.5 py-1 font-mono text-[11px] tracking-[0.06em] text-display"
      >
        <option value="all">{allLabel}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.n})
          </option>
        ))}
      </select>
    </label>
  )
}

function TasksPage() {
  const initial = Route.useLoaderData()
  const [rows, setRows] = useState<TaskRow[]>(initial?.rows ?? [])
  const [scopes, setScopes] = useState<Scopes>(initial?.scopes ?? EMPTY_SCOPES)
  const [reviewCount, setReviewCount] = useState(initial?.reviewCount ?? 0)
  const [selected, setSelected] = useState<TaskRow | null>(null)
  const [showDone, setShowDone] = useState(false)
  // Scope filters — client-side over the already-scoped payload, so switching is
  // instant and can never widen what the server was willing to return.
  const [team, setTeam] = useState('all')
  const [device, setDevice] = useState('all')
  const navigate = useNavigate()

  // Silent refresh — fetch-then-set, never router.invalidate (repo rule: a
  // transient blip keeps stale data instead of nuking the page).
  const refetch = useCallback(async () => {
    try {
      const [fresh, freshScopes, review] = await Promise.all([listTasks(), listTaskScopes(), countReviewQueue()])
      setRows(fresh)
      setScopes(freshScopes)
      setReviewCount(review)
      // Keep the selection pointing at the fresh row (status may have moved).
      setSelected((sel) => (sel ? (fresh.find((r) => r.loopId === sel.loopId) ?? sel) : sel))
    } catch {
      /* keep what we have; the next tick retries */
    }
  }, [])
  useEffect(() => {
    const t = setInterval(() => void refetch(), 10_000)
    return () => clearInterval(t)
  }, [refetch])

  // Only offer a scope that actually has rows, and label it with its count.
  const countBy = (key: 'teamId' | 'machineId', id: string) => rows.filter((r) => r[key] === id).length
  const teamOpts = scopes.teams.map((t) => ({ ...t, n: countBy('teamId', t.id) })).filter((t) => t.n > 0)
  const deviceOpts = scopes.machines.map((m) => ({ ...m, n: countBy('machineId', m.id) })).filter((m) => m.n > 0)

  const visible = rows.filter(
    (r) => (team === 'all' || r.teamId === team) && (device === 'all' || r.machineId === device),
  )
  // A filter change can hide the open task — close the detail pane rather than
  // leaving it pinned to something no longer in the tree.
  useEffect(() => {
    setSelected((sel) => (sel && !visible.some((r) => r.loopId === sel.loopId) ? null : sel))
  }, [team, device]) // eslint-disable-line react-hooks/exhaustive-deps

  const due = visible.filter(
    (r) => r.status === 'follow-up' && r.follow_up_date && r.follow_up_date <= new Date().toISOString().slice(0, 10),
  ).length

  return (
    <div className="flex h-screen min-w-0 flex-col">
      {/* Compact worknode-style header: identity, toggles, the status legend. */}
      <header className="shrink-0 border-b border-display/80 px-5 pb-3 pt-4">
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <LoopLogo size={26} />
            <span className="font-display text-[20px] font-semibold tracking-tight text-display">Tasks</span>
            <span className="mt-0.5 font-mono text-[10px] tracking-[0.28em] text-secondary">WORK TREE</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {due > 0 && <span className="font-mono text-[11px] text-[#c0392b]">⏰ {due} due</span>}
            <Link
              to="/review"
              className="border border-wire bg-surface px-2.5 py-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:border-display hover:text-display"
            >
              REVIEW{reviewCount > 0 ? ` (${reviewCount})` : ''}
            </Link>
            <Link
              to="/"
              className="border border-wire bg-surface px-2.5 py-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:border-display hover:text-display"
            >
              DASHBOARD
            </Link>
          </div>
        </div>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5">
          <ScopeSelect
            label="TEAM"
            value={team}
            onChange={setTeam}
            allLabel={`ALL TEAMS (${rows.length})`}
            options={teamOpts}
          />
          <ScopeSelect
            label="DEVICE"
            value={device}
            onChange={setDevice}
            allLabel={`ALL DEVICES (${rows.length})`}
            options={deviceOpts}
          />
          {(team !== 'all' || device !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setTeam('all')
                setDevice('all')
              }}
              className="font-mono text-[10.5px] tracking-[0.1em] text-secondary underline underline-offset-2 transition-colors hover:text-display"
            >
              CLEAR ({visible.length}/{rows.length})
            </button>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] tracking-[0.1em] text-secondary">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="accent-current" />
            SHOW DONE
          </label>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {LEGEND.map((s) => (
              <span key={s} className="flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.08em] text-secondary">
                <span className="inline-block h-[9px] w-[9px]" style={{ backgroundColor: STATUS_COLOR[s] }} />
                {s.toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* Tree full-width by default; selecting a task splits in the detail pane
          (each side scrolls inside its own box). */}
      <div className={`grid min-h-0 min-w-0 flex-1 ${selected ? 'grid-cols-[minmax(360px,10fr)_minmax(320px,11fr)]' : 'grid-cols-1'}`}>
        <div className={`min-w-0 overflow-y-auto ${selected ? 'border-r border-display/80' : ''}`}>
          <TaskTree rows={visible} selectedId={selected?.loopId ?? null} onSelect={setSelected} showDone={showDone} />
        </div>
        {selected && (
          <div className="min-w-0 overflow-y-auto bg-paper">
            <TaskPanel
              row={selected}
              onClose={() => setSelected(null)}
              onOpenLoop={(id) => void navigate({ to: '/loops/$loopId', params: { loopId: id } })}
            />
          </div>
        )}
      </div>
    </div>
  )
}
