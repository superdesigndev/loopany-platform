/**
 * The fixed, server-defined vocabulary of loop-creation milestones the coding agent
 * reports as it builds the loop, so the onboarding wizard can light up a live
 * checklist instead of a bare "Waiting…". Derived from what bootstrap.md / create.md
 * actually walk the agent through. English, ~5 user-meaningful steps.
 *
 * These are BEST-EFFORT progress hints — never authoritative. The wizard's real
 * completion signal stays the loop-created claim detection; an agent that reports
 * nothing degrades to the plain waiting state.
 *
 * Pure + shared: the server route/store validate against this enum (untrusted input
 * — only these keys are ever stored), and the wizard renders the labels.
 */
export interface CreationStep {
  key: string
  label: string
}

export const CREATION_STEPS: CreationStep[] = [
  { key: 'reading', label: 'Reading the setup instructions' },
  { key: 'inspecting', label: 'Inspecting your project' },
  { key: 'configuring', label: 'Configuring the schedule' },
  { key: 'authoring', label: 'Authoring the task file & dashboard' },
  { key: 'creating', label: 'Creating the loop' },
]

export const CREATION_STEP_KEYS: string[] = CREATION_STEPS.map((s) => s.key)

/** A reported step is valid only if it is one of the fixed keys (rejects free text). */
export function isCreationStep(x: unknown): x is string {
  return typeof x === 'string' && CREATION_STEP_KEYS.includes(x)
}

export function stepIndex(key: string): number {
  return CREATION_STEP_KEYS.indexOf(key)
}

export type StepState = 'done' | 'active' | 'pending'

/**
 * Derive each step's display state from the (untrusted, unordered) set of reported
 * keys. Tolerant by construction: unknown keys are ignored, order doesn't matter, and
 * a skipped intermediate step still shows done once a LATER step is reported (we key
 * off the highest reported index). With nothing reported, the first step is "active"
 * so the checklist reads as "starting", never dead.
 */
export function deriveStepStates(reported: string[]): StepState[] {
  const idxs = reported.map(stepIndex).filter((i) => i >= 0)
  const highest = idxs.length ? Math.max(...idxs) : -1
  return CREATION_STEPS.map((_, i) => (i <= highest ? 'done' : i === highest + 1 ? 'active' : 'pending'))
}
