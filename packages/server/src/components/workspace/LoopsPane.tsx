import { useEffect, useState } from 'react'

import {
  fetchLoop, fetchLoops, patchCharter, patchLoopConfig, postLifecycle, postRunNow,
  type CharterDiff, type LoopConfigPatch, type LoopListRow, type LoopView, type RunNowResult, type TaskRow,
} from './api'
import { LoopDashboard, MetricTrends } from './LoopDashboard'
import { LoopRunDetail } from './LoopRunDetail'
import { Markdown } from './Render'
import {
  ArtifactRow, BigState, Drawer, DrawerHead, DrawerSection, Empty, Loading, Refusal, RunStrip, Section, shortId, StateChip, Timeline, ViewHeader, When,
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
 * Management remains detail-only: rows open the drawer, while run, pause/resume
 * and basic edits sit beside the health facts they change. Run detail replaces
 * the drawer body and backs up to the loop without adding a second modal.
 */
export function LoopsPane({ selected, onSelect, onOpenTask }: { selected: string | null; onSelect: (id: string | null) => void; onOpenTask: (id: string) => void }) {
  const { data, error, loading } = useLiveView('loops', fetchLoops)
  const [runId, setRunId] = useState<string | null>(null)
  useEffect(() => setRunId(null), [selected])

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
        description="Standing automation, with the health its runs reported."
        meta={`${loops.length} loop${loops.length === 1 ? '' : 's'}`}
      />

      {loops.length === 0 && <Empty>No loops in this team yet.</Empty>}

      {asking.length > 0 && (
        <Section tone="needs" title="Blocked on you" count={asking.length}>
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
        <Drawer
          kicker={runId ? 'Run' : 'Loop'}
          onClose={() => onSelect(null)}
          onBack={runId ? () => setRunId(null) : undefined}
          backLabel={runId ? 'Loop' : 'Back'}
        >
          {runId
            ? <LoopRunDetail id={runId} loopId={selected} />
            : <LoopDetail id={selected} onOpenTask={onOpenTask} onOpenRun={setRunId} />}
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
          : loop.health.lastOutcome === 'ok' || loop.health.lastOutcome === 'success'
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

function LoopDetail({ id, onOpenTask, onOpenRun }: { id: string; onOpenTask: (id: string) => void; onOpenRun: (id: string) => void }) {
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
            <code className="ws-id" title={loop.id}>{shortId(loop.id)}</code>
          </>
        }
        meta={[
          ['cadence', loop.cronText ?? '—'],
          // Cron says WHEN; workdir says WHERE. A loop binds a directory and no
          // machine, so the bound path is the other half of "what does this run".
          ['workdir', loop.workdir ?? '— (the daemon\'s scratch dir)'],
          ['next fire', <When iso={loop.nextFire} />],
          ['last run', <When iso={health.lastRunAt} />],
          ['runs', String(data.runCount ?? data.recentRuns.length)],
          ['7d ok / fail', `${health.runs7d.success} / ${health.runs7d.failure}`],
          ['7d cost', `$${health.costs7d.usd.toFixed(2)}`],
          ['failure streak', String(health.consecutiveFailures)],
          ['notify', `${loop.notify ?? 'auto'}${loop.channelId ? ` · ${(data.channels ?? []).find((channel) => channel.id === loop.channelId)?.name ?? 'channel'}` : ' · dashboard only'}`],
        ]}
      />

      <LoopActions data={data} refresh={refresh} />

      {health.consecutiveFailures > 0 && (
        <p className="inbox-floor">
          Consecutive failures auto-pause a loop and raise a question here. Time never un-pauses a loop — a human does.
        </p>
      )}

      <DrawerSection title={`Run history · ${data.runCount ?? data.recentRuns.length}`} note={data.totalCostUsd == null ? undefined : `$${data.totalCostUsd.toFixed(2)} lifetime reported cost`}>
        <RunStrip runs={data.recentRuns} total={data.runCount} onOpen={(run) => onOpenRun(run.id)} />
      </DrawerSection>

      {(loop.stateSchema ?? []).length > 0 && (
        <DrawerSection title="Metric trends" note="Numeric report state, plotted from oldest to newest.">
          <MetricTrends fields={loop.stateSchema ?? []} runs={data.recentRuns} />
        </DrawerSection>
      )}

      {loop.ui?.trim() && (
        <DrawerSection title="Dashboard">
          <LoopDashboard html={loop.ui} runs={data.recentRuns} />
        </DrawerSection>
      )}

      <DrawerSection
        title="Charter"
        note={data.charter.seeded ? `Attached doc · version ${data.charter.version}` : 'Legacy fallback · the next charter-capable run will seed the attached doc.'}
      >
        <CharterEditor loopId={loop.id} charter={data.charter} refresh={refresh} />
      </DrawerSection>

      <DrawerSection title="Charter history">
        {data.charterHistory.length ? <CharterHistory entries={data.charterHistory} /> : <Empty>This charter has not been evolved yet.</Empty>}
      </DrawerSection>

      <DrawerSection title="Open work" note="Sections, not a partition — a task can appear in more than one.">
        <TaskGroup title="Watching" note="what this loop is on the hook for" rows={data.openTasks.watching} onOpenTask={onOpenTask} />
        <TaskGroup title="Created" note="what it has put into the world" rows={data.openTasks.created} onOpenTask={onOpenTask} />
        <TaskGroup title="Questions" note="what it is blocked on" rows={data.openTasks.questions} onOpenTask={onOpenTask} />
      </DrawerSection>

      <DrawerSection title="Timeline">
        <Timeline events={data.events} emptyNote="No events on this loop yet." />
      </DrawerSection>
    </article>
  )
}

function CharterEditor({ loopId, charter, refresh }: { loopId: string; charter: LoopView['charter']; refresh: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(charter.body)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<Error | undefined>(undefined)

  useEffect(() => {
    if (!editing) setDraft(charter.body)
  }, [charter.body, editing])

  if (!editing) return (
    <>
      <div className="charter-body">{charter.body.trim() ? <Markdown>{charter.body}</Markdown> : <Empty>No charter recorded.</Empty>}</div>
      {charter.seeded && <button type="button" className="attn-button is-quiet" onClick={() => setEditing(true)}>Edit charter</button>}
    </>
  )

  const save = async () => {
    setSaving(true)
    setFailure(undefined)
    try {
      await patchCharter(loopId, draft, charter.version)
      setEditing(false)
      refresh()
    } catch (cause) {
      // The draft intentionally stays in state on VERSION_CONFLICT. The caller
      // can copy it or re-read before deciding how to reapply it.
      setFailure(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="answer-box" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label htmlFor={`charter-${loopId}`}>Charter Markdown</label>
      <textarea id={`charter-${loopId}`} className="field-text" rows={16} value={draft} onChange={(event) => setDraft(event.target.value)} />
      {failure && <Refusal error={failure} />}
      <div className="answer-actions">
        <button type="button" className="attn-button is-quiet" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
        <button type="submit" className="solid-button" disabled={saving}>{saving ? 'Saving…' : 'Save charter'}</button>
      </div>
    </form>
  )
}

function LoopActions({ data, refresh }: { data: LoopView; refresh: () => void }) {
  const [editing, setEditing] = useState(false)
  return (
    <div className="preview-actions ws-loop-actions">
      <div className="preview-actions-row">
        <RunNow id={data.loop.id} onQueued={refresh} />
        <Lifecycle loop={data.loop} refresh={refresh} />
        <button type="button" className="attn-button is-quiet" onClick={() => setEditing((open) => !open)} aria-expanded={editing}>
          {editing ? 'Close settings' : 'Edit settings'}
        </button>
      </div>
      <p className="ws-note-line">Run once, govern the cadence, or change the owner-managed basics.</p>
      {editing && <ConfigEditor data={data} refresh={refresh} onDone={() => setEditing(false)} />}
    </div>
  )
}

function Lifecycle({ loop, refresh }: { loop: LoopView['loop']; refresh: () => void }) {
  const [pending, setPending] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const paused = loop.status !== 'active'
  const verb = paused ? 'resume' : 'pause'
  const act = async () => {
    setPending(true)
    setFailure(undefined)
    setWarning(null)
    try {
      const result = await postLifecycle(loop.id, verb)
      setWarning(result.warning ? `${result.warning.message} ${result.warning.hint}` : null)
      refresh()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="ws-action-block">
      <button type="button" className="attn-button is-quiet" onClick={act} disabled={pending}>
        {pending ? `${verb}…` : paused ? 'Resume' : 'Pause'}
      </button>
      {warning && <p className="inbox-floor" role="status">{warning}</p>}
      {failure && <Refusal error={failure} />}
    </div>
  )
}

function ConfigEditor({ data, refresh, onDone }: { data: LoopView; refresh: () => void; onDone: () => void }) {
  const loop = data.loop
  const [form, setForm] = useState({
    name: loop.title ?? loop.id,
    cron: loop.cron ?? '',
    timezone: loop.timezone ?? '',
    notify: loop.notify ?? 'auto',
    channelId: loop.channelId ?? '',
    model: loop.model ?? '',
    agent: loop.agent ?? 'claude-code',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }))
  const save = async () => {
    setSaving(true)
    setFailure(undefined)
    setSaved(false)
    const patch: LoopConfigPatch = {
      name: form.name,
      cron: form.cron,
      timezone: form.timezone || null,
      notify: form.notify as LoopConfigPatch['notify'],
      channelId: form.channelId || null,
      model: form.model || null,
      agent: form.agent as LoopConfigPatch['agent'],
    }
    try {
      await patchLoopConfig(loop.id, patch)
      setSaved(true)
      refresh()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setSaving(false)
    }
  }
  return (
    <form className="ws-loop-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="ws-form-grid">
        <label>Name<input name="name" className="field-input" value={form.name} onChange={(event) => set('name', event.target.value)} /></label>
        <label>Schedule<input name="cron" className="field-input ws-mono-input" value={form.cron} onChange={(event) => set('cron', event.target.value)} /></label>
        <label>Timezone<input name="timezone" className="field-input" placeholder="server local" value={form.timezone} onChange={(event) => set('timezone', event.target.value)} /></label>
        <label>Notify<select name="notify" className="field-select" value={form.notify} onChange={(event) => set('notify', event.target.value)}>
          <option value="auto">auto · only when there is news</option><option value="always">always</option><option value="never">never</option>
        </select></label>
        <label>Push channel<select name="channelId" className="field-select" value={form.channelId} onChange={(event) => set('channelId', event.target.value)}>
          <option value="">dashboard only</option>
          {(data.channels ?? []).map((channel) => <option key={channel.id} value={channel.id}>{channel.name} · {channel.type}</option>)}
        </select></label>
        <label>Coding agent<select name="agent" className="field-select" value={form.agent} onChange={(event) => set('agent', event.target.value)}>
          <option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="grok">Grok Build</option>
        </select></label>
        <label className="ws-form-wide">Model<input name="model" className="field-input" placeholder="agent default" value={form.model} onChange={(event) => set('model', event.target.value)} /></label>
      </div>
      <div className="note-actions">
        {saved && <span className="ws-saved" role="status">Saved.</span>}
        <button type="button" className="attn-button is-quiet" onClick={onDone}>Cancel</button>
        <button type="submit" className="solid-button" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
      </div>
      {failure && <Refusal error={failure} />}
      <p className="ws-cli-pointer">Workflow, dashboard source, and state schema remain advanced: use <code>loopany edit &lt;loop-id&gt; --json …</code>.</p>
    </form>
  )
}

/**
 * RUN NOW — the manual fire.
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
    <div className="ws-action-block">
      <button type="button" className="solid-button" onClick={fire} disabled={firing}>
        {firing ? 'Queueing…' : 'Run now'}
      </button>
      {result && (
        <p className="ws-queued" role="status">
          {result.alreadyQueued
            ? 'This loop already had a run queued — one queued run per loop, so that run will carry this fire.'
            : 'Queued.'}
          {result.run && <> Run <code className="ws-id" title={result.run.id}>{shortId(result.run.id)}</code>.</>}
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
