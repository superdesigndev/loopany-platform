import { useRef, useState } from 'react'

import { fetchTask, fetchTasks, patchWatcher, postClose, ViewError, type BoardColumn, type BoardColumnKey, type TaskCard } from './api'
import { isDraggable, legalMove, type MoveVerdict } from './board'
import { ExecutionBlock, Markdown } from './Render'
import { Empty, Loading, Refusal, RunStrip, Timeline, When } from './parts'
import { affectsObject, affectsTasks, useLiveView } from './useLiveView'

/**
 * TASKS — a kanban board, and the task detail beside it.
 *
 * The board's columns are not a new vocabulary. The kernel gives a task two
 * states (`open → closed`) and three facets that decide what is true about an
 * open one — a pending question, a watcher, a follow-up date — and the five
 * columns are five cells of exactly that fact table. The mapping is server-side
 * and pure (`kernel/taskBoard.ts`), each column ships the one sentence that
 * explains it, and every card lands in exactly one column by construction.
 *
 * The board is still built from STATE predicates only. There is no time-window
 * column, because a window leaks work — which is the same reason the list it
 * replaced offered no window filter.
 *
 * **Dragging is bounded by the kernel, not by taste.** A drop is offered only
 * where a legal human entrance already exists: `close` (the one task transition,
 * note required) and `release` (clearing the `watcher` facet). `board.ts` holds
 * that rule, pure and tested; the server re-decides it anyway, and a refusal is
 * shown verbatim.
 */

const COLUMN_KEYS: BoardColumnKey[] = ['waiting', 'unclaimed', 'due', 'watched', 'closed']

export function TasksPane({ selected, onSelect, onOpenLoop }: { selected: string | null; onSelect: (id: string | null) => void; onOpenLoop: (id: string) => void }) {
  const { data, error, loading, refresh } = useLiveView('tasks:board', () => fetchTasks(), affectsTasks)
  const [dragging, setDragging] = useState<TaskCard | null>(null)
  const [over, setOver] = useState<BoardColumnKey | null>(null)
  const [pendingClose, setPendingClose] = useState<TaskCard | null>(null)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  // The card in hand is held in a REF as well as in state: state drives the
  // legal/illegal column hints (it must re-render), but `drop` must read the
  // card that was actually picked up, not whatever the closure captured at the
  // last render — a drop that arrives before React has re-rendered would
  // otherwise silently do nothing.
  const inHand = useRef<TaskCard | null>(null)
  // Picking a card up clears the last refusal: a refusal describes the move that
  // was just refused, and leaving it on screen would make it read as a standing
  // state of the board rather than an answer to one drop.
  const pickUp = (card: TaskCard | null) => { inHand.current = card; setDragging(card); if (card) setFailure(undefined) }

  const drop = async (column: BoardColumnKey) => {
    const card = inHand.current
    pickUp(null)
    setOver(null)
    if (!card) return
    const verdict = legalMove(card, column)
    if (!verdict.ok) {
      setFailure(new ViewError('ILLEGAL_MOVE', `${card.title ?? card.id} cannot move to ${column}`, verdict.reason))
      return
    }
    // A close needs a note, so it becomes a question to the person who dragged
    // rather than a silent write. A release does not, so it goes straight out.
    if (verdict.verb === 'close') { setPendingClose(card); return }
    await run(() => patchWatcher(card.id, null))
  }

  const run = async (write: () => Promise<unknown>) => {
    setFailure(undefined)
    try {
      await write()
      // The stream refetches on its own; this only removes the wait.
      refresh()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }

  return (
    <div className={`ws-board-pane ${selected ? 'has-detail' : ''}`}>
      <div className="ws-pane ws-board-main">
        <header className="ws-pane-head">
          <div>
            <h1>Tasks</h1>
            <p>Our own work items. Never a shadow of an external object — a PR lives on GitHub and enters here only as payload facts.</p>
          </div>
          {data && (
            <dl className="ws-counts">
              <div>
                <dt>questions</dt>
                <dd>{data.counts.question}</dd>
              </div>
              <div>
                <dt>due · unwatched</dt>
                <dd>{data.counts.dueUnwatched}</dd>
              </div>
              <div>
                <dt>orphan floor</dt>
                <dd>{data.counts.orphan}</dd>
              </div>
            </dl>
          )}
        </header>

        {error && !data ? <Refusal error={error} /> : null}
        {!data && !error ? <Loading what="the board" /> : null}
        {failure && <Refusal error={failure} />}

        {data && (
          <div className="ws-board" onDragEnd={() => { pickUp(null); setOver(null) }}>
            {data.columns.map((column) => (
              <Column
                key={column.key}
                column={column}
                selected={selected}
                dragging={dragging}
                isOver={over === column.key}
                loops={data.loops}
                onSelect={onSelect}
                onDragStart={pickUp}
                onDragOver={setOver}
                onDrop={drop}
                onClaim={(card, loop) => run(() => patchWatcher(card.id, loop))}
                onAskClose={setPendingClose}
                onRelease={(card) => run(() => patchWatcher(card.id, null))}
              />
            ))}
          </div>
        )}
        {data?.truncated && <p className="ws-empty">More tasks exist than this board shows — narrow it with a watcher or creator filter.</p>}
        {loading && data && <p className="ws-refreshing">refreshing…</p>}
      </div>

      {selected && (
        <aside className="ws-board-detail" aria-label="Task detail">
          <button type="button" className="ws-drawer-close" onClick={() => onSelect(null)}>
            close detail
          </button>
          <TaskDetail id={selected} onOpenLoop={onOpenLoop} />
        </aside>
      )}

      {pendingClose && (
        <CloseNote
          card={pendingClose}
          onCancel={() => setPendingClose(null)}
          onConfirm={async (note) => {
            setPendingClose(null)
            await run(() => postClose(pendingClose.id, note))
          }}
        />
      )}
    </div>
  )
}

function Column({
  column, selected, dragging, isOver, loops, onSelect, onDragStart, onDragOver, onDrop, onClaim, onAskClose, onRelease,
}: {
  column: BoardColumn
  selected: string | null
  dragging: TaskCard | null
  isOver: boolean
  loops: { id: string; title: string | null }[]
  onSelect: (id: string) => void
  onDragStart: (card: TaskCard) => void
  onDragOver: (key: BoardColumnKey | null) => void
  onDrop: (key: BoardColumnKey) => void
  onClaim: (card: TaskCard, loop: string) => void
  onAskClose: (card: TaskCard) => void
  onRelease: (card: TaskCard) => void
}) {
  // What WOULD happen if the card in hand were dropped here — computed by the
  // same pure rule that decides whether the write is attempted.
  const verdict: MoveVerdict | null = dragging ? legalMove(dragging, column.key) : null
  const state = verdict ? (verdict.ok ? 'is-legal' : 'is-illegal') : ''

  return (
    <section
      className={`ws-column ${state} ${isOver ? 'is-over' : ''}`}
      onDragOver={(event) => {
        if (!verdict?.ok) return
        event.preventDefault()
        onDragOver(column.key)
      }}
      onDragLeave={() => onDragOver(null)}
      onDrop={(event) => { event.preventDefault(); onDrop(column.key) }}
    >
      <header className="ws-column-head">
        <h2>
          {column.label}
          <span className="ws-column-count">{column.tasks.length}</span>
        </h2>
        <p>{column.rule}</p>
        {verdict && !verdict.ok && <p className="ws-column-refuse">{verdict.reason}</p>}
      </header>
      <ul className="ws-column-cards">
        {column.tasks.length === 0 && <li className="ws-empty">Nothing here.</li>}
        {column.tasks.map((card) => (
          <BoardCard
            key={card.id}
            card={card}
            selected={card.id === selected}
            loops={loops}
            onSelect={onSelect}
            onDragStart={onDragStart}
            onClaim={onClaim}
            onAskClose={onAskClose}
            onRelease={onRelease}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * A card is COMPACT by design: title, watcher, and only the badges that change
 * what a person would do — a question waiting, and a follow-up date that has
 * arrived. Everything else is one click away in the detail.
 *
 * The button row is not a second write path. It calls the same two endpoints the
 * drops call, past the same `legalMove` guard, and it exists so the board is
 * usable without a pointing device.
 */
function BoardCard({
  card, selected, loops, onSelect, onDragStart, onClaim, onAskClose, onRelease,
}: {
  card: TaskCard
  selected: boolean
  loops: { id: string; title: string | null }[]
  onSelect: (id: string) => void
  onDragStart: (card: TaskCard) => void
  onClaim: (card: TaskCard, loop: string) => void
  onAskClose: (card: TaskCard) => void
  onRelease: (card: TaskCard) => void
}) {
  const asking = Boolean(card.pendingQuestion?.trim())
  const canClose = legalMove(card, 'closed').ok
  const canRelease = legalMove(card, 'unclaimed').ok
  const canClaim = card.status === 'open' && !card.watcher

  return (
    <li
      className={`ws-task-card ${selected ? 'is-selected' : ''} ${asking ? 'is-question' : ''}`}
      draggable={isDraggable(card, COLUMN_KEYS)}
      onDragStart={(event) => {
        // Firefox refuses to start a drag with no data payload set.
        event.dataTransfer.setData('text/plain', card.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart(card)
      }}
    >
      <button type="button" className="ws-task-title" onClick={() => onSelect(card.id)}>
        {card.title ?? card.id}
      </button>
      <div className="ws-task-meta">
        <span className="ws-task-watcher">{card.watcherLoop?.title ?? (card.watcher ? card.watcher : 'unclaimed')}</span>
        {asking && <span className="ws-chip ws-chip-question">question</span>}
        {card.due && card.status === 'open' && <span className="ws-chip ws-chip-due">overdue</span>}
        <When iso={card.status === 'closed' ? card.closedAt ?? card.updatedAt : card.followUpAt ?? card.updatedAt} />
      </div>
      {(canClose || canRelease || canClaim) && (
        <div className="ws-task-actions">
          {canClaim && (
            <label>
              <span className="ws-sr">claim for a loop</span>
              <select
                name={`claim-${card.id}`}
                defaultValue=""
                onChange={(event) => { if (event.target.value) onClaim(card, event.target.value) }}
              >
                <option value="">claim…</option>
                {loops.map((loop) => (
                  <option key={loop.id} value={loop.id}>
                    {loop.title ?? loop.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canRelease && (
            <button type="button" onClick={() => onRelease(card)}>
              release
            </button>
          )}
          {canClose && (
            <button type="button" onClick={() => onAskClose(card)}>
              close…
            </button>
          )}
        </div>
      )}
    </li>
  )
}

/** The note the kernel requires to close. It is asked for BEFORE the write, so
 *  the person attests why the task is done rather than discovering a refusal. */
function CloseNote({ card, onCancel, onConfirm }: { card: TaskCard; onCancel: () => void; onConfirm: (note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <div className="ws-note-backdrop" role="dialog" aria-modal="true" aria-label={`Close ${card.title ?? card.id}`}>
      <form
        className="ws-note"
        onSubmit={(event) => {
          event.preventDefault()
          if (note.trim()) onConfirm(note.trim())
        }}
      >
        <h3>Close “{card.title ?? card.id}”</h3>
        <p>Closing is one-way — there is no transition back to open. One sentence attesting why it is done is required, and it is recorded on the task-closed event.</p>
        <textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="Merged as #197; nothing left to watch." />
        <div className="ws-note-actions">
          <button type="button" onClick={onCancel}>
            cancel
          </button>
          <button type="submit" disabled={!note.trim()}>
            close the task
          </button>
        </div>
      </form>
    </div>
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
