import { Suspense, lazy, useState } from 'react'

import { DocsPane } from './DocsPane'
import { InboxPane } from './InboxPane'
import { LoopsPane } from './LoopsPane'
import { TasksPane } from './TasksPane'
import { Glyph, Loading } from './parts'
import { LiveProvider, useLiveStatus } from './useLiveView'

/**
 * THE WORKSPACE SHELL — five screens over the rewrite kernel.
 *
 * Ported from the graph line's workspace shell and re-pointed at the new view
 * endpoints. Structure is the same (a left rail, one pane per screen, a lazily
 * loaded graph canvas); the data model underneath is not, so the screens follow
 * the new kernel's shape: **three object kinds, two task states, one inbox.**
 *
 * The order of the rail is the argument: Inbox first, because the inbox is the
 * product's front door and the only surface a human is required to visit.
 * Everything else is available, not required.
 *
 * Mounted only under the flagged `/dev/workspace` route — the shipping dashboard
 * is untouched by this unit.
 */

const SystemGraph = lazy(() => import('./SystemGraph'))

type ViewName = 'inbox' | 'tasks' | 'loops' | 'docs' | 'system'

const VIEWS: { key: ViewName; label: string; blurb: string }[] = [
  { key: 'inbox', label: 'Inbox', blurb: 'what is waiting on you' },
  { key: 'tasks', label: 'Tasks', blurb: 'our own work items' },
  { key: 'loops', label: 'Loops', blurb: 'standing automation' },
  { key: 'docs', label: 'Docs', blurb: 'content and run reports' },
  { key: 'system', label: 'System', blurb: 'the live projection' },
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
      <nav className="ws-rail" aria-label="Workspace">
        <div className="ws-brand">
          <b>Loopany</b>
          <small>workspace</small>
        </div>
        {VIEWS.map((entry) => (
          <button key={entry.key} type="button" className={`ws-rail-item ${view === entry.key ? 'is-active' : ''}`} aria-current={view === entry.key} onClick={() => setView(entry.key)}>
            <Glyph name={entry.key} />
            <span>
              <b>{entry.label}</b>
              <small>{entry.blurb}</small>
            </span>
          </button>
        ))}
        <FreshnessBadge />
      </nav>

      <main className="ws-main">
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

/**
 * Freshness, stated plainly. Degraded is not an error state: the view endpoints
 * are self-sufficient, so polling every 30 s differs from the live stream only
 * in latency — no feature is unavailable and no state is unreachable.
 */
function FreshnessBadge() {
  const status = useLiveStatus()
  const copy: Record<string, string> = {
    connecting: 'connecting to the event stream…',
    live: 'live · updates arrive as events land',
    degraded: 'polling every 30s · the stream is retrying',
  }
  return (
    <p className={`ws-freshness ws-freshness-${status}`} role="status">
      <i aria-hidden="true" />
      {copy[status]}
    </p>
  )
}
