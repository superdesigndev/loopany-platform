/**
 * The onboarding wizard's step state machine + resume persistence — pure, so it is
 * unit-testable without rendering React. The wizard component owns the effects
 * (minting tokens, polling detection); this module owns the durable shape: which
 * step we're on and the tokens minted so far, so a mid-flow reload resumes exactly
 * where the user left off.
 */
export const STEPS = ['welcome', 'machine', 'meet', 'prompt', 'live'] as const
export type Step = (typeof STEPS)[number]

/** The numbered steps shown in the progress rail. `live` (celebration + first-run
 *  wait + notify binding) is the final step; the payoff hands off into the Loop page. */
export const NUMBERED: Step[] = ['welcome', 'machine', 'meet', 'prompt', 'live']
export const STEP_LABEL: Record<Step, string> = {
  welcome: 'Welcome',
  machine: 'Connect',
  meet: 'Preview',
  prompt: 'Create',
  live: 'Live',
}

export interface Persisted {
  step: Step
  machineId: string | null
  machineToken: string | null
  claimToken: string | null
  /** The created loop's id (set when claimStatus resolves) — the `live` step waits on
   *  its first run and hands off into its Loop page. */
  loopId: string | null
}

export const EMPTY: Persisted = { step: 'welcome', machineId: null, machineToken: null, claimToken: null, loopId: null }

const keyFor = (teamKey: string) => `loopany.onboarding.v1:${teamKey}`
const dismissKeyFor = (teamKey: string) => `loopany.onboarding.dismissed.v1:${teamKey}`

export function loadPersisted(teamKey: string): Persisted {
  if (typeof window === 'undefined') return EMPTY
  try {
    const raw = window.localStorage.getItem(keyFor(teamKey))
    if (!raw) return EMPTY
    const p = JSON.parse(raw) as Partial<Persisted>
    // Validate the step against the known set — a stale/corrupt value restarts clean.
    const step = STEPS.includes(p.step as Step) ? (p.step as Step) : 'welcome'
    return {
      step,
      machineId: typeof p.machineId === 'string' ? p.machineId : null,
      machineToken: typeof p.machineToken === 'string' ? p.machineToken : null,
      claimToken: typeof p.claimToken === 'string' ? p.claimToken : null,
      loopId: typeof p.loopId === 'string' ? p.loopId : null,
    }
  } catch {
    return EMPTY
  }
}

export function savePersisted(teamKey: string, p: Persisted) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(keyFor(teamKey), JSON.stringify(p))
  } catch {
    /* storage may be unavailable (private mode); the flow still works in-session */
  }
}

export function clearPersisted(teamKey: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(keyFor(teamKey))
  } catch {
    /* ignore */
  }
}

/** Mark onboarding dismissed for this team so the homepage never auto-starts it
 *  again (the user can still re-enter via the "Guided setup" hint). */
export function markOnboardingDismissed(teamKey: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(dismissKeyFor(teamKey), '1')
  } catch {
    /* ignore */
  }
}

/** Whether the homepage has already auto-started (or the user dismissed) onboarding
 *  for this team. Missing storage reads as "not dismissed" so a fresh workspace
 *  still auto-starts. */
export function onboardingDismissed(teamKey: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(dismissKeyFor(teamKey)) === '1'
  } catch {
    return false
  }
}

/** The previous numbered step, or undefined when already at the first. */
export function prevNumbered(step: Step): Step | undefined {
  const i = NUMBERED.indexOf(step)
  return i > 0 ? NUMBERED[i - 1] : undefined
}
