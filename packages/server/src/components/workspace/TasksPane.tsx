import { useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

import {
  fetchTask, fetchTasks, postDirective, postVerdict, ViewError,
  type BoardColumn, type MirrorRef, type TaskCard, type TaskRef, type TaskRow, type TaskView,
} from './api'
import { cardActions, hasActions, tellMode, type TellMode } from './board'
import { flattenColumns, groupTasks, parentRef, readTasksView, treeRows, writeTasksView, type TaskGroup, type TasksViewMode } from './taskList'
import { isDeletedLoop, loopLabel } from './loopLabel'
import { ExecutionBlock, Markdown } from './Render'
import {
  ArtifactRow, BigState, Drawer, DrawerHead, DrawerSection, Empty, Glyph, Loading, Refusal, RunStrip, Section, Timeline, ViewHeader, When,
} from './parts'
import { affectsObject, affectsTasks, useLiveView } from './useLiveView'

/**
 * TASKS — a grouped row list by default, a kanban board on request, and the task
 * itself in the workspace's drawer.
 *
 * Captain direction (2026-08-04) reshaped this screen on three points, and each
 * one is a rule rather than a preference:
 *
 *  1. **A card carries no action.** Every write moved into the drawer. A list is for reading; acting on a task means opening it,
 *     which is also where the payload, the timeline and the runs that touched it
 *     are, so a person decides with the whole record in front of them instead of
 *     from a two-line summary. Rows and cards are therefore pure entrances: one
 *     target, one outcome, nothing to mis-click.
 *  2. **The list is the default.** One task per line reads as a worklist and
 *     scales past the width a five-column board has; the board stays as the
 *     alternate view for the state question ("what is waiting on whom"), behind
 *     a toggle that is REMEMBERED (`taskList.ts`, localStorage, like the System
 *     canvas's pins).
 *  3. **The list groups by loop.** `groupTasks` is the one mapping — a section
 *     per watching loop, then closed. Every open task is under a loop, because
 *     every task names one (`kernel/types.ts` WATCHER_HINT), so the grouping is
 *     a complete partition of the desks rather than a partition plus a leftover
 *     pile. Pure and total, for the same reason the board's column mapping is.
 *
 * Both views render the SAME `/api/views/tasks` payload and ride the same SSE
 * bus, so switching changes the shape of the page and nothing about what is
 * true. The screen counts TASKS, once, in its header: the "questions waiting on
 * you" stat block it used to carry duplicated the Inbox's whole job on a page
 * whose job is the worklist. There is still no drag surface anywhere
 * (standing product decision) — and now there is no on-card control either, so
 * the only write path on this screen is the drawer.
 *
 * **THE DRAWER HAS NO CLOSE BUTTON** (captain direction 2026-08-04), and that is
 * a fourth rule rather than a trimmed feature. The expected end of a task is
 * that its WATCHER closes it, from its own workflow logic or in response to a
 * directive left here. A person closing it from this screen settles the kernel's
 * record while the world it describes carries on unchanged — the PR still open,
 * the branch still there, and the loop that would have cleaned them up now
 * looking at a closed task it will never act on again. What replaces it is the
 * Tell-the-watcher composer: say what you want to happen, and the loop
 * reconciles reality and then the record, in that order. `loopany task close`
 * remains as the deep emergency hatch for a broken watcher, on the CLI, where
 * the person running it can see they are taking the reconciliation on
 * themselves.
 *
 * The drawer's surfaces are therefore: the verbatim execution block, the
 * external items, the timeline, and the composer.
 */

export function TasksPane({ selected, onSelect, onOpenLoop }: { selected: string | null; onSelect: (id: string | null) => void; onOpenLoop: (id: string) => void }) {
  const { data, error, loading } = useLiveView('tasks:board', () => fetchTasks(), affectsTasks)
  const [mode, setMode] = useState<TasksViewMode>(() => readTasksView(typeof window === 'undefined' ? undefined : window.localStorage))
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

  if (error && !data) {
    return <BigState title="The board is not answering">{error.message}</BigState>
  }

  const total = data ? data.columns.reduce((sum, column) => sum + column.tasks.length, 0) : 0

  return (
    <div className="board-view">
      <ViewHeader
        eyebrow="Tasks"
        title="Tasks"
        description="Work items your loops opened, grouped by the loop that acts next."
        meta={data ? <ViewToggle mode={mode} total={total} onChoose={choose} /> : undefined}
      />

      {!data && !error ? <Loading what="the board" /> : null}

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
            onOpenLoop={onOpenLoop}
            // Walking the tree REPLACES the drawer's subject rather than stacking
            // a second one: the opener (the row that started this) is kept, so
            // closing after two hops still hands the keyboard back to the list.
            onOpenTask={(next) => onSelect(next)}
          />
        </Drawer>
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
  // The tree is assembled INSIDE the group, never across groups: grouping stays
  // "whose work is this", and hierarchy is orthogonal to it (`taskList.ts`).
  const rows = treeRows(group.tasks)
  return (
    <Section
      // A loop's desk and the closed record are both plain content — there is no
      // group here whose mere existence is a problem to flag.
      //
      // Title plus a small muted count, and nothing else: the right-hand
      // "Open work this loop is watching · 1 task" annotation this used to carry
      // said the same thing the heading and the count already said, twice.
      tone="plain"
      title={group.label}
      count={group.tasks.length}
    >
      <div className="artifact-list">
        {rows.map((row) => (
          <TaskRowEntry
            key={row.task.id}
            task={row.task}
            // The group is a WATCHER's desk and the row's source line is the
            // CREATOR, which is usually the same loop — so under `Housekeeper`
            // every row said "Housekeeper" again. Telling the row which desk it
            // is on lets it print the creator only when that is a second fact.
            groupWatcher={group.kind === 'loop' ? group.key : null}
            depth={row.depth}
            detached={row.detached}
            selected={row.task.id === selected}
            onOpen={onOpen}
          />
        ))}
      </div>
    </Section>
  )
}

/** How far the indent actually travels. The DEPTH stays true (the tree is not
 *  re-rooted); only the offset stops growing, so a deep chain leans instead of
 *  marching the titles off the right edge. */
const MAX_INDENT = 6

/**
 * The chip a card or row wears when it belongs to a parent the layout cannot
 * show it under — a parent watched by another loop, or one off this page.
 *
 * It is TEXT, not a link, on both surfaces: a row and a card are each ONE button
 * that opens the task (the standing rule), so a nested control would be a button
 * inside a button. The navigable version of this reference lives in the drawer,
 * which is where every other act on a task lives too.
 */
function ParentChip({ parent }: { parent: TaskRef }) {
  if (!parent) return null
  return <span className="state-label">part of {parent.missing ? `deleted task ${parent.id}` : (parent.title ?? parent.id)}</span>
}

/**
 * A ROW is an entrance, nothing else. The badges are exactly the facts that
 * change what a person would do next — a question waiting, a follow-up date that
 * has arrived — plus, since S4, where this task sits in a tree when the indent
 * could not say it.
 */
function TaskRowEntry({ task, groupWatcher, depth, detached, selected, onOpen }: { task: TaskCard; groupWatcher: string | null; depth: number; detached: boolean; selected: boolean; onOpen: (id: string, from?: HTMLElement | null) => void }) {
  const asking = Boolean(task.pendingQuestion?.trim())
  const overdue = task.due && task.status === 'open'
  // A loop filing its own work is the ordinary case, and repeating the group's
  // name under every one of its rows says nothing. The line appears when the
  // task came from SOMEWHERE ELSE, which is the case worth reading.
  const creator = task.creator?.id ?? task.createdByLoop ?? null
  const fromElsewhere = groupWatcher === null || creator !== groupWatcher
  return (
    <div
      className="task-tree-row"
      data-depth={depth}
      data-nested={depth > 0 ? '1' : '0'}
      style={{ '--tree-depth': Math.min(depth, MAX_INDENT) } as CSSProperties}
    >
      <ArtifactRow
        icon={asking ? 'question' : task.status === 'closed' ? 'close' : 'task'}
        iconTone={asking ? 'question' : 'task'}
        title={task.title ?? task.id}
        source={fromElsewhere ? <>from {task.creator ? loopLabel(task.creator) : (task.createdByLoop ?? 'you')}</> : undefined}
        badges={
          <>
            {asking && <span className="state-label state-human">question</span>}
            {overdue && <span className="state-label state-floor">overdue</span>}
            {task.status === 'closed' && <span className="state-label state-ok">closed</span>}
            {detached && <ParentChip parent={parentRef(task)} />}
          </>
        }
        when={task.status === 'closed' ? (task.closedAt ?? task.updatedAt) : (task.followUpAt ?? task.updatedAt)}
        action={<span className="artifact-action">open ›</span>}
        selected={selected}
        onOpen={(event) => onOpen(task.id, event.currentTarget)}
        ariaLabel={`Open ${task.title ?? task.id}`}
      />
    </div>
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
 *
 * **THE BOARD IGNORES HIERARCHY except for the chip** (design §3). A column is a
 * STATE predicate, and nesting cards inside one would mean a child is shown
 * somewhere its own state does not put it — the board's whole claim is that a
 * card's column is true of that card. So a parent is named, never drawn.
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
        <span>{loopLabel(card.watcherLoop, card.watcher)}</span>
        <ParentChip parent={parentRef(card)} />
        {card.due && card.status === 'open' && <span className="state-label state-floor">overdue</span>}
        <When iso={card.status === 'closed' ? (card.closedAt ?? card.updatedAt) : (card.followUpAt ?? card.updatedAt)} />
      </div>
    </li>
  )
}

/**
 * EXTERNAL ITEMS — the mirrors attached to this task.
 *
 * A mirror is a pointer to something outside the system, and this section says
 * exactly that much: which kind, its coords, and the label somebody gave it. It
 * shows no status, because there is none to show — a mirror tells you WHERE to
 * look, never WHAT state it is in, and the kernel's schema has nowhere to record
 * one. A person reading this goes and looks; so does the loop.
 *
 * The coords are a LINK when they resolve to one, and the server decides that
 * (`href`) rather than the client re-deriving external URLs per kind.
 */
function ExternalItems({ mirrors }: { mirrors: MirrorRef[] }) {
  return (
    <DrawerSection
      title="External items"
      note="A pointer, never a copy — the state lives over there."
    >
      {mirrors.length === 0 ? (
        <Empty>Nothing external is attached. A run attaches one with `loopany mirror attach`.</Empty>
      ) : (
        <div className="artifact-list">
          {mirrors.map((mirror) => (
            <div className="artifact-row mirror-row" key={mirror.id}>
              <span className="artifact-icon icon-mirror">
                <Glyph name="mirror" />
              </span>
              <span className="artifact-main">
                <h3>
                  {mirror.href ? (
                    <a className="ws-link" href={mirror.href} target="_blank" rel="noreferrer noopener">
                      {mirror.coords}
                    </a>
                  ) : (
                    mirror.coords
                  )}
                </h3>
                {mirror.note && <p>{mirror.note}</p>}
              </span>
              <span className="artifact-badges">
                <span className="state-label">{mirror.externalKind}</span>
              </span>
              <When iso={mirror.updatedAt} />
              <span />
            </div>
          ))}
        </div>
      )}
    </DrawerSection>
  )
}

/**
 * SUB-TASKS — the other half of the hierarchy, and the only place it is
 * navigable.
 *
 * Rendered ONLY when there are children: an empty "Sub-tasks" section on every
 * ordinary task would teach that a task is supposed to have some. There is no
 * progress count and no roll-up either — a parent is closed by its watcher, never
 * by its last child (design §3), so a "2 of 3 done" line would imply a coupling
 * the two-status discipline forbids.
 */
function SubTasks({ children, onOpenTask }: { children: TaskRow[]; onOpenTask: (id: string) => void }) {
  return (
    <DrawerSection
      title="Sub-tasks"
      note="Each keeps its own watcher and its own ending — closing one closes nothing else."
    >
      <div className="artifact-list">
        {children.map((child) => (
          <ArtifactRow
            key={child.id}
            icon={child.pendingQuestion?.trim() ? 'question' : child.status === 'closed' ? 'close' : 'task'}
            iconTone={child.pendingQuestion?.trim() ? 'question' : 'task'}
            title={child.title ?? child.id}
            source={<>{loopLabel(child.watcherLoop, child.watcher)}</>}
            badges={
              <>
                {child.pendingQuestion?.trim() && <span className="state-label state-human">question</span>}
                {child.due && child.status === 'open' && <span className="state-label state-floor">overdue</span>}
                {child.status === 'closed' && <span className="state-label state-ok">closed</span>}
              </>
            }
            when={child.status === 'closed' ? (child.closedAt ?? child.updatedAt) : (child.followUpAt ?? child.updatedAt)}
            action={<span className="artifact-action">open ›</span>}
            onOpen={() => onOpenTask(child.id)}
            ariaLabel={`Open ${child.title ?? child.id}`}
          />
        ))}
      </div>
    </DrawerSection>
  )
}

function TaskDetail({
  id, onOpenLoop, onOpenTask,
}: {
  id: string
  onOpenLoop: (id: string) => void
  onOpenTask: (id: string) => void
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
            data.watcherLoop && !isDeletedLoop(data.watcherLoop) ? (
              <button type="button" className="ws-link" onClick={() => onOpenLoop(data.watcherLoop!.id)}>
                {loopLabel(data.watcherLoop)}
              </button>
            ) : (
              // A watcher is never empty, so this reads as what it is: the loop
              // that acts next, named — and when that loop has been deleted out
              // from under the task, a tombstone rather than a dead link.
              (data.watcherLoop ? loopLabel(data.watcherLoop) : (task.watcher ?? 'unresolved'))
            ),
          ],
          [
            'creator',
            data.creator && !isDeletedLoop(data.creator) ? (
              <button type="button" className="ws-link" onClick={() => onOpenLoop(data.creator!.id)}>
                {loopLabel(data.creator)}
              </button>
            ) : (
              (data.creator ? loopLabel(data.creator) : 'you')
            ),
          ],
          // THE PARENT, navigable. Present only when there is one — a "part of:
          // —" line on every root task would advertise a field a flat task is
          // not missing. A deleted parent reads as a tombstone, never as a link
          // into nothing (the same ruling `loopRefs.ts` makes for a watcher).
          ...(data.parent
            ? ([[
                'part of',
                data.parent.missing ? (
                  `deleted task ${data.parent.id}`
                ) : (
                  <button type="button" className="ws-link" onClick={() => onOpenTask(data.parent!.id)}>
                    {data.parent.title ?? data.parent.id}
                  </button>
                ),
              ]] as [string, ReactNode][])
            : []),
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

      <TaskActions view={data} onSpoke={refresh} />

      <ExecutionBlock payload={data.execution} />

      {task.body?.trim() ? <Markdown>{task.body}</Markdown> : <Empty>No body.</Empty>}

      {data.children && data.children.length > 0 && <SubTasks children={data.children} onOpenTask={onOpenTask} />}

      <ExternalItems mirrors={data.mirrors ?? []} />

      <DrawerSection title="Runs that touched it">
        {data.runs.length ? <RunStrip runs={data.runs} /> : <Empty>No run has claimed or reported on this task.</Empty>}
      </DrawerSection>

      <DrawerSection title="Timeline" note="Ordered by seq; gaps are normal.">
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
 * each one and its refusal is rendered verbatim.
 *
 * There is exactly ONE, and close is not it (see the module header). The
 * composer is always available on an open task, because talking to the watcher
 * is the way every task ends: answer the question it asked, or tell it what you
 * want to happen and let it reconcile reality and then the record.
 *
 * The second control — a picker that handed the task to a different loop — was
 * REMOVED (captain ruling 2026-08-05) along with the capability behind it: a
 * task keeps the watcher it was created with, and the kernel now refuses a
 * rewrite. Do not re-add a hand-off here without the ruling that asks for one.
 */
function TaskActions({
  view, onSpoke,
}: {
  view: TaskView
  onSpoke: () => void
}) {
  const task = view.task
  // The drawer opens from a row, from the Inbox, or from a loop page, so it
  // reads the facts `board.ts` decides on off the task itself rather than being
  // handed a card.
  // Held HERE, not in the composer: a successful ANSWER clears the question,
  // which flips the composer to directive mode and re-mounts it — and with it
  // would go the one line saying what the answer just did. The confirmation has
  // to outlive the form that produced it.
  const [queued, setQueued] = useState<string | undefined>(undefined)
  const facts = { status: task.status, pendingQuestion: task.pendingQuestion }
  const { canTell } = cardActions(facts)
  const mode = tellMode(facts)

  if (!hasActions(facts)) {
    return (
      <DrawerSection title="Actions">
        {queued && <p className="inbox-queued">{queued}</p>}
        <Empty>A closed task is a record: there is no reopen, and nothing here can change it.</Empty>
      </DrawerSection>
    )
  }

  return (
    <DrawerSection
      title="Actions"
      note="A task ends when its watcher closes it — telling the watcher is how you end one."
    >
      {canTell && <TellBox taskId={task.id} mode={mode} watcher={loopLabel(view.watcherLoop, task.watcher)} onSpoke={onSpoke} onQueued={setQueued} />}
      {queued && <p className="inbox-queued">{queued}</p>}
    </DrawerSection>
  )
}

/**
 * TELL THE WATCHER — one composer, two modes.
 *
 * When a question is pending it ANSWERS (the verdict); otherwise it leaves a
 * DIRECTIVE. Both are free text, both queue exactly one run for the watching
 * loop with this task in scope, and neither is parsed by the platform — so
 * making them two controls would advertise a difference the person does not
 * have to care about. `board.ts` `tellMode` decides which, so the rule is
 * testable without a DOM.
 *
 * Approve and Reject only PREFILL, and only in answer mode: they are a shortcut
 * for the two most common replies to a question, not a second structured API. A
 * directive has no such pair, because there is no proposal on the table to
 * approve.
 *
 * What the copy has to carry, and does: a directive is executed against REALITY
 * first and the kernel's records last. "Drop this bet" means close the PR, clean
 * up, then close the task — in that order.
 */
function TellBox({
  taskId, mode, watcher, onSpoke, onQueued,
}: {
  taskId: string
  mode: TellMode
  watcher: string | null
  onSpoke: () => void
  onQueued: (line: string) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const answering = mode === 'answer'

  const send = async (value: string) => {
    if (!value.trim() || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const result = answering ? await postVerdict(taskId, value.trim()) : await postDirective(taskId, value.trim())
      const what = answering ? 'answer recorded' : 'directive left'
      onQueued(
        result.run
          ? result.run.alreadyQueued
            ? `${what} · joined the run already queued (${result.run.id})`
            : `${what} · queued ${result.run.id}`
          : `${what} · it is on the record, but its watcher had no run to queue`,
      )
      setText('')
      onSpoke()
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
        void send(text)
      }}
    >
      <label htmlFor={`drawer-tell-${taskId}`}>{answering ? 'Your answer' : `Tell ${watcher ?? 'the watcher'}`}</label>
      <textarea
        id={`drawer-tell-${taskId}`}
        className="field-text"
        value={text}
        rows={3}
        placeholder={
          answering
            ? 'Free text. A reason is what lets the loop converge next time.'
            : 'Drop this bet — close the PR, clean up the branch, then close the task.'
        }
        onChange={(event) => setText(event.target.value)}
      />
      <p className="ws-note-line">
        {answering
          ? 'One run is queued for the watching loop, carrying your reply verbatim.'
          : 'One run is queued for the watching loop, carrying your words verbatim. It acts on the intent against the outside world first, and this record last.'}
      </p>
      <div className="answer-actions">
        {answering && (
          <>
            <button type="button" className="verdict-button" disabled={busy} onClick={() => void send(text.trim() || 'approve')}>
              Approve
            </button>
            <button type="button" className="attn-button" disabled={busy} onClick={() => void send(text.trim() ? `reject: ${text.trim()}` : 'reject')}>
              Reject
            </button>
          </>
        )}
        <button type="submit" className="solid-button" disabled={busy || !text.trim()}>
          {busy ? 'Sending…' : answering ? 'Send answer' : 'Send directive'}
        </button>
      </div>
      {failure && <Refusal error={failure} />}
    </form>
  )
}
