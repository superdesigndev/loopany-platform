import { useState } from 'react'

import { fetchLoop, fetchLoops, postLifecycle, postRunNow, type CharterDiff, type LifecycleResult, type LoopListRow, type RunNowResult, type TaskRow } from './api'
import { Markdown } from './Render'
import {
  ArtifactRow, BigState, Drawer, DrawerHead, DrawerSection, Empty, Loading, Refusal, RunStrip, Section, StateChip, Timeline, ViewHeader, When,
} from './parts'
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
 * The WATCHER REWORK (2026-08-04) added the operational lifecycle beside it —
 * pause, resume, retire — because retire acquired something a person has to see
 * BEFORE they choose it and AFTER it lands: retiring a loop that still watches
 * open tasks proceeds, and those tasks keep naming a loop that will never wake
 * again. The confirm names the count it can see from this payload; the warning
 * the server returns is the authoritative one and is rendered verbatim.
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

      <Lifecycle id={loop.id} watchingOpen={data.openTasks.watching.length} onChanged={refresh} />

      {health.consecutiveFailures > 0 && (
        <p className="inbox-floor">
          Consecutive failures auto-pause a loop and raise a question here. Time never un-pauses a loop — a human does.
        </p>
      )}

      <DrawerSection title="Charter" note="The loop's body IS its prompt. A run may rewrite it in the free zone; the cadence is the keyed zone.">
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
 *    again, still paused, still with no `next_fire`. A RETIRED loop is refused
 *    by the kernel (`runLoopNow`) with a sentence and a hint saying retirement
 *    is terminal. Disabling the button on `status !== 'active'` would replace
 *    that teaching with silence, and would put a second copy of the lifecycle
 *    rule in the client where it could drift. The refusal renders verbatim,
 *    exactly as the CLI shows one.
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

/**
 * THE OPERATIONAL LIFECYCLE — pause ⇄ resume, and retire as the terminal one.
 *
 * Two rules, and the second is the reason this component exists at all:
 *
 * 1. **Nothing here is pre-hidden or disabled by status**, the same discipline
 *    `Run now` keeps. All three verbs are always offered: repeating one that
 *    already landed is a success with `changed: false` (which the result line
 *    says), and a move out of `retired` is refused BY NAME with the reason.
 *    Hiding `resume` on an active loop would look tidier and would put a second
 *    copy of the lifecycle rule in the client, where it can drift from the
 *    kernel's — and it would replace the retired-loop teaching with silence.
 * 2. **RETIRE WARNS, IT NEVER BLOCKS** (captain ruling 2026-08-04). It is
 *    terminal AND it leaves a consequence — the open tasks this loop watches
 *    keep naming it, and nothing will wake them again — so it asks first, and
 *    the confirm NAMES THE COUNT rather than warning in the abstract. The count
 *    it shows comes from the loop payload already on screen; the count that
 *    matters is the server's, which comes back in `warning` after the write and
 *    is rendered verbatim underneath. Blocking, force-transferring or cascading
 *    were all considered and declined: retirement is the owner's operational
 *    call, and the honest response to a consequence they chose is to say it.
 */
function Lifecycle({ id, watchingOpen, onChanged }: { id: string; watchingOpen: number; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<LifecycleResult | null>(null)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const [confirmRetire, setConfirmRetire] = useState(false)

  const send = async (verb: 'pause' | 'resume' | 'retire') => {
    setBusy(verb)
    setFailure(undefined)
    setResult(null)
    try {
      setResult(await postLifecycle(id, verb))
      onChanged()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setBusy(null)
      setConfirmRetire(false)
    }
  }

  return (
    <div className="preview-actions">
      <div className="preview-actions-row">
        <button type="button" className="attn-button is-quiet" disabled={busy !== null} onClick={() => void send('pause')}>
          pause
        </button>
        <button type="button" className="attn-button is-quiet" disabled={busy !== null} onClick={() => void send('resume')}>
          resume
        </button>
        <button type="button" className="attn-button" disabled={busy !== null} onClick={() => setConfirmRetire(true)}>
          retire…
        </button>
        <p className="ws-note-line">
          Pause clears the next fire and nothing else; resume re-arms to the NEXT occurrence. Retire is terminal — the charter freezes
          and the record stays readable.
        </p>
      </div>

      {confirmRetire && (
        <div className="ws-confirm" role="alertdialog" aria-label={`Retire ${id}`}>
          <p>
            <b>Retire {id}?</b> There is no un-retire: the cadence is gone for good and the charter freezes.
          </p>
          {watchingOpen > 0 && (
            <p className="inbox-floor">
              It still watches <b>{watchingOpen}</b> open task{watchingOpen === 1 ? '' : 's'}. Retiring proceeds anyway — those tasks keep
              naming this loop, and nothing will wake them again. Hand each one to a live loop from its drawer, or close it.
            </p>
          )}
          <div className="note-actions">
            <button type="button" className="attn-button is-quiet" onClick={() => setConfirmRetire(false)}>
              cancel
            </button>
            <button type="button" className="solid-button" disabled={busy !== null} onClick={() => void send('retire')}>
              {busy === 'retire' ? 'retiring…' : 'retire it'}
            </button>
          </div>
        </div>
      )}

      {result && (
        <p className="ws-queued" role="status">
          {result.changed ? `Now ${result.loop.status}.` : `Already ${result.loop.status} — nothing changed.`}
        </p>
      )}
      {/* The server's own warning, verbatim: it counted the tasks, not the screen. */}
      {result?.warning && (
        <div className="ws-refusal" role="alert">
          <b>{result.warning.code}</b>
          <p>{result.warning.message}</p>
          <small>{result.warning.hint}</small>
        </div>
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
