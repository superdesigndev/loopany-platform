/**
 * Derives the onboarding "first run" wait-state from the real run mechanics.
 *
 * At loop creation the server kicks an immediate exec run (`createLoop` →
 * `scheduler.runNow`). So there is normally a run to watch straight away:
 *   - a run that finished OK           → 'done'   (the payoff: open the Loop page)
 *   - a run that finished with an error → 'failed' (still hand off into the run page,
 *     but the copy must not claim success)
 *   - a claimed, in-flight run         → 'running' (show the live in-progress state)
 *   - a queued run + an ONLINE machine → 'running' (about to start)
 *   - a queued run + an OFFLINE machine, or no run yet on an offline machine, or a
 *     superseded run → 'scheduled' (honest handoff — never trap the user on a spinner
 *     when the run only happens at the next tick / when the machine comes back).
 *
 * Pure, so the branch table is unit-testable without a DB. Zero code-exec: this only
 * READS run rows; it never triggers execution (the run-now is the existing creation
 * kickoff, not a new primitive).
 */
export type FirstRunState = 'running' | 'done' | 'failed' | 'scheduled'

/** The two states that mean "the first run reached a terminal outcome" — both hand
 *  off into the run page, they just say different (honest) things about it. */
export function firstRunFinished(state: FirstRunState): boolean {
  return state === 'done' || state === 'failed'
}

export function firstRunStateFrom(opts: { phase: string | null; hasRun: boolean; machineOnline: boolean }): FirstRunState {
  if (!opts.hasRun) return opts.machineOnline ? 'running' : 'scheduled'
  switch (opts.phase) {
    case 'done':
      return 'done'
    case 'error':
      return 'failed'
    case 'running':
      return 'running'
    case 'pending':
      return opts.machineOnline ? 'running' : 'scheduled'
    default:
      // 'canceled' (superseded) or anything unexpected → nothing to watch here.
      return 'scheduled'
  }
}
