/**
 * KERNEL RUN RECOVERY - guarantee every claimed kernel run eventually settles
 * (done / failed / superseded), across daemon crashes, restarts, and machine
 * loss (the 2026-08-11 review's reliability finding: a claimed kernel run had
 * no path back once its daemon vanished, and a stuck running run blocks the
 * task's next fire).
 *
 * The lease table IS the claim register (minted just before the claim commits,
 * retired at run-finish), so recovery never needs a new bookkeeping entity.
 * Two complementary detectors:
 *
 *  1. ORPHAN RECONCILE (poll-driven): a kernel-aware daemon reports the runIds
 *     it is executing on every poll (`kernelInFlight`, additive). An active
 *     kernel lease for THIS machine whose run is absent from the report - and
 *     older than a short claim-in-transit grace - means the daemon lost it
 *     (crash/restart, or the delivery response never arrived): reclaim as
 *     failed. This also heals the irreducible "claim committed but the poll
 *     response was lost" window in claimAndPackage.
 *
 *  2. OFFLINE RECLAIM (sweep-driven): a machine silent longer than
 *     LOOPANY_KERNEL_OFFLINE_RECLAIM_MS (default 6h - generous on purpose, so
 *     a laptop asleep mid-run resumes and finishes normally on wake) has its
 *     claimed kernel runs reclaimed as failed, unblocking the task's future
 *     fires.
 *
 * Reclaim = the normal kernel `run-finish failed` decided with a CLOCK actor
 * (server authority), then the run's leases retire outright. There is no
 * late-reconcile window (unlike production's terminal-grace wake-report): a
 * kernel run's durable value lives in the EVENTS the agent wrote incrementally,
 * so a post-reclaim finish simply gets a clean 401 and the next fire redoes the
 * pass. Deliberate simplification, recorded on the task.
 */
import { decide, type Provenance } from "@loopany/kernel";
import * as store from "../db/store.js";
import { kernelLeases, retireLeasesForRun, type KernelLeaseRow } from "../gateway/tokens.js";
import { logger } from "../logger.js";
import { applyChangesetForTeam, readSnapshot } from "./store.js";
import { notifyKernelChangeset } from "./notify.js";

/** Reclaims act as the server authority - a clock actor, like the tick. */
const RECLAIM_ACTOR: Provenance = { entrance: "clock", actorId: "kernel-reclaim" };

/** How long a fresh claim may go unreported before the orphan reconcile treats
 *  it as lost (covers claim-in-transit: the poll that claimed it has not
 *  returned/executed yet). */
export const CLAIM_REPORT_GRACE_MS = 2 * 60_000;

/** Machine-silence threshold for the offline reclaim. Generous by default so a
 *  sleeping laptop wakes and finishes normally; env-tunable for tests/ops. */
export function kernelOfflineReclaimMs(): number {
  const raw = process.env.LOOPANY_KERNEL_OFFLINE_RECLAIM_MS;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : 6 * 3600_000;
}

/** Settle ONE claimed kernel run as failed (idempotent, CAS-guarded) and retire
 *  its leases. An already-settled run just gets its lease cleanup. */
export async function reclaimKernelRun(
  teamId: string,
  runId: string,
  note: string,
): Promise<"reclaimed" | "already-settled" | "conflict"> {
  const snapshot = await readSnapshot(teamId);
  const run = snapshot.runs.find((r) => r.id === runId);
  if (!run || (run.state !== "running" && run.state !== "claimed")) {
    await retireLeasesForRun(runId);
    return "already-settled";
  }
  const d = decide({ op: "run-finish", runId, outcome: "failed", note }, snapshot, RECLAIM_ACTOR, new Date().toISOString());
  if (!d.ok) {
    // A refusal here means the state moved under us - treat as settled elsewhere.
    logger.warn({ teamId, runId, code: d.refusal.code }, "kernel reclaim: run-finish refused");
    await retireLeasesForRun(runId);
    return "already-settled";
  }
  const applied = await applyChangesetForTeam(teamId, d.changeset);
  if (!applied.ok) {
    // Lost the CAS to a real (agent) finish or a concurrent reclaim - fine, the
    // run settled; the winner's path owns the lease retirement.
    return "conflict";
  }
  // A reclaim that AUTO-PARKED the task pushes the owner notification (plain
  // reclaim failures stay quiet - the backoff ladder retries).
  await notifyKernelChangeset(teamId, d.changeset);
  await retireLeasesForRun(runId);
  logger.warn({ teamId, runId, note }, "kernel run reclaimed as failed");
  return "reclaimed";
}

/** Poll-driven orphan reconcile (detector 1). `reported` is the daemon's
 *  kernelInFlight list - ONLY call this when the daemon actually sent one
 *  (absence means an old daemon, never an empty claim set). */
export async function reconcileKernelInFlight(
  machineId: string,
  reported: readonly string[],
  now: number = Date.now(),
): Promise<number> {
  const held = new Set(reported);
  let reclaimed = 0;
  for (const lease of await kernelLeases(machineId)) {
    if (held.has(lease.runId)) continue;
    if (now - Date.parse(lease.createdAt) < CLAIM_REPORT_GRACE_MS) continue;
    const r = await reclaimKernelRun(
      lease.kernelTeamId,
      lease.runId,
      "reclaimed: the daemon is no longer executing this run (crash or restart)",
    );
    if (r === "reclaimed") reclaimed++;
  }
  return reclaimed;
}

/** Sweep-driven offline reclaim (detector 2): every active kernel lease whose
 *  machine has been silent past the threshold (or no longer exists). */
export async function sweepOfflineKernelRuns(now: number = Date.now()): Promise<number> {
  const leases = await kernelLeases();
  if (leases.length === 0) return 0;
  const threshold = kernelOfflineReclaimMs();
  const byMachine = new Map<string, KernelLeaseRow[]>();
  for (const l of leases) {
    const rows = byMachine.get(l.machineId);
    if (rows) rows.push(l);
    else byMachine.set(l.machineId, [l]);
  }
  let reclaimed = 0;
  for (const [machineId, rows] of byMachine) {
    const machine = await store.getMachine(machineId);
    const lastSeen = machine?.lastSeen ? Date.parse(machine.lastSeen) : 0;
    if (machine && now - lastSeen < threshold) continue;
    for (const lease of rows) {
      // A lease younger than the claim grace never reclaims (freshly claimed
      // work on a machine that just went quiet gets its window).
      if (now - Date.parse(lease.createdAt) < CLAIM_REPORT_GRACE_MS) continue;
      const r = await reclaimKernelRun(
        lease.kernelTeamId,
        lease.runId,
        machine
          ? "reclaimed: the machine has been offline past the reclaim window"
          : "reclaimed: the machine no longer exists",
      );
      if (r === "reclaimed") reclaimed++;
    }
  }
  return reclaimed;
}
