import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ChannelSummary, CodingAgent, JobDetail, RunSummary, TranscriptStep } from '../types'
import { cronText, dotColor, dotLabel, dur, fmt, formatTranscript, isDone, tsShort, until } from '../lib/format'
import { mergeRuns } from '../lib/runs'
import { deleteJob, evolveJob, getJobDetail, getTranscript, loadOlderRuns, patchJob, requestEdit, runJob } from '../server/loopApi'
import { listChannels } from '../server/notifyFns'
import { ModalSection } from './Modal'
import { LoopFilesPanel } from './LoopFilesPanel'
import { LoopForm, type LoopFormHandle } from './LoopForm'
import { MachinesModal } from './MachinesModal'
import { Timeline, WINDOW } from './Timeline'
import { ArtifactList, btn, btnCost, btnKey, btnKeyPrimary, btnPrimary, ErrorBanner, Pre, runPulseStyle } from './ui'
import { ConfirmBar, FlashLine, LoadErrorCard, useDeferredDelete, useFlash } from './actionUi'

const AGENT_LABEL: Record<CodingAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

// The agent-authored dashboard rides in its own lazy chunk (it pulls in
// recharts via LoopChart) - a loop without a `ui` template never loads it.
const LoopView = lazy(() => import('./LoopView').then((m) => ({ default: m.LoopView })))


/**
 * Loop detail PAGE body (`/loops/$loopId`) — the redesign of the former modal.
 * One scrolling page: a loop header (name / status / schedule / agent / machine +
 * the action toolbar), an optional agent-authored dashboard, then a two-column
 * main with the UNIFIED Files panel (the task file alongside synced artifacts) and
 * the Runs timeline (a strip + a clickable list, each run linking to its own
 * detail route). Self-polls while open (fast while a run is live). The edit paths
 * (hand-to-Claude-Code; manual field form) remain in-page mode takeovers.
 */
export function LoopDetailView({ id }: { id: string }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [channels, setChannels] = useState<ChannelSummary[]>([]) // team push channels for the inline picker
  const [err, setErr] = useState<string | null>(null) // fatal load error — replaces the whole view
  const [actionErr, setActionErr] = useState<string | null>(null) // inline action error — never nukes the view
  const [editing, setEditing] = useState(false) // manual field form (LoopForm) — the demoted fallback
  const [editVia, setEditVia] = useState(false) // primary: hand the edit to Claude Code on the machine
  const [editInstruction, setEditInstruction] = useState('')
  const [editDispatched, setEditDispatched] = useState(false) // dispatched → watch the edit run stream in
  const [editLog, setEditLog] = useState<{ step: number; label: string }[]>([]) // accumulated live progress
  const [editTrace, setEditTrace] = useState<TranscriptStep[] | null>(null) // full transcript, pulled once settled
  const seenRunIds = useRef<Set<string>>(new Set())
  const traceFetched = useRef(false)
  const findEditRun = (rs: RunSummary[]) => rs.find((r) => r.role === 'edit' && !seenRunIds.current.has(r.id))
  const [pushOpen, setPushOpen] = useState(false)
  const [pushSaved, setPushSaved] = useState(false)
  const [machinesOpen, setMachinesOpen] = useState(false)
  const [pending, setPending] = useState<null | 'run' | 'evolve' | 'save' | 'toggle' | 'edit'>(null)
  const [confirming, setConfirming] = useState<null | 'run' | 'evolve' | 'delete'>(null)
  const [flash, setFlash] = useFlash()
  const formRef = useRef<LoopFormHandle>(null)
  const del = useDeferredDelete(id, (loopId) => deleteJob({ data: loopId }).then(() => navigate({ to: '/' })), {
    onExpire: () => navigate({ to: '/' }),
  })

  // Older run pages (lazy) for the timeline strip, mirroring LoopCard.
  const [older, setOlder] = useState<RunSummary[]>([])

  // One fetch for both the initial load and the background poll. Success always
  // clears a prior transient error (so a blip on the initial load can't brick
  // the page while the poll keeps succeeding); only the non-silent initial load
  // surfaces a failure — a silent poll keeps the stale data and the next tick retries.
  const load = useCallback(
    async (silent = false) => {
      try {
        setDetail(await getJobDetail({ data: id }))
        setErr(null)
      } catch (e) {
        if (!silent) setErr(String(e))
      }
    },
    [id],
  )

  useEffect(() => {
    setDetail(null)
    setEditing(false)
    setEditVia(false)
    setEditInstruction('')
    setEditDispatched(false)
    setEditLog([])
    setEditTrace(null)
    traceFetched.current = false
    setPushOpen(false)
    setOlder([])
    void load()
    void listChannels()
      .then(setChannels)
      .catch(() => {})
  }, [id, load])

  // Self-poll the page (fast while a run is live), but not mid-edit (don't churn
  // the form) or mid-delete (the optimistic tombstone).
  const running = !!detail?.summary.running
  useEffect(() => {
    if (editing || del.armed) return
    const t = setInterval(() => void load(true), running ? 3_000 : 8_000)
    return () => clearInterval(t)
  }, [editing, del.armed, running, load])

  useEffect(() => {
    if (!pushSaved) return
    const t = setTimeout(() => setPushSaved(false), 1800)
    return () => clearTimeout(t)
  }, [pushSaved])

  // While an edit is dispatched: accumulate live progress, then pull the full
  // transcript once it settles (progress is cleared server-side at finalize).
  useEffect(() => {
    if (!editDispatched) return
    const er = findEditRun(detail?.runs ?? [])
    if (!er) return
    if (er.running) {
      const p = er.progress
      if (p)
        setEditLog((prev) =>
          prev.at(-1)?.step === p.step && prev.at(-1)?.label === p.label ? prev : [...prev, { step: p.step, label: p.label }],
        )
    } else if (!traceFetched.current) {
      traceFetched.current = true
      void getTranscript({ data: { runId: er.id } })
        .then((res) => !('error' in res) && setEditTrace(res.steps))
        .catch(() => (traceFetched.current = false))
    }
  }, [editDispatched, detail])

  async function refreshAll() {
    await load()
  }

  function onRun() {
    if (detail?.job.exec) setConfirming('run')
    else void doRun()
  }
  async function doRun() {
    setActionErr(null)
    setPending('run')
    try {
      const r = await runJob({ data: id })
      if (r?.error) return setActionErr(`Run failed: ${r.error}`)
      setConfirming(null)
      setFlash({ label: 'Queued', hold: 4000 })
      await refreshAll()
    } finally {
      setPending(null)
    }
  }
  async function doEvolve() {
    setActionErr(null)
    setPending('evolve')
    try {
      const r = await evolveJob({ data: id })
      if (r?.error) return setActionErr(`Evolve failed: ${r.error}`)
      setConfirming(null)
      setFlash({ label: 'Evolving', hold: 4000 })
      await refreshAll()
    } finally {
      setPending(null)
    }
  }
  async function onToggle(enabled: boolean) {
    setPending('toggle')
    try {
      await patchJob({ data: { id, patch: { enabled } } })
      await refreshAll()
      setFlash({ label: enabled ? 'Enabled' : 'Paused', undo: () => void onToggle(!enabled) })
    } finally {
      setPending(null)
    }
  }
  async function setPush(patch: { notify?: string; channelId?: string }) {
    setActionErr(null)
    const r = await patchJob({ data: { id, patch } })
    if (r.error) return setActionErr(`Save failed: ${r.error}`)
    await refreshAll()
    setPushSaved(true)
  }
  async function onSave() {
    const payload = formRef.current?.read()
    if (!payload) return
    setActionErr(null)
    setPending('save')
    try {
      const r = await patchJob({ data: { id, patch: payload } })
      if (r.error) return setActionErr(`Save failed: ${r.error}`)
      setEditing(false)
      await refreshAll()
      setFlash({ label: 'Saved' })
    } finally {
      setPending(null)
    }
  }
  async function onRequestEdit() {
    const instruction = editInstruction.trim()
    if (!instruction) return
    setActionErr(null)
    setPending('edit')
    try {
      seenRunIds.current = new Set((detail?.runs ?? []).map((r) => r.id))
      const r = await requestEdit({ data: { id, instruction } })
      if (r.error) return setActionErr(`Couldn't queue the edit: ${r.error}`)
      setEditLog([])
      setEditTrace(null)
      traceFetched.current = false // a fresh dispatch fetches its own settled transcript
      setEditDispatched(true)
      setEditInstruction('')
      await refreshAll()
    } finally {
      setPending(null)
    }
  }
  function onConfirm() {
    if (confirming === 'run') void doRun()
    else if (confirming === 'evolve') void doEvolve()
    else if (confirming === 'delete') {
      setConfirming(null)
      del.arm()
    }
  }

  const backLink = (
    <Link
      to="/"
      className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:text-display"
    >
      <span aria-hidden>←</span> Loops
    </Link>
  )

  if (err)
    return (
      <Shell back={backLink}>
        <LoadErrorCard title="Couldn't load this loop." detail={err} onRetry={() => void load()} />
      </Shell>
    )
  if (!detail)
    return (
      <Shell back={backLink}>
        <div className="font-mono text-[12px] tracking-[0.08em] text-secondary">[ Loading ]</div>
      </Shell>
    )

  const { job, summary: s, runs } = detail
  const hasUi = !!job.ui
  const busy = !!pending
  const showEvolve = true
  const online = detail.machine.online
  const offlineHint = !online ? 'Machine offline — reconnect first' : undefined
  const done = isDone(s)

  const CONFIRM = {
    run: { q: 'Run one real cycle now?', note: 'Spawns the coding agent (claude).', cta: 'Run once', danger: false },
    evolve: {
      q: 'Trigger an evolution pass now?',
      note: 'Re-authors the dashboard / tightens the gate from real run data.',
      cta: 'Evolve',
      danger: false,
    },
    delete: { q: 'Delete this loop?', note: 'Removes the loop and its schedule. This cannot be undone.', cta: 'Delete', danger: true },
  } as const

  const flashLine = flash && (
    <div className="mb-2.5">
      <FlashLine label={flash.label} tone={flash.tone} onUndo={flash.undo} />
    </div>
  )

  const c = confirming && CONFIRM[confirming]
  const confirmLocked = busy || (confirming !== 'delete' && !online)
  const pushSelectCls =
    'lp-select cursor-pointer rounded-md border border-wire bg-surface py-1.5 pl-2.5 font-mono text-[12px] text-primary outline-none transition-colors hover:border-display focus:border-display disabled:cursor-default disabled:opacity-40'
  const menuItem =
    'flex w-full cursor-pointer select-none items-center px-3.5 py-2 text-[13px] text-primary outline-none transition-colors data-[highlighted]:bg-raised data-[disabled]:cursor-default data-[disabled]:opacity-40'
  const menuItemDanger =
    'flex w-full cursor-pointer select-none items-center px-3.5 py-2 text-[13px] text-accent outline-none transition-colors data-[highlighted]:bg-[color:var(--color-accent)]/10 data-[disabled]:cursor-default data-[disabled]:opacity-40'

  const actionBar = c ? (
    <ConfirmBar key={confirming} prompt={c.q} note={c.note} cta={c.cta} danger={c.danger} busy={confirmLocked} onConfirm={onConfirm} onCancel={() => setConfirming(null)} />
  ) : del.armed ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-wire bg-raised px-4 py-3">
      <FlashLine tone="gone" label="Deleted" onUndo={del.cancel} />
    </div>
  ) : pushOpen ? (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="font-mono text-[11px] tracking-[0.08em] text-secondary">Push</span>
      <select className={pushSelectCls} value={job.notify} disabled={busy} onChange={(e) => void setPush({ notify: e.target.value })}>
        {['auto', 'always', 'never'].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <span aria-hidden className="text-secondary">→</span>
      <select className={pushSelectCls} value={job.channelId ?? ''} disabled={busy} onChange={(e) => void setPush({ channelId: e.target.value })}>
        <option value="">none (dashboard only)</option>
        {channels.map((ch) => (
          <option key={ch.id} value={ch.id}>
            {ch.name}
          </option>
        ))}
      </select>
      <div className="ml-auto flex items-center gap-2.5">
        <span aria-hidden className={`text-[14px] leading-none text-success transition-opacity duration-200 ${pushSaved ? 'opacity-100' : 'opacity-0'}`}>
          ✓
        </span>
        <button
          type="button"
          onClick={() => setPushOpen(false)}
          className="cursor-pointer border-none bg-transparent p-0 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:text-display"
        >
          Done
        </button>
      </div>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className={btnKeyPrimary}
        disabled={busy || !online}
        onClick={onRun}
        title={offlineHint ?? (job.exec ? 'Spends credits' : undefined)}
        aria-label={job.exec ? 'Run once — spends credits' : 'Run once'}
      >
        {pending === 'run' ? 'Running…' : 'Run once'}
      </button>
      <button className={btnKey} disabled={busy} onClick={() => setEditVia(true)}>
        Edit
      </button>
      <Menu.Root>
        <Menu.Trigger className={`${btnKey} px-2.5`} disabled={busy} aria-label="More actions">
          <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="3" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
          </svg>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[950]">
            <Menu.Popup className="min-w-[176px] origin-[var(--transform-origin)] rounded-lg border border-wire bg-surface py-1.5 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.4)] outline-none transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
              {showEvolve && (
                <Menu.Item className={menuItem} disabled={busy || !online} onClick={() => setConfirming('evolve')} title={offlineHint ?? 'Spends credits'}>
                  {pending === 'evolve' ? 'Evolving…' : 'Evolve now'}
                </Menu.Item>
              )}
              <Menu.Item className={menuItem} onClick={() => setPushOpen(true)}>
                Push…
              </Menu.Item>
              <Menu.Item className={menuItem} onClick={() => void onToggle(!s.enabled)}>
                {s.enabled ? 'Pause' : 'Enable'}
              </Menu.Item>
              <Menu.Separator className="my-1.5 h-px bg-hairline" />
              <Menu.Item className={menuItemDanger} onClick={() => setConfirming('delete')}>
                Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  )

  const actionErrEl = actionErr && <ErrorBanner message={actionErr} onDismiss={() => setActionErr(null)} className="mb-2.5" />

  const offlineEl = !online && (
    <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-wire bg-raised px-4 py-2.5">
      <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-secondary">
        <span aria-hidden className="size-2 rounded-full bg-disabled" />
        Machine {detail.machine.name ? `“${detail.machine.name}” ` : ''}offline
      </span>
      <span className="text-[12.5px] text-secondary">— run &amp; evolve are paused until it reconnects.</span>
      <button
        type="button"
        onClick={() => setMachinesOpen(true)}
        className="ml-auto cursor-pointer font-mono text-[11px] tracking-[0.08em] text-interactive underline underline-offset-2 transition-colors hover:text-display"
      >
        Reconnect
      </button>
    </div>
  )

  // ---- edit-via-Claude-Code mode (primary edit path) ----
  if (editVia) {
    const onMachine = detail.machine.name ? `“${detail.machine.name}”` : 'the machine this loop runs on'
    const exitEdit = () => {
      setEditVia(false)
      setEditDispatched(false)
    }
    const editRun = editDispatched ? findEditRun(runs) : undefined
    const editSettled = editRun && !editRun.running
    const traceText = editTrace?.length ? formatTranscript(editTrace) : ''
    return (
      <Shell back={backLink}>
        <EditHead name={s.name} />
        <button
          type="button"
          onClick={exitEdit}
          className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:text-display"
        >
          <span aria-hidden>←</span> Back
        </button>

        {editDispatched ? (
          <div className="mt-4">
            <div className="text-[13px] leading-snug text-secondary">
              Dispatched to Claude Code on {onMachine}. Watching it apply the change:
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {!editRun ? (
                <span className="inline-flex items-center gap-2.5 font-mono text-[12px] text-secondary">
                  <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-[color:var(--color-display)]" />
                  Queued — waiting for the machine to pick it up…
                </span>
              ) : editRun.running ? (
                <span className="inline-flex items-center gap-2.5 font-mono text-[12px] text-secondary">
                  <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-[color:var(--color-display)]" />
                  Applying the change…
                </span>
              ) : (
                <span className="inline-flex items-center gap-2 text-[13px]">
                  <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: dotColor(editRun) }} />
                  <span className="font-medium" style={{ color: dotColor(editRun) }}>
                    {dotLabel(editRun)}
                  </span>
                  {editRun.error && <span className="text-secondary">· {editRun.error}</span>}
                </span>
              )}
            </div>
            {(traceText || editLog.length > 0) && (
              <>
                <ModalSection>activity</ModalSection>
                {traceText ? (
                  <Pre>{traceText}</Pre>
                ) : (
                  <ul className="max-h-[300px] space-y-1.5 overflow-y-auto rounded-md border border-hairline bg-raised px-4 py-3.5 font-mono text-[11.5px] leading-relaxed text-secondary">
                    {editLog.map((e, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="shrink-0 text-disabled">{e.step}</span>
                        <span className="break-words">{e.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {editSettled && editRun.message && (
              <>
                <ModalSection>report</ModalSection>
                <Pre>{editRun.message}</Pre>
              </>
            )}
            {editSettled && editRun.artifacts?.length ? (
              <>
                <ModalSection>files ({editRun.artifacts.length})</ModalSection>
                <ArtifactList artifacts={editRun.artifacts} />
              </>
            ) : null}
            <div className="mt-5">
              <button className={btnPrimary} onClick={exitEdit}>
                {editSettled ? 'Done' : 'Back to detail'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 text-[13px] leading-snug text-secondary">
              Describe the change — Claude Code on {onMachine} applies it (schedule, cadence, or what the loop does).
              It runs as one agent pass, so it spends credits and needs the machine online.
            </div>
            <textarea
              value={editInstruction}
              onChange={(e) => setEditInstruction(e.target.value)}
              rows={4}
              placeholder="e.g. run at 9am on weekdays instead, and also check coffee stock"
              className="mt-3 w-full resize-y rounded-lg border border-wire bg-raised p-3 font-mono text-[12px] leading-relaxed text-primary outline-none transition-colors placeholder:text-disabled focus:border-display"
            />
            {actionErrEl}
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <button className={btnCost} disabled={pending === 'edit' || !editInstruction.trim()} onClick={() => void onRequestEdit()}>
                {pending === 'edit' ? 'Dispatching…' : 'Dispatch to Claude Code'}
              </button>
              <button className={btn} disabled={pending === 'edit'} onClick={exitEdit}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditVia(false)
                  setEditing(true)
                }}
                className="ml-auto cursor-pointer border-none bg-transparent p-0 text-[12px] text-secondary underline underline-offset-2 transition-colors hover:text-display"
              >
                Edit fields manually →
              </button>
            </div>
          </>
        )}
      </Shell>
    )
  }

  // ---- manual field-form edit mode ----
  if (editing) {
    return (
      <Shell back={backLink}>
        <EditHead name={s.name} />
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:text-display"
        >
          <span aria-hidden>←</span> Back
        </button>
        <div className="mt-4">
          <LoopForm ref={formRef} initial={job} channels={channels} />
          {actionErrEl}
          <div className="mt-5 flex flex-wrap gap-2.5">
            <button className={btnPrimary} disabled={pending === 'save'} onClick={onSave}>
              {pending === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button className={btn} disabled={pending === 'save'} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Shell>
    )
  }

  // ---- read mode (the page) ----
  const agentLabel = AGENT_LABEL[job.agent ?? 'claude-code'] ?? job.agent ?? 'Claude Code'
  const metaDot = <span className="text-wire">·</span>

  return (
    <Shell back={backLink}>
      {/* header */}
      <header className="rounded-2xl border border-wire bg-surface px-6 pb-5 pt-[22px]">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[30px] font-medium leading-tight tracking-tight text-display">{s.name}</h1>
              {s.running && (
                <span className="inline-flex h-5 items-center gap-1.5 rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-display">
                  <span className="size-1.5 rounded-full" style={runPulseStyle} />
                  Running
                </span>
              )}
              {done ? (
                <span className="inline-flex h-5 items-center rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-display">
                  Done
                </span>
              ) : !s.enabled ? (
                <span className="inline-flex h-5 items-center rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-secondary">
                  Paused
                </span>
              ) : null}
              {/* Which coding agent this loop is recorded against (loops.agent) —
                  a quiet, unobtrusive chip, not a status pill. */}
              <span
                className="inline-flex h-5 items-center rounded border border-hairline px-2 font-mono text-[10.5px] tracking-[0.06em] text-secondary"
                title="Recorded coding agent"
              >
                {agentLabel}
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12.5px] tracking-[0.02em] text-secondary">
              <span className="text-primary" title={job.cron}>
                {cronText(job.cron)}
              </span>
              {metaDot}
              <span>next {fmt(s.nextRun)}</span>
              {s.nextRun && s.enabled && !done && <span className="text-disabled">({until(s.nextRun)})</span>}
              {metaDot}
              <span className="inline-flex items-center gap-1.5" title={online ? 'Machine online' : 'Machine offline'}>
                <span className={`size-1.5 rounded-full ${online ? 'bg-[color:var(--color-ok,#16a34a)]' : 'bg-disabled'}`} />
                {detail.machine.name || 'machine'}
              </span>
              {metaDot}
              <code className="font-mono text-disabled">{s.id}</code>
            </div>
          </div>
        </div>

        <div className="mt-5 border-t border-hairline pt-4">
          {offlineEl}
          {actionErrEl}
          {flashLine}
          {actionBar}
        </div>
      </header>

      {/* agent-authored dashboard (when present) */}
      {hasUi && (
        <section className="mt-6 min-w-0 rounded-2xl border border-wire bg-surface px-6 py-5">
          <div className="mb-3.5 border-b border-hairline pb-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary">dashboard</div>
          {/* Agent-authored HTML — contain it so an over-wide card row / chart
              scrolls inside the dashboard box rather than widening the whole page;
              a responsive (auto-fit) card grid then wraps within this bounded width. */}
          <div className="min-w-0 overflow-x-auto">
            <Suspense fallback={<div className="py-4 font-mono text-[12px] tracking-[0.08em] text-secondary">[ loading ]</div>}>
              <LoopView html={job.ui!} runs={runs} loopId={id} taskFile={job.taskFile} />
            </Suspense>
          </div>
        </section>
      )}

      {/* files (unified) + runs — the files panel (its content viewer is the star)
          takes the bulk of the width via a shrinkable minmax(0,1fr) track; runs is
          a capped medium rail that's always visible. `minmax(0,…)` + each child's
          own `min-w-0` keep a wide artifact (or table) from forcing PAGE scroll —
          it scrolls inside its own pane instead. Collapses to one column < lg. */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <LoopFilesPanel
          loopId={id}
          taskFile={job.taskFile}
          taskFileContent={detail.taskFileContent}
          taskFileSyncedAt={detail.taskFileSyncedAt}
          running={running}
        />
        <RunsSection
          loopId={id}
          summary={s}
          runs={runs}
          older={older}
          onMore={async () => {
            const seed = older.length ? mergeRuns(s.runs ?? [], older) : s.runs ?? []
            const oldest = seed[0]
            if (!oldest) return 0
            const more = await loadOlderRuns({ data: { loopId: id, beforeTs: oldest.ts, limit: WINDOW } })
            if (more.length) setOlder((prev) => mergeRuns(prev, more))
            return more.length
          }}
          onPickRun={(run) => navigate({ to: '/loops/$loopId/runs/$runId', params: { loopId: id, runId: run.id } })}
        />
      </div>

      <MachinesModal open={machinesOpen} onClose={() => setMachinesOpen(false)} />
    </Shell>
  )
}

/**
 * Edit-mode page heading. The edit views are in-page mode takeovers (NOT modals),
 * so this is a plain heading — NOT `ModalHead`, whose Base UI `Dialog.Title`/
 * `Dialog.Close` require a `Dialog.Root` ancestor and throw ("Cannot destructure
 * property 'store' of 'useDialogRootContext(...)'") when rendered on a bare page.
 */
function EditHead({ name }: { name: string }) {
  return <h1 className="text-[22px] font-medium tracking-tight text-display">Edit · {name}</h1>
}

/** The page shell — centered column, a back affordance, consistent padding. */
function Shell({ back, children }: { back: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-[1360px] px-8 pb-24 pt-10">
      <div className="mb-5">{back}</div>
      {children}
    </main>
  )
}

/** The runs panel — the signature timeline strip (paged) over a scannable list
 *  of recent runs, each row linking to its own run-detail route. */
function RunsSection({
  loopId,
  summary,
  runs,
  older,
  onMore,
  onPickRun,
}: {
  loopId: string
  summary: JobDetail['summary']
  runs: RunSummary[] // newest-first (for the list)
  older: RunSummary[]
  onMore: () => Promise<number>
  onPickRun: (run: RunSummary) => void
}) {
  // The timeline strip wants chronological (oldest-first) runs; the summary seeds
  // the newest page and `older` grows it leftward, same as a dashboard card.
  const stripRuns = useMemo(
    () => (older.length ? mergeRuns(summary.runs ?? [], older) : summary.runs ?? []),
    [summary.runs, older],
  )

  return (
    <section className="min-w-0">
      <div className="mb-2.5 flex items-end justify-between gap-3 border-b border-hairline pb-1.5">
        <h2 className="font-mono text-[11px] tracking-[0.08em] text-secondary">runs ({summary.runCount})</h2>
      </div>

      {summary.runCount === 0 ? (
        <div className="rounded-xl border border-wire bg-surface px-5 py-10 text-center text-[13px] text-disabled">never run</div>
      ) : (
        <div className="rounded-2xl border border-wire bg-surface px-5 pb-4 pt-5">
          <Timeline job={summary} runs={stripRuns} total={summary.runCount} onLoadMore={onMore} onPickRun={onPickRun} />

          <ul className="mt-5 max-h-[clamp(280px,46vh,520px)] divide-y divide-hairline overflow-y-auto border-t border-hairline">
            {runs.map((x) => (
              <li key={x.id}>
                <Link
                  to="/loops/$loopId/runs/$runId"
                  params={{ loopId, runId: x.id }}
                  className="flex items-start gap-2.5 py-2.5 transition-colors hover:bg-raised"
                >
                  <span
                    className="mt-1 inline-block size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: dotColor(x) }}
                    title={dotLabel(x)}
                    aria-label={dotLabel(x)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[12px] text-secondary">{tsShort(x.ts)}</span>
                      <span className="shrink-0 font-mono text-[11px] text-disabled">{dur(x.durationMs)}</span>
                    </span>
                    <span className="mt-0.5 block">
                      {x.running && x.progress ? (
                        <span className="inline-flex items-center gap-2 font-mono text-[12px] text-secondary">
                          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-[color:var(--color-display)]" />
                          <span className="text-disabled">{x.progress.step}</span>
                          <span className="truncate">{x.progress.label}</span>
                        </span>
                      ) : x.error ? (
                        <span className="line-clamp-2 text-[12.5px] text-secondary">{x.error}</span>
                      ) : (
                        <span className="line-clamp-2 text-[12.5px] text-primary">{x.message || dotLabel(x)}</span>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
