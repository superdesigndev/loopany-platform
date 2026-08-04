/**
 * Runtime flags read from the environment — a LEAF module (zero imports, zero
 * side effects) so the pure router (`route.ts`) and the callback hot path can
 * consult one without pulling in the daemon.
 */

/**
 * The rewrite cutover flag, and it must agree on BOTH sides: the SERVER arms the
 * kernel clock + run queue with it, the DAEMON claims via `/api/agent/runs/claim`
 * instead of the legacy `/api/machine/poll`, and the CLI's bare-command home
 * renders the KERNEL stack instead of the legacy machine dashboard. Default OFF,
 * so every shipping stack keeps the legacy behavior byte-identical.
 */
export function runsV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOPANY_RUNS_V2 === "1";
}
