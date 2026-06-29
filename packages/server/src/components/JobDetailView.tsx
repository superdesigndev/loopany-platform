import { useCallback, useEffect, useRef, useState } from 'react'
import { Menu } from '@base-ui/react/menu'
import type { ChannelSummary, JobDetail, RunSummary, TranscriptStep } from '../types'
import { dotColor, dotLabel, dur, fmt, formatTranscript, tsShort } from '../lib/format'
import { deleteJob, evolveJob, getJobDetail, getTranscript, patchJob, requestEdit, runJob } from '../server/loopApi'
import { listChannels } from '../server/notifyFns'
import { ModalHead, ModalSection } from './Modal'
import { LoopView } from './LoopView'
import { TaskFileView } from './TaskFileView'
import { FilesView } from './FilesView'
import { LoopForm, type LoopFormHandle } from './LoopForm'
import { ArtifactList, btn, btnCost, btnKey, btnKeyPrimary, btnPrimary, ErrorBanner, Pre } from './ui'
import { ConfirmBar, FlashLine, useDeferredDelete, useFlash } from './actionUi'

/**
 * Loop detail, modes in one shell:
 *   - read    : the generative-UI panel (or a fallback chart) + actions
 *               (edit / run-now / evolve / pause / delete) + task file + run history.
 *   - editVia : the PRIMARY edit path — hand the change to Claude Code on the loop's
 *               machine (Agent-First). A copy-forward snippet, no claim/poll; the
 *               agent applies it with its persisted device token.
 *   - editing : the demoted fallback — a focused full-width field form (Save → PATCH),
 *               reachable only via "Edit fields manually" inside editVia. Writes apply
 *               via the live Scheduler. Both edit modes mirror RunView's drill-in.
 */
export function JobDetailView({
  id,
  onChanged,
  onClose,
  onReconnect,
  onPickRun,
}: {
  id: string
  onChanged: () => void
  onClose: () => void
  /** Open the Machines panel to reconnect the loop's (offline) machine. */
  onReconnect?: () => void
  onPickRun: (jobName: string, run: RunSummary) => void
}) {
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [channels, setChannels] = useState<ChannelSummary[]>([]) // team push channels for the inline picker
  const [err, setErr] = useState<string | null>(null) // fatal load error — replaces the whole view
  const [actionErr, setActionErr] = useState<string | null>(null) // inline action error — never nukes the view
  const [editing, setEditing] = useState(false) // manual field form (LoopForm) — the demoted fallback
  const [editVia, setEditVia] = useState(false) // primary: hand the edit to Claude Code on the machine
  const [editInstruction, setEditInstruction] = useState('')
  const [editDispatched, setEditDispatched] = useState(false) // dispatched → watch the edit run stream in (don't jump to detail)
  const [editLog, setEditLog] = useState<{ step: number; label: string }[]>([]) // accumulated live progress
  const [editTrace, setEditTrace] = useState<TranscriptStep[] | null>(null) // full transcript, pulled once settled
  // Run ids present at dispatch — lets us pick out the NEW edit run that lands after.
  const seenRunIds = useRef<Set<string>>(new Set())
  const traceFetched = useRef(false) // one-shot guard so the transcript is fetched once on settle
  // The dispatched edit run = a fresh `edit` run not present when we dispatched.
  const findEditRun = (rs: RunSummary[]) => rs.find((r) => r.role === 'edit' && !seenRunIds.current.has(r.id))
  const [pushOpen, setPushOpen] = useState(false) // "Push" tapped → row becomes the notify/channel pickers
  const [pushSaved, setPushSaved] = useState(false) // transient ✓ inside the push row (not the full-width flash)
  // Which async action is in flight — disables the row so a money-spend can't
  // double-fire, and swaps the active button's label to a present-tense gerund.
  const [pending, setPending] = useState<null | 'run' | 'evolve' | 'save' | 'toggle' | 'edit'>(null)
  // The high-stakes guard rendered in-panel (Nothing-style, <ConfirmBar/>) instead
  // of a native confirm() — keeps the printed-manual calm, one branded language.
  const [confirming, setConfirming] = useState<null | 'run' | 'evolve' | 'delete'>(null)
  const [flash, setFlash] = useFlash() // transient ✓/✕ peak-end signal (self-clearing)
  const formRef = useRef<LoopFormHandle>(null)
  // Delete has no server restore — defer the real commit behind a 6s Undo window.
  const del = useDeferredDelete(id, (loopId) => deleteJob({ data: loopId }).then(onChanged), { onExpire: onClose })

  const load = useCallback(async () => {
    setErr(null)
    try {
      setDetail(await getJobDetail({ data: id }))
    } catch (e) {
      setErr(String(e))
    }
  }, [id])

  // Silent background refresh — unlike `load`, a transient failure keeps the
  // stale data on screen rather than blowing the modal away into the error view.
  const poll = useCallback(async () => {
    try {
      setDetail(await getJobDetail({ data: id }))
    } catch {
      /* keep what we have; the next tick retries */
    }
  }, [id])

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
    void load()
    void listChannels()
      .then(setChannels)
      .catch(() => {})
  }, [id, load])

  // The dashboard's poller pauses while a modal is open, and this view fetches
  // its OWN detail — so without this it'd freeze: an in-flight run would never
  // settle, the task file would never sync in. Poll while open (fast while a run
  // is live), but not mid-edit (don't churn the form) or mid-delete (tombstone).
  const running = !!detail?.summary.running
  useEffect(() => {
    if (editing || del.armed) return
    const t = setInterval(() => void poll(), running ? 3_000 : 8_000)
    return () => clearInterval(t)
  }, [editing, del.armed, running, poll])

  // The inline push ✓ self-clears after a beat (and on unmount) — no stray timer.
  useEffect(() => {
    if (!pushSaved) return
    const t = setTimeout(() => setPushSaved(false), 1800)
    return () => clearTimeout(t)
  }, [pushSaved])

  // While an edit is dispatched: accumulate its live progress lines (the slim
  // sampled signal), then pull the full transcript once it settles (the complete
  // record — progress is cleared server-side when the run finalizes).
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
      // Settled — pull the full transcript exactly once (guard survives the polls
      // that fire before the fetch resolves); allow a retry if it errors.
      traceFetched.current = true
      void getTranscript({ data: { runId: er.id } })
        .then((res) => !('error' in res) && setEditTrace(res.steps))
        .catch(() => (traceFetched.current = false))
    }
  }, [editDispatched, detail])

  async function refreshAll() {
    await load()
    onChanged()
  }

  // Run-now: only an exec-bound loop spawns the coding agent (claude) and costs
  // credits, so only that path needs the in-panel guard; workflow/plain loops are
  // cheap & deterministic and fire straight away.
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
      // The live running indicator surfaces the in-flight run on its own; this
      // flash just acknowledges the click landed (and the credits were spent) —
      // held longer than a routine flash since money left the account.
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
      // Pausing silently halts all scheduled work — give the cheap, no-confirm
      // toggle an Undo instead of a guard dialog.
      setFlash({ label: enabled ? 'Enabled' : 'Paused', undo: () => void onToggle(!enabled) })
    } finally {
      setPending(null)
    }
  }
  // Inline push config (notify policy + channel) — edited straight from read mode,
  // no need to open the full field form.
  async function setPush(patch: { notify?: string; channelId?: string }) {
    setActionErr(null)
    const r = await patchJob({ data: { id, patch } })
    if (r.error) return setActionErr(`Save failed: ${r.error}`)
    await refreshAll()
    // Acknowledge inline (a green ✓ in the push row), not as a full-width flash
    // line — the effect below self-clears it (and cleans up on unmount).
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
      // Snapshot current run ids BEFORE dispatch so we can spot the new edit run.
      seenRunIds.current = new Set((detail?.runs ?? []).map((r) => r.id))
      const r = await requestEdit({ data: { id, instruction } })
      if (r.error) return setActionErr(`Couldn't queue the edit: ${r.error}`)
      // Stay on the Edit screen and watch the dispatched run stream in below —
      // the open-modal poll surfaces its progress, then its result.
      setEditLog([])
      setEditTrace(null)
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
      del.arm() // optimistic tombstone now; real delete after the Undo window
    }
  }

  if (err) return <div className="font-mono text-[13px] text-accent">[ ERROR ] {err}</div>
  if (!detail)
    return <div className="font-mono text-[12px] tracking-[0.08em] text-secondary">[ Loading ]</div>

  const { job, summary: s, runs } = detail
  const hasUi = !!job.ui

  // Read-mode actions. Weight tracks STAKES, not listing order: Run-once leads as
  // the filled primary (the screen's real verb), Evolve carries the metered `btnCost`
  // tier (it spends credits too), Edit/Pause are quiet free toggles, and destructive
  // Delete is pushed to the far edge (ml-auto). A high-stakes click swaps the row for
  // an in-panel confirm; the active button shows a gerund and the whole row locks
  // (`busy`) so a money-spend can't double-fire.
  const busy = !!pending
  // Any loop can evolve (the evolve pass bootstraps schema/ui/workflow from run
  // data), so the button is always offered — mirrors store.canEvolve().
  const showEvolve = true
  // Execution actions (run / evolve) dispatch to the machine — gate them when it's
  // offline. Edit / Pause / Delete are server-side, so they stay live (you may want
  // to pause or remove a loop precisely because its machine died).
  const online = detail.machine.online
  const offlineHint = !online ? 'Machine offline — reconnect first' : undefined

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

  // The success/undo flash gets its OWN line above the row — a distinct peak-end
  // beat, not a chip squeezed between pills where the eye can skim past it.
  const flashLine = flash && (
    <div className="mb-2.5">
      <FlashLine label={flash.label} tone={flash.tone} onUndo={flash.undo} />
    </div>
  )

  const c = confirming && CONFIRM[confirming]
  // Delete is server-side; run/evolve need the machine, so lock their CTA if it
  // dropped while the guard was open.
  const confirmLocked = busy || (confirming !== 'delete' && !online)
  // Inline push pickers (notify policy + channel) — shared select styling.
  const pushSelectCls =
    'lp-select cursor-pointer rounded-md border border-wire bg-surface py-1.5 pl-2.5 font-mono text-[12px] text-primary outline-none transition-colors hover:border-display focus:border-display disabled:cursor-default disabled:opacity-40'
  // "···" overflow-menu rows — flat, full-bleed highlight; danger tier tints red.
  const menuItem =
    'flex w-full cursor-pointer select-none items-center px-3.5 py-2 text-[13px] text-primary outline-none transition-colors data-[highlighted]:bg-raised data-[disabled]:cursor-default data-[disabled]:opacity-40'
  const menuItemDanger =
    'flex w-full cursor-pointer select-none items-center px-3.5 py-2 text-[13px] text-accent outline-none transition-colors data-[highlighted]:bg-[color:var(--color-accent)]/10 data-[disabled]:cursor-default data-[disabled]:opacity-40'
  // The bottom action bar's row content — four mutually-exclusive states: a
  // high-stakes confirm, the delete tombstone, the in-place Push pickers (tap
  // "Push" → the row becomes the notify/channel selects), or the normal verbs.
  const actionBar = c ? (
    <ConfirmBar key={confirming} prompt={c.q} note={c.note} cta={c.cta} danger={c.danger} busy={confirmLocked} onConfirm={onConfirm} onCancel={() => setConfirming(null)} />
  ) : del.armed ? (
    // Deferred-delete tombstone — gone from the UI; Undo reverses it before the
    // real delete commits (symmetry with Pause's Undo, for the irreversible action).
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-wire bg-raised px-4 py-3">
      <FlashLine tone="gone" label="Deleted" onUndo={del.cancel} />
    </div>
  ) : pushOpen ? (
    // Push tapped — the whole row turns into the notify-policy + channel pickers
    // (changes apply on select, like before); Done collapses back to the verbs.
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
      <select
        className={pushSelectCls}
        value={job.channelId ?? ''}
        disabled={busy}
        onChange={(e) => void setPush({ channelId: e.target.value })}
      >
        <option value="">none (dashboard only)</option>
        {channels.map((ch) => (
          <option key={ch.id} value={ch.id}>
            {ch.name}
          </option>
        ))}
      </select>
      <div className="ml-auto flex items-center gap-2.5">
        <span
          aria-hidden
          className={`text-[14px] leading-none text-success transition-opacity duration-200 ${pushSaved ? 'opacity-100' : 'opacity-0'}`}
        >
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
    // Run + Edit stay outside; the rest (incl. metered Evolve) live behind a "···"
    // menu (Cloudflare pattern) so the toolbar reads as two buttons, not a wall.
    <div className="flex flex-wrap items-center justify-end gap-2">
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
                <Menu.Item
                  className={menuItem}
                  disabled={busy || !online}
                  onClick={() => setConfirming('evolve')}
                  title={offlineHint ?? 'Spends credits'}
                >
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

  // Inline action error — sits above the row, never replaces the view (only a
  // failed initial load does that). Same `[ ERROR ]` mono language, dismissable.
  const actionErrEl = actionErr && (
    <ErrorBanner message={actionErr} onDismiss={() => setActionErr(null)} className="mb-2.5" />
  )

  // Offline notice — the loop's machine isn't polling, so run/evolve are gated.
  // Not an error (the loop is fine); a calm gray-dot state + a Reconnect shortcut.
  const offlineEl = !online && (
    <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-wire bg-raised px-4 py-2.5">
      <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-secondary">
        <span aria-hidden className="size-2 rounded-full bg-disabled" />
        Machine {detail.machine.name ? `“${detail.machine.name}” ` : ''}offline
      </span>
      <span className="text-[12.5px] text-secondary">— run &amp; evolve are paused until it reconnects.</span>
      {onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="ml-auto cursor-pointer font-mono text-[11px] tracking-[0.08em] text-interactive underline underline-offset-2 transition-colors hover:text-display"
        >
          Reconnect
        </button>
      )}
    </div>
  )

  // Task file (the loop's spec) — paired with the action verbs in the right column.
  // When `fill`, the doc is absolutely-positioned inside a flex-1 wrapper so it
  // STRETCHES to the column height (matching the left) and scrolls — without its
  // (long) content inflating the grid row. So the LEFT column drives the height,
  // the task just fills the leftover. Plain layout: a normal capped block.
  const taskBlock = (fill: boolean) =>
    job.taskFile && (
      <>
        <ModalSection>
          task file<code className="ml-1 font-mono">· {job.taskFile}</code>
          {detail.taskFileSyncedAt && (
            <span className="ml-1 font-mono normal-case text-secondary">· synced {fmt(detail.taskFileSyncedAt)}</span>
          )}
        </ModalSection>
        {detail.taskFileContent == null ? (
          <div className="text-[13px] text-disabled">(syncs from the machine on the next run)</div>
        ) : fill ? (
          <div className="lg:relative lg:min-h-0 lg:flex-1">
            <TaskFileView content={detail.taskFileContent} fill />
          </div>
        ) : (
          <TaskFileView content={detail.taskFileContent} />
        )}
      </>
    )

  // Run history — paired under the dashboard in the left "output" column. Capped +
  // internal scroll; this (with the dashboard) is the column that DRIVES the modal
  // height. The right column's task then fills to match it (see below).
  const runsBlock = (
    <>
      <ModalSection>runs ({runs.length})</ModalSection>
      {runs.length ? (
        <div className="max-h-[clamp(260px,38vh,440px)] overflow-y-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="sticky top-0 z-10 border-b border-wire bg-surface font-mono text-[10.5px] tracking-[0.06em] text-secondary">
                {/* Outcome is now just a colored swatch on each row — no text column. */}
                <th className="py-2 pr-2.5 font-normal" aria-label="Outcome" />
                <th className="py-2 pr-3 text-left font-normal">Time</th>
                <th className="w-full py-2 pr-3 text-left font-normal">Message</th>
                <th className="py-2 text-left font-normal">Duration</th>
              </tr>
            </thead>
            <tbody>
            {runs.map((x: RunSummary, i: number) => (
              <tr
                key={i}
                className="cursor-pointer border-b border-hairline align-top hover:bg-raised"
                onClick={() => onPickRun(s.name, x)}
              >
                {/* Outcome swatch — color IS the meaning (green=resolved, red=error,
                    blue=evolved, ink/gray=neutral); the label rides the tooltip. */}
                <td className="py-2.5 pr-2.5">
                  <span
                    className="mt-0.5 inline-block size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: dotColor(x) }}
                    title={dotLabel(x)}
                    aria-label={dotLabel(x)}
                  />
                </td>
                <td className="whitespace-nowrap py-2 pr-3 font-mono text-[12px] text-secondary">{tsShort(x.ts)}</td>
                <td className="py-2 pr-3">
                  {x.running && x.progress ? (
                    <span className="inline-flex items-center gap-2 font-mono text-[12px] text-secondary">
                      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-[color:var(--color-display)]" />
                      <span className="text-disabled">{x.progress.step}</span>
                      <span className="truncate">{x.progress.label}</span>
                    </span>
                  ) : x.error ? (
                    // Errored run — the red swatch already flags it; show the reason here.
                    <span className="text-secondary">{x.error}</span>
                  ) : (
                    // One run = one scannable line. Clamp the message to 2 lines; the
                    // full text lives on the run drill-in (row is clickable).
                    <span className="line-clamp-2">{x.message || ''}</span>
                  )}
                </td>
                <td className="whitespace-nowrap py-2 font-mono text-[12px] text-secondary">{dur(x.durationMs)}</td>
              </tr>
            ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-[13px] text-disabled">never run</div>
      )}
    </>
  )

  // The loop's live-synced artifacts (Phase 2) — its own lazy-by-loopId section
  // (the detail payload stays small; FilesView fetches + self-polls). Sits under
  // the run history, the loop's "what it produced" surface beside "what it ran".
  const filesBlock = <FilesView loopId={id} running={running} />

  // ---- edit-via-Claude-Code mode: the primary path (Agent-First). Describe the
  // change; the server dispatches a one-off `edit` run to the loop's machine, where
  // claude applies it (schedule + task.md). No claim/paste — the dashboard's poll
  // reflects it, and the edit run shows in history (watch it live via progress). ----
  if (editVia) {
    const onMachine = detail.machine.name ? `“${detail.machine.name}”` : 'the machine this loop runs on'
    const exitEdit = () => {
      setEditVia(false)
      setEditDispatched(false)
    }
    // The run that landed from this dispatch (a fresh `edit` run not seen before).
    const editRun = editDispatched ? findEditRun(runs) : undefined
    const editSettled = editRun && !editRun.running
    const traceText = editTrace?.length ? formatTranscript(editTrace) : ''
    return (
      <>
        <ModalHead title={`Edit · ${s.name}`} />
        <button
          type="button"
          onClick={exitEdit}
          className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:text-display"
        >
          <span aria-hidden>←</span> Back
        </button>

        {editDispatched ? (
          // ---- watching: the dispatched edit run streams in here (no jump to detail) ----
          <div className="mt-4">
            <div className="text-[13px] leading-snug text-secondary">
              Dispatched to Claude Code on {onMachine}. Watching it apply the change:
            </div>

            {/* Status header — queued → applying → settled outcome. */}
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

            {/* Activity — the full transcript once it settles, else the accumulated
                live progress lines so the stream is kept, not just the latest. */}
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

            {/* Report + files (once settled). */}
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
          // ---- compose: describe the change, dispatch it ----
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
              <button
                className={btnCost}
                disabled={pending === 'edit' || !editInstruction.trim()}
                onClick={() => void onRequestEdit()}
              >
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
      </>
    )
  }

  // ---- edit mode: a focused full-width form replacing the read body ----
  if (editing) {
    return (
      <>
        <ModalHead title={`Edit · ${s.name}`} />
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
      </>
    )
  }

  // ---- read mode ----
  // The action toolbar (verbs + transient notices) — heads the right "controls"
  // column in the split layout, or the whole stack in the plain layout.
  const toolbar = (
    <div>
      {offlineEl}
      {actionErrEl}
      {flashLine}
      {actionBar}
    </div>
  )

  // Two columns of meaning: LEFT = output (live dashboard + the runs behind it),
  // RIGHT = definition + controls (action verbs + task spec). Stacks below `lg`.
  // The LEFT column drives the height (dashboard + its capped runs); the grid
  // stretches the RIGHT column to match, where the task fills the leftover and
  // scrolls — so the modal is sized to its content, not the viewport, and the two
  // columns bottom-align. (The task is absolutely-positioned, so its long content
  // can't inflate the row — see taskBlock.)
  const body = hasUi ? (
    <div className="mt-5 grid grid-cols-1 gap-x-9 gap-y-6 lg:grid-cols-2">
      <div className="min-w-0">
        <LoopView html={job.ui!} runs={runs} />
        {runsBlock}
        {filesBlock}
      </div>
      <div className="min-w-0 lg:flex lg:flex-col">
        {toolbar}
        {taskBlock(true)}
      </div>
    </div>
  ) : (
    // Plain layout (no agent-authored UI yet): a single column — toolbar, then
    // task spec, run history, then the loop's synced files. Each stays capped.
    <div className="mt-5">
      {toolbar}
      {taskBlock(false)}
      {runsBlock}
      {filesBlock}
    </div>
  )

  return (
    <>
      <ModalHead
        title={s.name}
        sub={
          <>
            <code className="font-mono">{s.id}</code> · next {fmt(s.nextRun)}
            {s.graduation ? ` · ${s.graduation}` : ''}
          </>
        }
      />

      {body}
    </>
  )
}
