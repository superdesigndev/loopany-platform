import { fetchLoop, fetchLoops, type CharterDiff, type LoopListRow, type TaskRow } from './api'
import { Markdown } from './Render'
import { Empty, Loading, Refusal, RunStrip, StateChip, Timeline, When } from './parts'
import { affectsLoop, useLiveView } from './useLiveView'

/**
 * LOOPS — the structure layer.
 *
 * A loop is an object whose BODY IS ITS CHARTER: an artifact whose content is
 * instructions. Its natural question is "is it healthy, when does it run next?",
 * never "is it done yet?" — its lifecycle is operational (active ⇄ paused →
 * retired) and it never closes by finishing work, which is why this page shows
 * health and cadence where a task page shows a finish line.
 *
 * The charter history is the audit window design §4 names: `loop evolve` is a
 * FREE zone (a run rewrites its own charter, ownership-checked), so the diffs
 * landing in events are what makes self-evolution reviewable after the fact.
 */
export function LoopsPane({ selected, onSelect, onOpenTask }: { selected: string | null; onSelect: (id: string | null) => void; onOpenTask: (id: string) => void }) {
  const { data, error, loading } = useLiveView('loops', fetchLoops)
  return (
    <div className="ws-split">
      <div className="ws-pane ws-list-pane">
        <header className="ws-pane-head">
          <div>
            <h1>Loops</h1>
            <p>Standing automation. Health comes from runs; cadence comes from cron; neither is a state anyone types.</p>
          </div>
        </header>
        {error && !data ? <Refusal error={error} /> : null}
        {!data && !error ? <Loading what="loops" /> : null}
        {data && data.loops.length === 0 && <Empty>No loops in this team yet.</Empty>}
        {data && (
          <ul className="ws-rows">
            {data.loops.map((loop) => (
              <LoopListItem key={loop.id} loop={loop} selected={loop.id === selected} onSelect={onSelect} />
            ))}
          </ul>
        )}
        {loading && data && <p className="ws-refreshing">refreshing…</p>}
      </div>
      <div className="ws-pane ws-detail-pane">
        {selected ? <LoopDetail id={selected} onOpenTask={onOpenTask} /> : <Empty>Select a loop to read its charter, its evolve diffs and the work it is on the hook for.</Empty>}
      </div>
    </div>
  )
}

function LoopListItem({ loop, selected, onSelect }: { loop: LoopListRow; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={`ws-row ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(loop.id)}>
        <span className="ws-row-title">{loop.title ?? loop.id}</span>
        <span className="ws-row-meta">
          <StateChip state={loop.health.lastOutcome} />
          {loop.status !== 'active' && <span className="ws-chip ws-chip-paused">{loop.status}</span>}
          <span className="ws-cadence">{loop.cronText ?? 'no cadence'}</span>
          {loop.questionsWaiting > 0 && <span className="ws-chip ws-chip-question">{loop.questionsWaiting} waiting</span>}
          <span className="ws-row-watcher">{loop.openTasks} open</span>
          <When iso={loop.health.lastRunAt} />
        </span>
      </button>
    </li>
  )
}

function LoopDetail({ id, onOpenTask }: { id: string; onOpenTask: (id: string) => void }) {
  const { data, error } = useLiveView(`loop:${id}`, () => fetchLoop(id), affectsLoop(id))
  if (error && !data) return <Refusal error={error} />
  if (!data) return <Loading what="the loop" />
  const { loop, health } = data

  return (
    <article className="ws-detail">
      <header className="ws-detail-head">
        <h2>{loop.title ?? loop.id}</h2>
        <code className="ws-id">{loop.id}</code>
        <div className="ws-detail-facets">
          <span className={`ws-chip ws-chip-${loop.status === 'active' ? 'open' : 'paused'}`}>{loop.status}</span>
          <span className="ws-facet">cadence: {loop.cronText ?? '—'}</span>
          {loop.cron && <code className="ws-id">{loop.cron}</code>}
          <When iso={loop.nextFire} prefix="next fire" />
        </div>
      </header>

      <section className="ws-health">
        <h3>Health</h3>
        <dl className="ws-counts">
          <div>
            <dt>last outcome</dt>
            <dd>
              <StateChip state={health.lastOutcome} />
            </dd>
          </div>
          <div>
            <dt>last run</dt>
            <dd>
              <When iso={health.lastRunAt} />
            </dd>
          </div>
          <div>
            <dt>7d success / failure</dt>
            <dd>
              {health.runs7d.success} / {health.runs7d.failure}
            </dd>
          </div>
          <div>
            <dt>7d cost</dt>
            <dd>${health.costs7d.usd.toFixed(2)}</dd>
          </div>
          <div>
            <dt>failure streak</dt>
            <dd>{health.consecutiveFailures}</dd>
          </div>
        </dl>
        {health.consecutiveFailures > 0 && (
          <p className="ws-section-note">
            Consecutive failures auto-pause a loop and raise a question here. Time never un-pauses a loop — a human does.
          </p>
        )}
      </section>

      <section>
        <h3>Charter</h3>
        <p className="ws-section-note">The loop's body IS its prompt. A run may rewrite it in the free zone; the cadence is the keyed zone.</p>
        <div className="ws-charter">{loop.body.trim() ? <Markdown>{loop.body}</Markdown> : <Empty>No charter recorded.</Empty>}</div>
      </section>

      <section>
        <h3>Charter history</h3>
        {data.charterHistory.length ? <CharterHistory entries={data.charterHistory} /> : <Empty>This charter has not been evolved yet.</Empty>}
      </section>

      <section>
        <h3>Open work</h3>
        <TaskGroup title="Watching" note="what this loop is on the hook for" rows={data.openTasks.watching} onOpenTask={onOpenTask} />
        <TaskGroup title="Created" note="what it has put into the world" rows={data.openTasks.created} onOpenTask={onOpenTask} />
        <TaskGroup title="Questions" note="what it is blocked on" rows={data.openTasks.questions} onOpenTask={onOpenTask} />
        <p className="ws-section-note">A task can appear in more than one section — these are sections, not a partition.</p>
      </section>

      <section>
        <h3>Recent runs</h3>
        <RunStrip runs={data.recentRuns} />
      </section>

      <section>
        <h3>Timeline</h3>
        <Timeline events={data.events} emptyNote="No events on this loop yet." />
      </section>
    </article>
  )
}

function TaskGroup({ title, note, rows, onOpenTask }: { title: string; note: string; rows: TaskRow[]; onOpenTask: (id: string) => void }) {
  return (
    <div className="ws-task-group">
      <h4>
        {title} <small>{note}</small>
      </h4>
      {rows.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <ul className="ws-rows">
          {rows.map((task) => (
            <li key={task.id}>
              <button type="button" className="ws-row" onClick={() => onOpenTask(task.id)}>
                <span className="ws-row-title">{task.title ?? task.id}</span>
                <span className="ws-row-meta">
                  {task.pendingQuestion?.trim() && <span className="ws-chip ws-chip-question">question</span>}
                  {task.due && <span className="ws-chip ws-chip-due">due</span>}
                  <When iso={task.followUpAt ?? task.updatedAt} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CharterHistory({ entries }: { entries: CharterDiff[] }) {
  return (
    <ol className="ws-timeline">
      {entries.map((entry) => {
        const body = entry.diff.body as { old?: unknown; new?: unknown } | undefined
        return (
          <li key={entry.event} className={`ws-event ws-entrance-${entry.entrance}`}>
            <div className="ws-event-head">
              <b>charter evolved</b>
              <span className="ws-entrance">{entry.entrance}</span>
              <code>{entry.actor}</code>
              <When iso={entry.ts} />
              <small className="ws-seq">seq {entry.seq}</small>
            </div>
            {body && (
              <div className="ws-charter-diff">
                <pre className="ws-old">{String(body.old ?? '')}</pre>
                <pre className="ws-new">{String(body.new ?? '')}</pre>
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
