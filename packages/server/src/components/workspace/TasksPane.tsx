import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { fetchTask, fetchTasks, patchWatcher, postClose, type BoardColumn, type TaskCard } from './api'
import { cardActions, hasActions } from './board'
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
 * **The board is a layout, not a control surface.** Cards are not dragged: a
 * column renders a fact, and a task changes because a person closes it, hands it
 * to a loop, or takes it back — the three human entrances the kernel has, each
 * an explicit button on the card. `board.ts` holds which a card offers, pure and
 * tested; the server re-decides every write anyway, and a refusal is shown
 * verbatim.
 */

export function TasksPane({ selected, onSelect, onOpenLoop }: { selected: string | null; onSelect: (id: string | null) => void; onOpenLoop: (id: string) => void }) {
  const { data, error, loading, refresh } = useLiveView('tasks:board', () => fetchTasks(), affectsTasks)
  const [pendingClose, setPendingClose] = useState<TaskCard | null>(null)
  const [failure, setFailure] = useState<Error | undefined>(undefined)

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
          <div className="ws-board">
            {data.columns.map((column) => (
              <Column
                key={column.key}
                column={column}
                selected={selected}
                loops={data.loops}
                onSelect={onSelect}
                onClaim={(card, loop) => run(() => patchWatcher(card.id, loop))}
                onAskClose={setPendingClose}
                onRelease={(card) => run(() => patchWatcher(card.id, null))}
              />
            ))}
          </div>
        )}
        {data?.truncated && (
          <p className="ws-empty">
            More tasks exist than this board shows — the board is capped per column. Close what is done, or list the rest with the CLI.
          </p>
        )}
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
  column, selected, loops, onSelect, onClaim, onAskClose, onRelease,
}: {
  column: BoardColumn
  selected: string | null
  loops: { id: string; title: string | null }[]
  onSelect: (id: string) => void
  onClaim: (card: TaskCard, loop: string) => void
  onAskClose: (card: TaskCard) => void
  onRelease: (card: TaskCard) => void
}) {
  return (
    <section className="ws-column">
      <header className="ws-column-head">
        <h2>
          {column.label}
          <span className="ws-column-count">{column.tasks.length}</span>
        </h2>
        <p>{column.rule}</p>
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
 * The button row is THE write surface — there is no drag path beside it, so
 * every write is a labelled, keyboard-reachable act, and each button is offered
 * only where `board.ts` says a human entrance exists.
 */
function BoardCard({
  card, selected, loops, onSelect, onClaim, onAskClose, onRelease,
}: {
  card: TaskCard
  selected: boolean
  loops: { id: string; title: string | null }[]
  onSelect: (id: string) => void
  onClaim: (card: TaskCard, loop: string) => void
  onAskClose: (card: TaskCard) => void
  onRelease: (card: TaskCard) => void
}) {
  const asking = Boolean(card.pendingQuestion?.trim())
  const { canClose, canClaim, canRelease } = cardActions(card)

  return (
    <li className={`ws-task-card ${selected ? 'is-selected' : ''} ${asking ? 'is-question' : ''}`}>
      <button type="button" className="ws-task-title" onClick={() => onSelect(card.id)}>
        {card.title ?? card.id}
      </button>
      <div className="ws-task-meta">
        <span className="ws-task-watcher">{card.watcherLoop?.title ?? (card.watcher ? card.watcher : 'unclaimed')}</span>
        {asking && <span className="ws-chip ws-chip-question">question</span>}
        {card.due && card.status === 'open' && <span className="ws-chip ws-chip-due">overdue</span>}
        <When iso={card.status === 'closed' ? card.closedAt ?? card.updatedAt : card.followUpAt ?? card.updatedAt} />
      </div>
      {hasActions(card) && (
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
  const form = useRef<HTMLFormElement>(null)
  // `aria-modal` is a promise to the user that the dialog owns the keyboard, so
  // it also has to keep it: Escape cancels, and Tab cycles inside the form
  // rather than wandering back into the board behind it.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab' || !form.current) return
    const focusable = [...form.current.querySelectorAll<HTMLElement>('textarea, button:not([disabled])')]
    if (!focusable.length) return
    const edge = event.shiftKey ? focusable[0]! : focusable[focusable.length - 1]!
    if (document.activeElement !== edge) return
    event.preventDefault()
    ;(event.shiftKey ? focusable[focusable.length - 1]! : focusable[0]!).focus()
  }
  return (
    <div className="ws-note-backdrop" role="dialog" aria-modal="true" aria-label={`Close ${card.title ?? card.id}`} onKeyDown={onKeyDown}>
      <form
        ref={form}
        className="ws-note"
        onSubmit={(event) => {
          event.preventDefault()
          if (note.trim()) onConfirm(note.trim())
        }}
      >
        <h3>Close “{card.title ?? card.id}”</h3>
        <p>Closing is one-way — there is no transition back to open. One sentence attesting why it is done is required, and it is recorded on the task-closed event.</p>
        <label htmlFor="ws-close-note">Why is it done?</label>
        <textarea
          id="ws-close-note"
          name="note"
          autoFocus
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          placeholder="Merged as #197; nothing left to watch."
        />
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
