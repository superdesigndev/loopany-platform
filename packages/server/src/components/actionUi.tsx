import { useEffect, useRef, useState } from 'react'
import { buildResumeCommand } from '../lib/resumeCommand'
import { btn, btnDanger, btnPrimary } from './ui'

/**
 * Shared building blocks for high-stakes action rows (loop detail, run view, …).
 * The point of this file: a caller toggles ONE piece of state (`confirming`) or
 * calls ONE handler (`arm`) — all the fiddly focus / keyboard / aria / timer
 * bookkeeping lives here, not inlined as a pile of hooks in every screen.
 */

export type Flash = { label: string; tone?: 'ok' | 'gone'; undo?: () => void; hold?: number }

/**
 * First-load failure card — the calm "couldn't load X" + Retry the dashboard,
 * loop page, and run page all show instead of a raw error dump. One shared
 * markup so the three screens can't drift.
 */
export function LoadErrorCard({ title, detail, onRetry }: { title: string; detail?: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-card border border-hairline bg-surface px-6 py-8 shadow-card">
      <div className="text-[14px] text-accent">{title}</div>
      {detail && <div className="mt-1 text-meta text-secondary">{detail}</div>}
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 cursor-pointer border-none bg-transparent p-0 text-label font-medium text-interactive underline underline-offset-2 hover:text-display"
      >
        Retry
      </button>
    </div>
  )
}

/**
 * In-panel guard — the Nothing-styled stand-in for native confirm(). Owns its
 * own a11y so the caller just renders it when armed: focus lands on the CTA,
 * Esc cancels, Enter (CTA focused) confirms. Render with `key={kind}` so it
 * remounts (and re-focuses) per guard.
 */
export function ConfirmBar({
  prompt,
  note,
  cta,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  prompt: string
  note?: string
  cta: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ctaRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ctaRef.current?.focus()
  }, [])
  return (
    <div
      role="group"
      aria-label={prompt}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel()
      }}
      className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-control border border-hairline bg-raised px-4 py-3"
    >
      <div className="min-w-0">
        <div className="text-body font-medium text-display">{prompt}</div>
        {note && <div className="mt-0.5 text-meta text-secondary">{note}</div>}
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <button ref={ctaRef} className={danger ? btnDanger : btnPrimary} disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : cta}
        </button>
        <button className={btn} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The claude-code pixel-terminal mark (LobeHub icon set), in the Claude brand
 *  orange. Decorative (aria-hidden): the button text stays the accessible name,
 *  keeping generic copy agent-neutral while the LOGO is factual — a resumable
 *  session is always a claude one today (codex runs via claude; a grok run's
 *  telemetry is degraded, no session id). Swap per-agent once another agent
 *  yields a resumable session. */
function ClaudeCodeMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="#D97757"
      fillRule="evenodd"
      className="shrink-0"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      />
    </svg>
  )
}

/**
 * "Continue agent session" copy affordance (run page + loop page) — copies a
 * ready-to-paste terminal command (`cd '<loop dir>' && claude --resume <id>`)
 * that reopens the run's coding-agent session on the owner's machine. BYOA: the
 * session lives there, so copy-a-command is the whole feature.
 *
 * A hook returning TWO pieces, because the paste-it-here instruction must NOT
 * be the button's flex sibling: these toolbars are flex-wrap rows, and an
 * injected full-width line reflows the buttons after it (a real bug: the ⋯ menu
 * got pushed to its own line). The caller places `button` IN the row and `hint`
 * BELOW the row. `sessionId: null` ⇒ both render null, so callers can invoke
 * the hook unconditionally (hooks can't be conditional) while data loads.
 * Prose stays agent-neutral; the literal `claude` binary in the copied command
 * is factual (only claude runs produce a resumable session today - codex runs
 * via claude, grok telemetry is degraded).
 */
export function useContinueSession({
  sessionId,
  dir,
  machineName,
  label,
}: {
  sessionId: string | null
  dir?: string | null
  machineName?: string | null
  label: string
}): { button: React.ReactNode; hint: React.ReactNode } {
  const [copied, setCopied] = useState(false)
  const [copyErr, setCopyErr] = useState(false)
  if (!sessionId) return { button: null, hint: null }
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildResumeCommand({ sessionId, dir }))
      setCopyErr(false)
      setCopied(true)
      setTimeout(() => setCopied(false), 4000)
    } catch {
      setCopyErr(true)
    }
  }
  const onMachine = machineName ? `“${machineName}”` : 'the bound machine'
  const button = (
    <button
      type="button"
      className={btn}
      title={`Copies a terminal command that resumes this coding-agent session on ${onMachine}`}
      onClick={() => void onCopy()}
    >
      <span className="inline-flex items-center gap-1.5">
        <ClaudeCodeMark />
        {copied ? '✓ Command copied' : label}
      </span>
    </button>
  )
  const hint = (copied || copyErr) && (
    <div role="status" aria-live="polite" className="mt-2 text-caption leading-snug text-secondary">
      {copyErr ? (
        <span className="text-accent">Could not copy the command - try again or copy it manually.</span>
      ) : (
        <>
          ✓ Copied · paste it in a terminal on {onMachine} to continue the agent conversation for this loop.
        </>
      )}
    </div>
  )
  return { button, hint }
}

/**
 * Transient peak-end acknowledgement (✓ done / ✕ gone), announced to AT via
 * aria-live. Self-clearing is the caller's concern (see `useFlash`); this is
 * pure presentation. No outer margin — wrap at the call site for spacing.
 */
export function FlashLine({ label, tone = 'ok', onUndo }: { label: string; tone?: 'ok' | 'gone'; onUndo?: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 text-label font-medium text-secondary"
      style={{ animation: 'fadeIn 0.2s ease-out' }}
    >
      <span aria-hidden className={tone === 'gone' ? 'text-accent' : 'text-success'}>
        {tone === 'gone' ? '✕' : '✓'}
      </span>
      {label}
      {onUndo && (
        <button
          type="button"
          onClick={onUndo}
          className="cursor-pointer border-none bg-transparent p-0 text-label font-medium text-interactive underline underline-offset-2 transition-colors hover:text-display"
        >
          Undo
        </button>
      )}
    </div>
  )
}

/**
 * Flash state + its self-clear timer in one unit. `hold` wins; else an Undo
 * flash lingers ~6s (reachable), a bare "done" fades after ~2.2s. Fade, don't
 * slide.
 */
export function useFlash() {
  const [flash, setFlash] = useState<Flash | null>(null)
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), flash.hold ?? (flash.undo ? 6000 : 2200))
    return () => clearTimeout(t)
  }, [flash])
  return [flash, setFlash] as const
}

/**
 * Optimistic delete with an Undo window — for backends with no restore. The real
 * `commit` is held for `windowMs` while the caller shows a tombstone (`armed`).
 * It fires on window-expiry, on unmount, or when `key` changes, so a torn-down /
 * navigated-away panel never silently abandons the deletion. `pendingKey` pins
 * WHICH item is doomed, so a prop change can't redirect the delete. `onExpire`
 * runs only on the natural countdown (e.g. close the panel) — not on teardown.
 */
export function useDeferredDelete(
  key: string,
  commit: (key: string) => void | Promise<void>,
  opts?: { windowMs?: number; onExpire?: () => void },
) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingKey = useRef<string | null>(null)
  // Latest callbacks without resubscribing the teardown effect.
  const cbs = useRef({ commit, onExpire: opts?.onExpire })
  cbs.current = { commit, onExpire: opts?.onExpire }

  const flush = (fromCountdown: boolean) => {
    const k = pendingKey.current
    pendingKey.current = null
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!k) return
    void cbs.current.commit(k)
    if (fromCountdown) cbs.current.onExpire?.()
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  const arm = () => {
    pendingKey.current = key
    setArmed(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      flushRef.current(true)
      setArmed(false)
    }, opts?.windowMs ?? 6000)
  }
  const cancel = () => {
    pendingKey.current = null
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setArmed(false)
  }

  // New item → start un-armed; leaving the old one → commit its pending delete.
  useEffect(() => {
    setArmed(false)
    return () => flushRef.current(false)
  }, [key])

  return { armed, arm, cancel }
}
