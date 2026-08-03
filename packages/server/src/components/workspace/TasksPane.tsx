import { useState } from 'react'

import { fetchTask, fetchTasks, type TaskRow } from './api'
import { ExecutionBlock, Markdown } from './Render'
import { Empty, Loading, Refusal, RunStrip, StateChip, Timeline, When } from './parts'
import { affectsObject, affectsTasks, useLiveView } from './useLiveView'

/**
 * TASKS — list and detail.
 *
 * The list's filters are STATE predicates only (open/closed, due, watched by,
 * created by, question waiting). There is deliberately no time-window filter:
 * a window leaks work, while a state predicate self-heals, which is exactly why
 * the design forbids windows as work-list bases.
 *
 * The detail page is the event timeline read forwards. Two states exist —
 * `open → closed`, nothing else — so everything that FEELS like a state is shown
 * as what it actually is: a pending question, a follow-up date, a watcher, or a
 * run's lease.
 */

const FILTERS = [
  { key: 'open', label: 'Open', query: { status: 'open' } },
  { key: 'due', label: 'Due', query: { status: 'open', due: 'true' } },
  { key: 'questions', label: 'Questions', query: { status: 'open', question: 'true' } },
  { key: 'pool', label: 'Unclaimed', query: { status: 'open', watcher: 'none' } },
  { key: 'closed', label: 'Closed', query: { status: 'closed' } },
] as const

export function TasksPane({ selected, onSelect, onOpenLoop }: { selected: string | null; onSelect: (id: string | null) => void; onOpenLoop: (id: string) => void }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('open')
  const active = FILTERS.find((f) => f.key === filter)!
  const { data, error, loading } = useLiveView(`tasks:${filter}`, () => fetchTasks(active.query as Record<string, string>), affectsTasks)

  return (
    <div className="ws-split">
      <div className="ws-pane ws-list-pane">
        <header className="ws-pane-head">
          <div>
            <h1>Tasks</h1>
            <p>Our own work items. Never a shadow of an external object — a PR lives on GitHub and enters here only as payload facts.</p>
          </div>
        </header>
        <nav className="ws-filters" aria-label="Task filters">
          {FILTERS.map((option) => (
            <button key={option.key} type="button" aria-pressed={option.key === filter} onClick={() => setFilter(option.key)}>
              {option.label}
            </button>
          ))}
        </nav>
        {error && !data ? <Refusal error={error} /> : null}
        {!data && !error ? <Loading what="tasks" /> : null}
        {data && data.tasks.length === 0 && <Empty>Nothing matches this filter.</Empty>}
        {data && (
          <ul className="ws-rows">
            {data.tasks.map((task) => (
              <TaskListRow key={task.id} task={task} selected={task.id === selected} onSelect={onSelect} />
            ))}
          </ul>
        )}
        {data?.truncated && <p className="ws-empty">More tasks exist than this page shows — narrow the filter.</p>}
        {loading && data && <p className="ws-refreshing">refreshing…</p>}
      </div>
      <div className="ws-pane ws-detail-pane">
        {selected ? <TaskDetail id={selected} onOpenLoop={onOpenLoop} /> : <Empty>Select a task to see its artifact, its execution payload and its full event timeline.</Empty>}
      </div>
    </div>
  )
}

function TaskListRow({ task, selected, onSelect }: { task: TaskRow; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={`ws-row ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(task.id)}>
        <span className="ws-row-title">{task.title ?? task.id}</span>
        <span className="ws-row-meta">
          {task.pendingQuestion?.trim() && <span className="ws-chip ws-chip-question">question</span>}
          {task.due && <span className="ws-chip ws-chip-due">due</span>}
          {task.status === 'closed' && <span className="ws-chip ws-chip-success">closed</span>}
          {!task.watcher && task.status === 'open' && <span className="ws-chip ws-chip-orphan">unclaimed</span>}
          <span className="ws-row-watcher">{task.watcherLoop?.title ?? (task.watcher ? task.watcher : 'pool')}</span>
          <When iso={task.updatedAt} />
        </span>
      </button>
    </li>
  )
}

function TaskDetail({ id, onOpenLoop }: { id: string; onOpenLoop: (id: string) => void }) {
  const { data, error } = useLiveView(`task:${id}`, () => fetchTask(id), affectsObject(id))
  if (error && !data) return <Refusal error={error} />
  if (!data) return <Loading what="the task" />
  const task = data.task

  return (
    <article className="ws-detail">
      <header className="ws-detail-head">
        <h2>{task.title ?? task.id}</h2>
        <code className="ws-id">{task.id}</code>
        <div className="ws-detail-facets">
          {/* Two states exist. Everything else that feels like one is a facet. */}
          <span className={`ws-chip ws-chip-${task.status === 'closed' ? 'success' : 'open'}`}>{task.status}</span>
          {task.pendingQuestion?.trim() && <span className="ws-chip ws-chip-question">question waiting</span>}
          {data.due && <span className="ws-chip ws-chip-due">due</span>}
          {task.followUpAt && <When iso={task.followUpAt} prefix="follow-up" />}
          <span className="ws-facet">
            watcher:{' '}
            {data.watcherLoop ? (
              <button type="button" className="ws-link" onClick={() => onOpenLoop(data.watcherLoop!.id)}>
                {data.watcherLoop.title ?? data.watcherLoop.id}
              </button>
            ) : (
              'unclaimed pool'
            )}
          </span>
          <span className="ws-facet">
            creator:{' '}
            {data.creator ? (
              <button type="button" className="ws-link" onClick={() => onOpenLoop(data.creator!.id)}>
                {data.creator.title ?? data.creator.id}
              </button>
            ) : (
              'you'
            )}
          </span>
        </div>
      </header>

      {task.pendingQuestion?.trim() && <p className="ws-question">{task.pendingQuestion}</p>}
      {task.body?.trim() ? <Markdown>{task.body}</Markdown> : <Empty>No body.</Empty>}
      <ExecutionBlock payload={data.execution} />

      <section>
        <h3>Runs that touched it</h3>
        {data.runs.length ? <RunStrip runs={data.runs} /> : <Empty>No run has claimed or reported on this task.</Empty>}
      </section>

      <section>
        <h3>Timeline</h3>
        <p className="ws-section-note">Ordered by seq. Gaps are normal — a deduplicated re-derivation still consumes a sequence value.</p>
        <Timeline events={data.timeline} />
      </section>
    </article>
  )
}
