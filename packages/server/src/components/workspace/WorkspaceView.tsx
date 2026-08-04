import { Suspense, lazy, useState } from 'react'

import { fetchInbox, type InboxCounts } from './api'
import { DocsPane } from './DocsPane'
import { InboxPane } from './InboxPane'
import { LoopsPane } from './LoopsPane'
import { TasksPane } from './TasksPane'
import { Glyph, Loading } from './parts'
import { affectsTasks, LiveProvider, useLiveStatus, useLiveView } from './useLiveView'

/**
 * THE WORKSPACE SHELL — five screens over the rewrite kernel, wearing the graph
 * workspace's design language (unit 8).
 *
 * The shape is the reference's: a `240px` sticky rail carrying the brand mark, a
 * nav whose rows are glyph / label / count, and a bottom status block; then one
 * scrolling `main` that every screen fills with a centered document column. Five
 * screens rather than the reference's five different ones, but the same furniture
 * — which is the whole point of the adoption.
 *
 * The order of the rail is the argument: Inbox first, because the inbox is the
 * product's front door and the only surface a human is required to visit.
 * Everything else is available, not required.
 *
 * THE BADGE is not decoration. The rail carries the inbox total live, so the §6
 * safety floor is legible from any screen — you never have to be on the Inbox to
 * learn that something is waiting. It rides the same SSE bus every pane uses, so
 * it moves with no user action.
 *
 * Mounted only under the flagged `/dev/workspace` route — the shipping dashboard
 * is untouched by this unit.
 */

const SystemGraph = lazy(() => import('./SystemGraph'))

type ViewName = 'inbox' | 'tasks' | 'loops' | 'docs' | 'system'

const VIEWS: { key: ViewName; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'loops', label: 'Loops' },
  { key: 'docs', label: 'Docs' },
  { key: 'system', label: 'System' },
]

export function WorkspaceView() {
  return (
    <LiveProvider>
      <WorkspaceShell />
    </LiveProvider>
  )
}

function WorkspaceShell() {
  const [view, setView] = useState<ViewName>('inbox')
  const [task, setTask] = useState<string | null>(null)
  const [loop, setLoop] = useState<string | null>(null)
  const [doc, setDoc] = useState<string | null>(null)

  const openTask = (id: string) => {
    setTask(id)
    setView('tasks')
  }
  const openLoop = (id: string) => {
    setLoop(id)
    setView('loops')
  }

  return (
    <div className="loopany-workspace">
      <a className="skip-link" href="#ws-main">
        Skip to content
      </a>
      <Rail view={view} setView={setView} />
      <main id="ws-main" className="main-content">
        {view === 'inbox' && <InboxPane onOpenTask={openTask} onOpenLoop={openLoop} />}
        {view === 'tasks' && <TasksPane selected={task} onSelect={setTask} onOpenLoop={openLoop} />}
        {view === 'loops' && <LoopsPane selected={loop} onSelect={setLoop} onOpenTask={openTask} />}
        {view === 'docs' && <DocsPane selected={doc} onSelect={setDoc} onOpenLoop={openLoop} />}
        {view === 'system' && (
          <Suspense fallback={<Loading what="the system graph" />}>
            <SystemGraph />
          </Suspense>
        )}
      </main>
    </div>
  )
}

function Rail({ view, setView }: { view: ViewName; setView: (next: ViewName) => void }) {
  // The rail's own read of the inbox — the same endpoint the Inbox screen uses,
  // so the badge and the screen can never disagree about what is waiting.
  const { data } = useLiveView('rail:inbox', fetchInbox, affectsTasks)
  const waiting = data?.counts.total ?? 0

  return (
    <aside className="sidebar">
      <div className="workspace-brand">
        <div className="loop-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <strong>Loopany</strong>
          <small>workspace</small>
        </div>
      </div>
      <nav aria-label="Workspace">
        {VIEWS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={view === entry.key ? 'is-active' : ''}
            aria-current={view === entry.key ? 'page' : undefined}
            onClick={() => setView(entry.key)}
          >
            <Glyph name={entry.key} />
            <span>{entry.label}</span>
            {entry.key === 'inbox' && waiting > 0 && (
              <b className={data && data.counts.question > 0 ? 'is-waiting' : undefined}>{waiting}</b>
            )}
          </button>
        ))}
      </nav>
      <Freshness counts={data?.counts} />
    </aside>
  )
}

/**
 * Freshness, stated plainly, in the reference's bottom status block.
 *
 * Degraded is not an error state: the view endpoints are self-sufficient, so
 * polling every 30 s differs from the live stream only in latency — no feature is
 * unavailable and no state is unreachable. The second line is the workspace's own
 * vital sign, on the same footing: what the floor is currently holding.
 */
function Freshness({ counts }: { counts?: InboxCounts }) {
  const status = useLiveStatus()
  const copy: Record<string, string> = {
    connecting: 'connecting to the event stream…',
    live: 'live · updates arrive as events land',
    degraded: 'polling every 30s · the stream is retrying',
  }
  return (
    <div className={`sidebar-status is-${status}`} role="status">
      <span />
      <div>
        <strong>{status === 'degraded' ? 'polling every 30s' : status === 'live' ? 'live' : 'connecting…'}</strong>
        <small>{copy[status]}</small>
        {counts && (
          <small>
            {counts.total === 0
              ? 'nothing waiting on you'
              : `${counts.question} question${counts.question === 1 ? '' : 's'} waiting on you`}
          </small>
        )}
      </div>
    </div>
  )
}
