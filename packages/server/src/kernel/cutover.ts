/**
 * Convergence S3.1: dispose of the rows the retired kernel run queue still owned.
 *
 * S3 removed every producer and every claimer of a kernel-lifecycle run row, and
 * with `RunQueueScheduler` off the boot path the attestation reclaim
 * (`reclaimExpired`) lost its runtime caller. The shipping guards cannot take
 * over: `store.openRuns()` and `pendingRunsForMachine()` both fence on
 * `queue_state IS NULL` (the rw3-B1 fence, deliberately kept). So a row left
 * `queue_state='claimed'`/`'queued'` at the instant of the cutover is covered by
 * NEITHER guard — and because `hasRunningRun`/`openRunsForLoop` carry no
 * queue-state filter, a stranded `claimed` row keeps its converged twin's loop
 * "running" forever: the poll claim guard holds every future pending run, the
 * sweep's never-claimed reclaim stands down, and the scheduler tick early-outs.
 * Silently, with no error and no notification (cv-s3-review F1).
 *
 * This pass closes that boundary BY CONSTRUCTION rather than by runbook, so
 * design §9.3's "at no stage is there a window where neither guard covers a
 * claimed run" holds as written. Such a row can never execute again — nothing
 * mints, claims, renews or finishes one after S3 — so terminalizing it is the
 * only honest disposal.
 *
 * Why BOOT and not the converge script: boot is the one chokepoint every S3+
 * stack passes through, on every start, whether or not the operator ever ran
 * `kernel:converge-loops` (a stack converged before this rider shipped, or one
 * that migrated by hand, would be missed by a converge-time pass). It runs
 * before the scheduler starts, so no tick can early-out on a row this pass is
 * about to close. Idempotent by construction: a terminalized row no longer
 * carries an open queue state, so a later boot finds nothing.
 */
import { eq, inArray } from "drizzle-orm";

import { db } from "../db/index.js";
import { runs, type Run } from "../db/schema.js";
import { logger } from "../logger.js";
import { appendProductionRunFinished } from "./runQueue.js";

const log = logger.child({ mod: "cutover" });

/** Recorded on every row this pass closes, so the disposal is self-explaining
 * wherever the run surfaces (CLI log, run page, kernel timeline). */
export const STRANDED_RUN_ERROR =
  "stranded at the S3 cutover - the kernel run queue was retired while this run was still open";

export interface StrandedRunsReport {
  terminalized: { runId: string; loopId: string; queueState: string; phase: string }[];
}

/**
 * Terminalize every open kernel queue-state row. NEVER touches a
 * `queue_state IS NULL` production row — those are the shipping sweep's, and
 * `inArray` on the two open states cannot match NULL.
 *
 * Event discrimination follows the S2 F4 hook verbatim
 * (`appendProductionRunFinished`): a provenance-carrying row (`reason`/`scope`)
 * closes its kernel timeline with the frozen derived `run-finished` fact, and a
 * provenance-free row stays event-silent, exactly as ordinary production
 * cron/edit/evolve history does.
 */
export async function terminalizeStrandedQueueRows(now: Date = new Date()): Promise<StrandedRunsReport> {
  const stranded = await db.select().from(runs).where(inArray(runs.queueState, ["queued", "claimed"]));
  const report: StrandedRunsReport = { terminalized: [] };
  if (stranded.length === 0) return report;

  log.warn(
    { count: stranded.length },
    "S3 cutover: kernel run-queue rows are still open and can never execute again - terminalizing",
  );
  const stamp = now.toISOString();
  for (const run of stranded) {
    log.warn(
      { runId: run.id, loopId: run.loopId, queueState: run.queueState, phase: run.phase, reason: run.reason, scope: run.scope },
      "S3 cutover: terminalizing a stranded kernel run row (it would otherwise wedge its converged loop)",
    );
    const finalized = (
      await db
        .update(runs)
        .set({
          queueState: "failure",
          phase: "error",
          outcome: "error",
          error: STRANDED_RUN_ERROR,
          finishedAt: stamp,
          leaseState: null,
          leaseExpiresAt: null,
        })
        .where(eq(runs.id, run.id))
        .returning()
    )[0] as Run | undefined;
    await appendProductionRunFinished(finalized, "failure", stamp, STRANDED_RUN_ERROR);
    report.terminalized.push({ runId: run.id, loopId: run.loopId, queueState: run.queueState!, phase: run.phase });
  }
  return report;
}
