import { useEffect, useRef, useState } from 'react'
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
    <div className="rounded-2xl border border-wire bg-surface px-6 py-8">
      <div className="text-[14px] text-accent">{title}</div>
      {detail && <div className="mt-1 text-[12.5px] text-secondary">{detail}</div>}
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 cursor-pointer border-none bg-transparent p-0 font-mono text-[12px] tracking-[0.08em] text-interactive underline underline-offset-2 hover:text-display"
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
      className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-md border border-wire bg-raised px-4 py-3"
    >
      <div className="min-w-0">
        <div className="font-mono text-[11px] tracking-[0.08em] text-display">{prompt}</div>
        {note && <div className="mt-0.5 text-[12.5px] text-secondary">{note}</div>}
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
      className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-secondary"
      style={{ animation: 'fadeIn 0.2s ease-out' }}
    >
      <span aria-hidden className={tone === 'gone' ? 'text-accent' : 'text-display'}>
        {tone === 'gone' ? '✕' : '✓'}
      </span>
      {label}
      {onUndo && (
        <button
          type="button"
          onClick={onUndo}
          className="cursor-pointer border-none bg-transparent p-0 font-mono text-[11px] tracking-[0.08em] text-interactive underline underline-offset-2 transition-colors hover:text-display"
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
