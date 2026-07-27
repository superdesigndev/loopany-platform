import { useEffect, useState } from 'react'
import { claimProgress } from '../server/loopApi'
import { CREATION_STEPS, deriveStepStates, type StepState } from '../lib/creationSteps'

/**
 * The live loop-creation checklist + its claim-progress polling — the ONE shared
 * surface behind both the onboarding wizard's Create step AND the dashboard's regular
 * New-Loop "Waiting for your coding agent…" state, so the two can't drift (same pattern
 * as the shared `ChannelAddForm`).
 *
 * The agent reports milestones via `loopany progress` (round 8) → POST
 * /api/claim/progress; this polls `claimProgress(claimToken)` and lights the steps up.
 * BEST-EFFORT and NEVER authoritative — an agent that reports nothing just shows the
 * first step pulsing (a richer "waiting"); loop-created detection stays the real signal.
 */

/** Poll the agent-reported creation milestones for a claim token while `active`. */
export function useCreationProgress(token: string | null | undefined, active: boolean): string[] {
  const [steps, setSteps] = useState<string[]>([])
  useEffect(() => {
    if (!active || !token) {
      setSteps([])
      return
    }
    let alive = true
    const tick = async () => {
      const p = await claimProgress({ data: token }).catch(() => undefined)
      // Only replace on a real change so the reference stays stable between polls.
      if (alive && p?.steps) setSteps((prev) => (prev.length === p.steps.length ? prev : p.steps))
    }
    void tick()
    const t = setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [token, active])
  return steps
}

export function CreationChecklist({ steps }: { steps: string[] }) {
  const states = deriveStepStates(steps)
  return (
    <ul className="mt-4 flex flex-col gap-1">
      {CREATION_STEPS.map((s, i) => {
        const state = states[i] ?? 'pending'
        return (
          <li key={s.key} className="flex items-center gap-3 py-1">
            <StepIcon state={state} />
            <span className={`text-body leading-snug transition-colors duration-300 ${state === 'pending' ? 'text-disabled' : 'text-display'}`}>
              {s.label}
            </span>
            {state === 'active' && <span className="ml-auto text-caption text-secondary">working…</span>}
          </li>
        )
      })}
    </ul>
  )
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-rubik-green text-[11px] font-bold leading-none text-white"
        style={{ animation: 'hk-pop 0.45s var(--hk-spring) both' }}
      >
        ✓
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center">
        <span className="size-2.5 rounded-full bg-rubik-orange" style={{ animation: 'runPulse 1.4s ease-in-out infinite' }} />
      </span>
    )
  }
  return <span className="size-5 shrink-0 rounded-full border border-hairline" />
}
