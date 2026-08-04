import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  fetchTask, fetchTasks, patchWatcher, postClose, postVerdict, ViewError,
  type BoardColumn, type TaskCard, type TaskView, type TasksView,
} from './api'
import { cardActions, hasActions } from './board'
import { flattenColumns, groupTasks, readTasksView, writeTasksView, type TaskGroup, type TasksViewMode } from './taskList'
import { ExecutionBlock, Markdown } from './Render'
import {
  ArtifactRow, BigState, CountStrip, Drawer, DrawerHead, DrawerSection, Empty, Glyph, Loading, Refusal, RunStrip, Section, Timeline, ViewHeader, When,
} from './parts'
import { affectsObject, affectsTasks, useLiveView } from './useLiveView'

/**
 * TASKS — a grouped row list by default, a kanban board on request, and the task
 * itself in the workspace's drawer.
 *
 * Captain direction (2026-08-04) reshaped this screen on three points, and each
 * one is a rule rather than a preference:
 *
 *  1. **A card carries no action.** Every write — claim, release, close — moved
 *     into the drawer. A list is for reading; acting on a task means opening it,
 *     which is also where the payload, the timeline and the runs that touched it
 *     are, so a person decides with the whole record in front of them instead of
 *     from a two-line summary. Rows and cards are therefore pure entrances: one
 *     target, one outcome, nothing to mis-click.
 *  2. **The list is the default.** One task per line reads as a worklist and
 *     scales past the width a five-column board has; the board stays as the
 *     alternate view for the state question ("what is waiting on whom"), behind
 *     a toggle that is REMEMBERED (`taskList.ts`, localStorage, like the System
 *     canvas's pins).
 *  3. **The list groups by loop.** `groupTasks` is the one mapping — unclaimed
 *     pool first (the §6 floor), then a section per watching loop, then closed.
 *     Pure and total, for the same reason the board's column mapping is.
 *
 * Both views render the SAME `/api/views/tasks` payload, ride the same SSE bus,
 * and show the same safety-floor counters, so switching changes the shape of the
 * page and nothing about what is true. There is still no drag surface anywhere
 * (standing product decision) — and now there is no on-card control either, so
 * the only write path on this screen is the drawer.
 */

/** What a write needs to know about its subject: the id it acts on and the
 *  title the confirmation names. Deliberately not a whole card — the drawer is
 *  reachable from screens that never had one. */
type TaskTarget = { id: string; title: string | null }

export function TasksPane({ selected, onSelect, onOpenLoop }: { selected: string | null; onSelect: (id: string | null) => void; onOpenLoop: (id: string) => void }) {
  const { data, error, loading, refresh } = useLiveView('tasks:board', () => fetchTasks(), affectsTasks)
  const [mode, setMode] = useState<TasksViewMode>(() => readTasksView(typeof window === 'undefined' ? undefined : window.localStorage))
  const [pendingClose, setPendingClose] = useState<TaskTarget | null>(null)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  // The row that opened the drawer, so closing hands the keyboard back to where
  // it came from rather than dropping it on the document.
  const opener = useRef<HTMLElement | null>(null)

  const choose = (next: TasksViewMode) => {
    setMode(next)
    writeTasksView(typeof window === 'undefined' ? undefined : window.localStorage, next)
  }

  const open = (id: string, from?: HTMLElement | null) => {
    opener.current = from ?? null
    onSelect(id)
  }

  const close = () => {
    onSelect(null)
    const row = opener.current
    opener.current = null
    if (row?.isConnected) row.focus()
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

  if (error && !data) {
    return <BigState title="The board is not answering">{error.message}</BigState>
  }

  const total = data ? data.columns.reduce((sum, column) => sum + column.tasks.length, 0) : 0

  return (
    <div className="board-view">
      <ViewHeader
        eyebrow="Tasks"
        title="Tasks"
        description="Our own work items. Never a shadow of an external object — a PR lives on GitHub and enters here only as payload facts."
        meta={data ? <ViewToggle mode={mode} total={total} onChoose={choose} /> : undefined}
      />
      {data && <CountStrip counts={data.counts} />}

      {!data && !error ? <Loading what="the board" /> : null}
      {failure && <Refusal error={failure} />}

      {data && mode === 'list' && <TaskList columns={data.columns} selected={selected} onOpen={open} />}
      {data && mode === 'board' && (
        <div className="board">
          {data.columns.map((column) => (
            <Column key={column.key} column={column} selected={selected} onOpen={open} />
          ))}
        </div>
      )}

      {data?.truncated && (
        <p className="ws-empty">
          More tasks exist than this screen shows — the page is capped. Close what is done, or list the rest with the CLI.
        </p>
      )}
      {loading && data && <p className="ws-refreshing">refreshing…</p>}

      {selected && (
        <Drawer kicker="Task" onClose={close}>
          <TaskDetail
            id={selected}
            loops={data?.loops ?? []}
            onOpenLoop={onOpenLoop}
            onClaim={(target, loop) => run(() => patchWatcher(target.id, loop))}
            onRelease={(target) => run(() => patchWatcher(target.id, null))}
            onAskClose={setPendingClose}
          />
        </Drawer>
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

/**
 * The two shapes of this one screen. A segmented pair rather than a dropdown:
 * there are exactly two, both are one click away, and the pressed state says
 * which you are in without opening anything.
 */
function ViewToggle({ mode, total, onChoose }: { mode: TasksViewMode; total: number; onChoose: (next: TasksViewMode) => void }) {
  return (
    <span className="tasks-view-meta">
      <span>{total} task{total === 1 ? '' : 's'}</span>
      <span className="doc-toggle" role="group" aria-label="Tasks layout">
        <button type="button" aria-pressed={mode === 'list'} onClick={() => onChoose('list')}>
          List
        </button>
        <button type="button" aria-pressed={mode === 'board'} onClick={() => onChoose('board')}>
          Board
        </button>
      </span>
    </span>
  )
}

/** THE DEFAULT VIEW — one task per line, under the loop that owns it. */
function TaskList({ columns, selected, onOpen }: { columns: BoardColumn[]; selected: string | null; onOpen: (id: string, from?: HTMLElement | null) => void }) {
  const groups = groupTasks(flattenColumns(columns))
  if (!groups.length) return <Empty>No tasks yet. Loops file them as they work; you can open one from the CLI too.</Empty>
  return (
    <div className="tasks-list">
      {groups.map((group) => (
        <TaskGroupSection key={group.key} group={group} selected={selected} onOpen={onOpen} />
      ))}
    </div>
  )
}

function TaskGroupSection({ group, selected, onOpen }: { group: TaskGroup; selected: string | null; onOpen: (id: string, from?: HTMLElement | null) => void }) {
  return (
    <Section
      // A pool with work in it is the safety floor showing; a loop's desk and the
      // closed record are plain content.
      tone={group.kind === 'unclaimed' ? 'attention' : 'plain'}
      title={group.label}
      count={group.tasks.length}
      note={group.note}
    >
      <div className="artifact-list">
        {group.tasks.map((task) => (
          <TaskRowEntry key={task.id} task={task} selected={task.id === selected} onOpen={onOpen} />
        ))}
      </div>
    </Section>
  )
}

/**
 * A ROW is an entrance, nothing else. The badges are exactly the two facts that
 * change what a person would do next — a question waiting, and a follow-up date
 * that has arrived — and both survive the move to the list unchanged.
 */
function TaskRowEntry({ task, selected, onOpen }: { task: TaskCard; selected: boolean; onOpen: (id: string, from?: HTMLElement | null) => void }) {
  const asking = Boolean(task.pendingQuestion?.trim())
  const overdue = task.due && task.status === 'open'
  return (
    <ArtifactRow
      icon={asking ? 'question' : task.status === 'closed' ? 'close' : 'task'}
      iconTone={asking ? 'question' : 'task'}
      title={task.title ?? task.id}
      source={<>{task.creator?.title ?? task.createdByLoop ?? 'opened by you'}</>}
      badges={
        <>
          {asking && <span className="state-label state-human">question</span>}
          {overdue && <span className="state-label state-floor">overdue</span>}
          {task.status === 'closed' && <span className="state-label state-ok">closed</span>}
        </>
      }
      when={task.status === 'closed' ? (task.closedAt ?? task.updatedAt) : (task.followUpAt ?? task.updatedAt)}
      action={<span className="artifact-action">open ›</span>}
      selected={selected}
      onOpen={(event) => onOpen(task.id, event.currentTarget)}
      ariaLabel={`Open ${task.title ?? task.id}`}
    />
  )
}

/** THE ALTERNATE VIEW — the board, unchanged in what it says and stripped of
 *  what it used to do: a column renders a fact, a card opens the task. */
function Column({ column, selected, onOpen }: { column: BoardColumn; selected: string | null; onOpen: (id: string, from?: HTMLElement | null) => void }) {
  return (
    <section className="board-column">
      <div className="section-heading">
        <div>
          {column.key === 'waiting' && <span className="attention-dot" />}
          <h2>{column.label}</h2>
          <span className="board-column-count">{column.tasks.length}</span>
        </div>
        <p>{column.rule}</p>
      </div>
      <ul className="board-cards">
        {column.tasks.length === 0 && <li className="ws-empty">Nothing here.</li>}
        {column.tasks.map((card) => (
          <BoardCard key={card.id} card={card} selected={card.id === selected} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  )
}

/**
 * A card is COMPACT by design: title, watcher, and only the badges that change
 * what a person would do. It is now also PASSIVE — the whole card is one button
 * that opens the task, and every write lives in the drawer behind it.
 */
function BoardCard({ card, selected, onOpen }: { card: TaskCard; selected: boolean; onOpen: (id: string, from?: HTMLElement | null) => void }) {
  const asking = Boolean(card.pendingQuestion?.trim())

  return (
    <li className={`board-card ${selected ? 'is-selected' : ''} ${asking ? 'is-question' : ''}`}>
      <button
        type="button"
        className="board-card-title"
        onClick={(event) => onOpen(card.id, event.currentTarget)}
        aria-label={`Open ${card.title ?? card.id}`}
      >
        <span className={`artifact-icon ${asking ? 'icon-question' : 'icon-task'}`}>
          <Glyph name={asking ? 'question' : 'task'} />
        </span>
        <span>{card.title ?? card.id}</span>
      </button>
      <div className="board-card-meta">
        <span>{card.watcherLoop?.title ?? (card.watcher ? card.watcher : 'unclaimed')}</span>
        {card.due && card.status === 'open' && <span className="state-label state-floor">overdue</span>}
        <When iso={card.status === 'closed' ? (card.closedAt ?? card.updatedAt) : (card.followUpAt ?? card.updatedAt)} />
      </div>
    </li>
  )
}

/** The note the kernel requires to close. It is asked for BEFORE the write, so
 *  the person attests why the task is done rather than discovering a refusal. */
function CloseNote({ card, onCancel, onConfirm }: { card: TaskTarget; onCancel: () => void; onConfirm: (note: string) => void }) {
  const [note, setNote] = useState('')
  const form = useRef<HTMLFormElement>(null)
  // `aria-modal` is a promise to the user that the dialog owns the keyboard, so
  // it also has to keep it: Escape cancels, and Tab cycles inside the form
  // rather than wandering back into the screen behind it.
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
    <div className="note-scrim" role="dialog" aria-modal="true" aria-label={`Close ${card.title ?? card.id}`} onKeyDown={onKeyDown}>
      <form
        ref={form}
        className="note-dialog"
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
          className="field-text"
          name="note"
          autoFocus
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          placeholder="Merged as #197; nothing left to watch."
        />
        <div className="note-actions">
          <button type="button" className="attn-button is-quiet" onClick={onCancel}>
            cancel
          </button>
          <button type="submit" className="solid-button" disabled={!note.trim()}>
            close the task
          </button>
        </div>
      </form>
    </div>
  )
}

function TaskDetail({
  id, loops, onOpenLoop, onClaim, onRelease, onAskClose,
}: {
  id: string
  loops: TasksView['loops']
  onOpenLoop: (id: string) => void
  onClaim: (target: TaskTarget, loop: string) => void
  onRelease: (target: TaskTarget) => void
  onAskClose: (target: TaskTarget) => void
}) {
  const { data, error, refresh } = useLiveView(`task:${id}`, () => fetchTask(id), affectsObject(id))
  if (error && !data) {
    return (
      <div className="preview-document">
        <Refusal error={error} />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="preview-document">
        <Loading what="the task" />
      </div>
    )
  }
  const task = data.task

  return (
    <article className="preview-document">
      <DrawerHead
        kicker={task.status === 'closed' ? 'Closed task' : 'Open task'}
        title={task.title ?? task.id}
        facets={
          <>
            {/* Two states exist. Everything else that feels like one is a facet. */}
            <span className={`state-label ${task.status === 'closed' ? 'state-ok' : ''}`}>{task.status}</span>
            {task.pendingQuestion?.trim() && <span className="state-label state-human">question waiting</span>}
            {data.due && <span className="state-label state-floor">due</span>}
            <code className="ws-id">{task.id}</code>
          </>
        }
        meta={[
          [
            'watcher',
            data.watcherLoop ? (
              <button type="button" className="ws-link" onClick={() => onOpenLoop(data.watcherLoop!.id)}>
                {data.watcherLoop.title ?? data.watcherLoop.id}
              </button>
            ) : (
              'unclaimed pool'
            ),
          ],
          [
            'creator',
            data.creator ? (
              <button type="button" className="ws-link" onClick={() => onOpenLoop(data.creator!.id)}>
                {data.creator.title ?? data.creator.id}
              </button>
            ) : (
              'you'
            ),
          ],
          ['follow-up', <When iso={task.followUpAt} />],
          ['updated', <When iso={task.updatedAt} />],
        ]}
      />

      {task.pendingQuestion?.trim() && (
        <p className="inbox-question">
          <Glyph name="question" />
          {task.pendingQuestion}
        </p>
      )}

      <TaskActions view={data} loops={loops} onClaim={onClaim} onRelease={onRelease} onAskClose={onAskClose} onAnswered={refresh} />

      <ExecutionBlock payload={data.execution} />

      {task.body?.trim() ? <Markdown>{task.body}</Markdown> : <Empty>No body.</Empty>}

      <DrawerSection title="Runs that touched it">
        {data.runs.length ? <RunStrip runs={data.runs} /> : <Empty>No run has claimed or reported on this task.</Empty>}
      </DrawerSection>

      <DrawerSection title="Timeline" note="Ordered by seq. Gaps are normal — a deduplicated re-derivation still consumes a sequence value.">
        <Timeline events={data.timeline} />
      </DrawerSection>
    </article>
  )
}

/**
 * EVERY WRITE THIS SCREEN HAS, in one place, next to the record it acts on.
 *
 * `board.ts` still says which acts a task offers — the rule did not change when
 * the buttons moved, and it is still an AFFORDANCE layer: the kernel re-decides
 * each one and its refusal is rendered verbatim. The answer box is here for the
 * same reason: a task that is asking cannot be closed, so answering IS the move,
 * and a person should not have to leave for the Inbox to make it.
 */
function TaskActions({
  view, loops, onClaim, onRelease, onAskClose, onAnswered,
}: {
  view: TaskView
  loops: TasksView['loops']
  onClaim: (target: TaskTarget, loop: string) => void
  onRelease: (target: TaskTarget) => void
  onAskClose: (target: TaskTarget) => void
  onAnswered: () => void
}) {
  const task = view.task
  // The drawer opens from a row, from the Inbox, or from a loop page, so it
  // reads the three facts `board.ts` decides on off the task itself rather than
  // being handed a card.
  // Held HERE, not in the answer box: a successful answer clears the question,
  // which unmounts the box — and with it the one line saying what the answer
  // just did. The confirmation has to outlive the form that produced it.
  const [queued, setQueued] = useState<string | undefined>(undefined)
  const facts = { status: task.status, pendingQuestion: task.pendingQuestion, watcher: task.watcher }
  const target: TaskTarget = { id: task.id, title: task.title }
  const { canClose, canClaim, canRelease } = cardActions(facts)
  const asking = Boolean(task.pendingQuestion?.trim())

  if (!asking && !hasActions(facts)) {
    return (
      <DrawerSection title="Actions">
        {queued && <p className="inbox-queued">answer recorded · {queued}</p>}
        <Empty>A closed task is a record: there is no reopen, and nothing here can change it.</Empty>
      </DrawerSection>
    )
  }

  return (
    <DrawerSection title="Actions" note="The only write surface on this screen — rows and cards just open the task.">
      {asking && <AnswerBox taskId={task.id} onAnswered={onAnswered} onQueued={setQueued} />}
      {queued && <p className="inbox-queued">answer recorded · {queued}</p>}
      <div className="task-actions">
        {canClaim && (
          <label className="task-action-claim">
            <span className="ws-sr">claim for a loop</span>
            <select
              className="field-select"
              name={`claim-${task.id}`}
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) onClaim(target, event.target.value)
              }}
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
          <button type="button" className="attn-button is-quiet" onClick={() => onRelease(target)}>
            release
          </button>
        )}
        {canClose && (
          <button type="button" className="verdict-button" onClick={() => onAskClose(target)}>
            close…
          </button>
        )}
      </div>
      {!canClose && asking && (
        <p className="ws-note-line">Closing is withheld while a question is waiting — the kernel refuses it too. Answer first.</p>
      )}
    </DrawerSection>
  )
}

/**
 * The verdict, in the drawer. Identical in substance to the Inbox's box, because
 * it is the same one write: free text, recorded as the answer, the question
 * cleared, and one express run queued if a loop is watching. The platform never
 * parses it — Approve and Reject only prefill.
 */
function AnswerBox({ taskId, onAnswered, onQueued }: { taskId: string; onAnswered: () => void; onQueued: (line: string) => void }) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Error | undefined>(undefined)

  const send = async (text: string) => {
    if (!text.trim() || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await postVerdict(taskId, text.trim())
      onQueued(
        result.run
          ? result.run.alreadyQueued
            ? `joined the run already queued (${result.run.id})`
            : `queued ${result.run.id}`
          : 'no watcher — the answer sits on the record',
      )
      setAnswer('')
      onAnswered()
    } catch (cause) {
      setFailure(cause instanceof ViewError ? cause : new Error(String(cause)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="answer-box"
      onSubmit={(event) => {
        event.preventDefault()
        void send(answer)
      }}
    >
      <label htmlFor={`drawer-answer-${taskId}`}>Your answer</label>
      <textarea
        id={`drawer-answer-${taskId}`}
        className="field-text"
        value={answer}
        rows={3}
        placeholder="Free text. A reason is what lets the loop converge next time."
        onChange={(event) => setAnswer(event.target.value)}
      />
      <div className="answer-actions">
        <button type="button" className="verdict-button" disabled={busy} onClick={() => void send(answer.trim() || 'approve')}>
          Approve
        </button>
        <button type="button" className="attn-button" disabled={busy} onClick={() => void send(answer.trim() ? `reject: ${answer.trim()}` : 'reject')}>
          Reject
        </button>
        <button type="submit" className="solid-button" disabled={busy || !answer.trim()}>
          {busy ? 'Sending…' : 'Send answer'}
        </button>
      </div>
      {failure && <Refusal error={failure} />}
    </form>
  )
}
