/**
 * Dormant compatibility flags retained until convergence S5 cleanup.
 */

/**
 * S3 runtime code no longer consults this flag: daemon and server use the
 * production poll path, and loopany-dev has a presentation-only home marker.
 * Keep the symbol until S5 deletes the old protocol modules and their tests.
 */
export function runsV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOPANY_RUNS_V2 === "1";
}
