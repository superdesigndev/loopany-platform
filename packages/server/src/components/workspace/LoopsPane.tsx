import { useState } from 'react'

import { fetchLoop, fetchLoops, postRunNow, type CharterDiff, type LoopListRow, type RunNowResult, type TaskRow } from './api'
import { Markdown } from './Render'
import {
  ArtifactRow, BigState, Drawer, DrawerHead, DrawerSection, Empty, Loading, Refusal, RunStrip, Section, StateChip, Timeline, ViewHeader, When,
} from './parts'
import { affectsLoop, useLiveView } from './useLiveView'

/**
 * LOOPS — the structure layer.
 *
 * S3 reads THE production loop roster. A loop's standing brief comes from its
 * task file, health comes from production runs, and cadence comes from the
 * production schedule. Same-id kernel loop rows remain only as history anchors
 * until S5, so this pane never exposes their lifecycle controls.
 *
 * UNIT 8: the split list/detail became a document column plus the shared drawer,
 * matching every other screen. A loop that is holding a question is grouped into
 * its own amber section above the rest — the reference's "Needs you" idea applied
 * to structure, and the reason a paused-and-asking loop cannot hide in a long
 * list.
 *
 * UNIT 11: the drawer gained the screen's ONE write — `Run now`, the manual fire
 * the shipping dashboard has always offered. It lives on the detail surface and
 * not on the list row for a structural reason, not a taste one: `ArtifactRow` IS
 * a button (that is what makes the whole row one keyboard target), so a control
 * in its action slot would be a button inside a button — invalid markup with a
 * genuinely ambiguous click target. The row keeps its quiet `open ›` affordance
 * and the act itself is one click deeper, next to the cadence and health it
 * overrides.
 *
 * Schedule and pause edits point to the production owner surface. Run now stays
 * here because D1 deliberately ports the paused-loop one-shot behavior.
 */
export function LoopsPane({ selected, onSelect, onOpenTask }: { selected: string | null; onSelect: (id: string | null) => void; onOpenTask: (id: string) => void }) {
  const { data, error, loading } = useLiveView('loops', fetchLoops)

  if (error && !data) return <BigState title="Loops are not answering">{error.message}</BigState>
  if (!data && !error) return <Loading what="loops" />

  const loops = data?.loops ?? []
  const asking = loops.filter((loop) => loop.questionsWaiting > 0)
  const quiet = loops.filter((loop) => loop.questionsWaiting === 0)

  return (
    <div className="document-view">
      <ViewHeader
        eyebrow="Loops"
        title="Loops"
        description="Standing automation. Health comes from runs; cadence comes from cron; neither is a state anyone types."
        meta={`${loops.length} loop${loops.length === 1 ? '' : 's'}`}
      />

      {loops.length === 0 && <Empty>No loops in this team yet.</Empty>}

      {asking.length > 0 && (
        <Section tone="needs" title="Blocked on you" count={asking.length} note="These loops are holding a question">
          <div className="artifact-list attention-list">
            {asking.map((loop) => (
              <LoopRow key={loop.id} loop={loop} selected={loop.id === selected} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      )}

      {quiet.length > 0 && (
        <Section title="Running" count={quiet.length}>
          <div className="artifact-list">
            {quiet.map((loop) => (
              <LoopRow key={loop.id} loop={loop} selected={loop.id === selected} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      )}

      {loading && data && <p className="ws-refreshing">refreshing…</p>}

      {selected && (
        <Drawer kicker="Loop" onClose={() => onSelect(null)}>
          <LoopDetail id={selected} onOpenTask={onOpenTask} />
        </Drawer>
      )}
    </div>
  )
}

function LoopRow({ loop, selected, onSelect }: { loop: LoopListRow; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <ArtifactRow
      icon="loops"
      iconTone="loop"
      title={loop.title ?? loop.id}
      source={
        <>
          {loop.cronText ?? 'no cadence'} · {loop.openTasks} open
          {loop.status !== 'active' ? ` · ${loop.status}` : ''}
        </>
      }
      state={loop.questionsWaiting > 0 ? `${loop.questionsWaiting} waiting` : (loop.health.lastOutcome ?? 'no runs yet')}
      stateTone={
        loop.questionsWaiting > 0
          ? 'human'
          : loop.health.lastOutcome === 'ok'
            ? 'ok'
            : loop.health.lastOutcome === 'failure'
              ? 'floor'
              : undefined
      }
      when={loop.health.lastRunAt}
      action={<span className="artifact-action">open ›</span>}
      selected={selected}
      onOpen={() => onSelect(loop.id)}
      ariaLabel={`Open ${loop.title ?? loop.id}`}
    />
  )
}

function LoopDetail({ id, onOpenTask }: { id: string; onOpenTask: (id: string) => void }) {
  const { data, error, refresh } = useLiveView(`loop:${id}`, () => fetchLoop(id), affectsLoop(id))
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
        <Loading what="the loop" />
      </div>
    )
  }
  const { loop, health } = data

  return (
    <article className="preview-document">
      <DrawerHead
        kicker={loop.status === 'active' ? 'Active loop' : `${loop.status} loop`}
        title={loop.title ?? loop.id}
        facets={
          <>
            <span className={`state-label ${loop.status === 'active' ? 'state-ok' : ''}`}>{loop.status}</span>
            <StateChip state={health.lastOutcome} />
            <code className="ws-id">{loop.id}</code>
          </>
        }
        meta={[
          ['cadence', loop.cronText ?? '—'],
          // Cron says WHEN; workdir says WHERE. A loop binds a directory and no
          // machine, so the bound path is the other half of "what does this run".
          ['workdir', loop.workdir ?? '— (the daemon\'s scratch dir)'],
          ['next fire', <When iso={loop.nextFire} />],
          ['last run', <When iso={health.lastRunAt} />],
          ['7d ok / fail', `${health.runs7d.success} / ${health.runs7d.failure}`],
          ['7d cost', `$${health.costs7d.usd.toFixed(2)}`],
          ['failure streak', String(health.consecutiveFailures)],
        ]}
      />

      <RunNow id={loop.id} onQueued={refresh} />

      {loop.source === 'prod' && (
        <p className="inbox-floor">
          This is the machine&apos;s production loop. Its schedule and pause state are edited on the shipping loop surface;
          this workspace keeps the task, mirror and event history attached to the same id.
        </p>
      )}

      {health.consecutiveFailures > 0 && (
        <p className="inbox-floor">
          Consecutive failures auto-pause a loop and raise a question here. Time never un-pauses a loop — a human does.
        </p>
      )}

      <DrawerSection
        title="Charter"
        note={
          loop.source === 'prod'
            ? "A production loop's standing brief is its task file — this is the `## Spec` the machine last synced."
            : "The loop's body IS its prompt. A run may rewrite it in the free zone; the cadence is the keyed zone."
        }
      >
        <div className="charter-body">{loop.body.trim() ? <Markdown>{loop.body}</Markdown> : <Empty>No charter recorded.</Empty>}</div>
      </DrawerSection>

      <DrawerSection title="Charter history">
        {data.charterHistory.length ? <CharterHistory entries={data.charterHistory} /> : <Empty>This charter has not been evolved yet.</Empty>}
      </DrawerSection>

      <DrawerSection title="Open work" note="A task can appear in more than one section — these are sections, not a partition.">
        <TaskGroup title="Watching" note="what this loop is on the hook for" rows={data.openTasks.watching} onOpenTask={onOpenTask} />
        <TaskGroup title="Created" note="what it has put into the world" rows={data.openTasks.created} onOpenTask={onOpenTask} />
        <TaskGroup title="Questions" note="what it is blocked on" rows={data.openTasks.questions} onOpenTask={onOpenTask} />
      </DrawerSection>

      <DrawerSection title="Recent runs">
        <RunStrip runs={data.recentRuns} />
      </DrawerSection>

      <DrawerSection title="Timeline">
        <Timeline events={data.events} emptyNote="No events on this loop yet." />
      </DrawerSection>
    </article>
  )
}

/**
 * RUN NOW — the manual fire, and the one write this screen performs.
 *
 * Three rules it keeps, in descending order of how easy they are to break:
 *
 * 1. **The button is never pre-hidden.** It fires a PAUSED loop directly
 *    (captain ruling 2026-08-04): pause governs the cadence, and a manual fire
 *    is a human act, not the clock — so one run happens and the loop is quiet
 *    again, still paused, still with no deferred next-run marker. Disabling the
 *    button on `status !== 'active'` would put a second copy of the production
 *    lifecycle rule in the client where it could drift.
 * 2. **The queue's answer is reported, not smoothed over.** One queued run per
 *    loop is the discipline, so a second press reports the run already waiting
 *    rather than pretending to have made a new one.
 * 3. **Nothing here waits for the run.** Queuing is the whole act; the run
 *    appears in `Recent runs` when the stream says so (`run-queued` carries the
 *    loop's own object id, so `affectsLoop` already refetches this drawer). The
 *    `onQueued` refresh only removes the wait for that round trip.
 */
function RunNow({ id, onQueued }: { id: string; onQueued: () => void }) {
  const [firing, setFiring] = useState(false)
  const [result, setResult] = useState<RunNowResult | null>(null)
  const [failure, setFailure] = useState<Error | undefined>(undefined)

  const fire = async () => {
    setFiring(true)
    setFailure(undefined)
    setResult(null)
    try {
      setResult(await postRunNow(id))
      onQueued()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setFiring(false)
    }
  }

  return (
    <div className="preview-actions">
      <div className="preview-actions-row">
        <button type="button" className="verdict-button" onClick={fire} disabled={firing}>
          {firing ? 'queueing…' : 'Run now'}
        </button>
        <p className="ws-note-line">
          Fires this loop off its cadence. The run is queued here and starts when a machine of this team claims it.
          A paused loop fires too — one run, and it stays paused.
        </p>
      </div>
      {result && (
        <p className="ws-queued" role="status">
          {result.alreadyQueued
            ? 'This loop already had a run queued — one queued run per loop, so that run will carry this fire.'
            : 'Queued.'}
          {result.run && <> Run <code className="ws-id">{result.run.id}</code>.</>}
        </p>
      )}
      {failure && <Refusal error={failure} />}
    </div>
  )
}

function TaskGroup({ title, note, rows, onOpenTask }: { title: string; note: string; rows: TaskRow[]; onOpenTask: (id: string) => void }) {
  return (
    <>
      <h3>
        {title} <small>{note}</small>
      </h3>
      {rows.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <div className="artifact-list">
          {rows.map((task) => (
            <ArtifactRow
              key={task.id}
              icon={task.pendingQuestion?.trim() ? 'question' : 'task'}
              iconTone={task.pendingQuestion?.trim() ? 'question' : 'task'}
              title={task.title ?? task.id}
              state={task.pendingQuestion?.trim() ? 'question' : task.due ? 'due' : undefined}
              stateTone={task.pendingQuestion?.trim() ? 'human' : 'floor'}
              when={task.followUpAt ?? task.updatedAt}
              action={<span className="artifact-action">open ›</span>}
              onOpen={() => onOpenTask(task.id)}
              ariaLabel={`Open ${task.title ?? task.id}`}
            />
          ))}
        </div>
      )}
    </>
  )
}

function CharterHistory({ entries }: { entries: CharterDiff[] }) {
  return (
    <ol className="event-list">
      {entries.map((entry) => {
        const body = entry.diff.body as { old?: unknown; new?: unknown } | undefined
        return (
          <li key={entry.event} className={`event-item entrance-${entry.entrance}`}>
            <div className="event-head">
              <b>charter evolved</b>
              <span className="event-entrance">{entry.entrance}</span>
              <code className="ws-id">{entry.actor}</code>
              <When iso={entry.ts} />
              <span className="event-seq">seq {entry.seq}</span>
            </div>
            {body && (
              <div className="charter-diff">
                <pre className="is-old">{String(body.old ?? '')}</pre>
                <pre className="is-new">{String(body.new ?? '')}</pre>
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
