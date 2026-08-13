/**
 * KERNEL RUN DELIVERY (P0 stage C) - the adapter that hands a kernel pending
 * run to the machine its assignee addresses, over the EXISTING poll transport.
 *
 * The kernel decides WHICH run exists (sweep/tick minted it); this module
 * decides nothing - it packages a pending run the polling machine is addressed
 * by into a delivery: the atomic kernel `run-claim` (CAS at apply - two
 * concurrent polls race, exactly one wins), the server-built CORE prompt (the
 * SAME buildCorePromptForRun the local tick --spawn renders, so local and
 * remote agents read byte-identical protocol), the task's workdir + agent
 * segment, and an rk_ run lease minted through the production registerRunLease
 * (kernelTeamId/kernelTaskId mark it as a kernel credential for the
 * /api/kernel/cli bridge).
 *
 * Poll hot-path budget: one indexed pending-runs query per owner team (teams
 * per user are few); no snapshot read unless a pending run actually addresses
 * this machine.
 */
import { buildCorePromptForRun, handbackReplyFor, wakeReasonFor } from "@loopany/cli";
import { decide, type Provenance, type RunRecord, type TaskObject, type WorkflowDefinition } from "@loopany/kernel";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { kernelRuns } from "../db/schema.js";
import * as store from "../db/store.js";
import { registerRunLease, retireLease } from "../gateway/tokens.js";
import { logger } from "../logger.js";
import { recordDispatchBlocked } from "./blocked.js";
import { applyChangesetForTeam, readEvents, readSnapshot } from "./store.js";
import { assigneeSegments } from "./sweep.js";

/** What the daemon receives for one kernel run (rides the poll body as
 *  `kernelRuns` - an ADDITIVE field old daemons ignore). The daemon already
 *  knows the server URL (it is polling it), so the backend base is not sent. */
export interface KernelRunDelivery {
  runId: string;
  taskId: string;
  /** The rk_ run credential the in-run `loopany-kernel` CLI authenticates with. */
  runToken: string;
  /** The server-built CORE prompt - the agent's whole first user turn. */
  prompt: string;
  /** Absolute machine-local cwd (task.workdir); null = daemon picks a scratch dir. */
  workdir: string | null;
  /** The assignee's agent segment (`claude` in `mbp/claude`) - the daemon maps
   *  it onto its own executor profile. */
  agent: string;
  /** Versioned deterministic pre-stage. Null/absent Tasks follow the existing
   * single-Agent path. */
  workflow: WorkflowDefinition | null;
  /** Cursor from the newest successful workflow Run that explicitly returned
   * state. Derived from Run history, never duplicated on the Task. */
  prevWorkflowState: unknown;
}

/** Pending kernel runs for one team - indexed columns only, data blob parsed
 *  by the caller. */
async function pendingKernelRuns(teamId: string): Promise<RunRecord[]> {
  const rows = await db
    .select()
    .from(kernelRuns)
    .where(and(eq(kernelRuns.teamId, teamId), eq(kernelRuns.state, "pending")));
  return rows.map((r) => r.data as RunRecord);
}

/** Build the kernel deliveries for a polling machine: every pending kernel run
 *  (across the owner's teams) whose assignee resolves to THIS machine, claimed
 *  atomically and packaged. Resolution goes through the SAME authoritative
 *  `resolveMachineByAlias` the sweep's wake uses (one resolver, no drift), and
 *  an AMBIGUOUS alias delivers to nobody - a run must never execute on an
 *  arbitrarily-picked machine. A claim CAS loss (another poll won) skips
 *  silently; a prompt/lease failure leaves the run pending for the next poll. */
export async function kernelDeliveriesForMachine(machineId: string): Promise<KernelRunDelivery[]> {
  const machine = await store.getMachine(machineId);
  if (!machine?.userId) return [];

  // The owner's member teams PLUS the machine's home team - open mode's
  // anonymous (shared) machines have no membership rows, only a home teamId.
  const teamIds = new Set((await store.listTeamsForUser(machine.userId)).map((t) => t.id));
  if (machine.teamId) teamIds.add(machine.teamId);

  const out: KernelRunDelivery[] = [];
  for (const teamId of teamIds) {
    for (const run of await pendingKernelRuns(teamId)) {
      const seg = assigneeSegments(run.assignee);
      if (!seg) continue;
      const resolved = await store.resolveMachineByAlias(teamId, seg.machine);
      if (resolved.ambiguous) {
        logger.warn(
          { teamId: teamId, runId: run.id, assignee: run.assignee },
          "kernel delivery: AMBIGUOUS alias - run stays pending; rename one machine via LOOPANY_MACHINE_ALIAS",
        );
        await recordDispatchBlocked(
          teamId,
          run,
          `alias "${seg.machine}" is AMBIGUOUS in this team (two machines expose it) - the run stays pending; rename one machine via LOOPANY_MACHINE_ALIAS`,
        );
        continue;
      }
      if (resolved.machine?.id !== machineId) continue;
      const delivery = await claimAndPackage(teamId, machineId, run, seg.agent);
      if (delivery) out.push(delivery);
    }
  }
  return out;
}

async function claimAndPackage(
  teamId: string,
  machineId: string,
  run: RunRecord,
  agent: string,
): Promise<KernelRunDelivery | undefined> {
  // ORDERING IS THE SAFETY HERE: every fallible step runs BEFORE the CAS claim
  // commits, so a failure anywhere leaves the run PENDING (redeliverable on the
  // next poll) instead of a claimed run nobody holds. The claim decision's own
  // changeset carries the post-claim run + task, so the CORE prompt renders off
  // a PURE projection - no committed-then-read window. The one irreducible gap
  // left is "claim committed but the poll response never reached the daemon",
  // which is the inactivity-reclaim's job, same as production runs.
  const sessionId = `spawn-${run.id}`;
  const actor: Provenance = { entrance: "agent-run", actorId: run.id, sessionId };
  const snapshot = await readSnapshot(teamId);
  const d = decide({ op: "run-claim", runId: run.id, sessionId }, snapshot, actor, new Date().toISOString());
  if (!d.ok) {
    // Most likely a concurrent poll already claimed it - not an error.
    logger.info({ teamId, runId: run.id, code: d.refusal.code }, "kernel delivery: claim refused, skipping");
    return undefined;
  }

  // Project the post-claim state from the decision itself (the claim flips the
  // run to running and may flip a one-shot task to in-progress; the agent must
  // see what it will find).
  const claimedRun =
    d.changeset.runs.map((m) => m.run).find((r) => r.id === run.id) ?? run;
  const preTask = snapshot.objects[run.taskId];
  const claimedTask =
    d.changeset.objects.map((m) => m.object).find((o) => o.id === run.taskId) ?? preTask;
  if (claimedTask?.archetype !== "task") {
    logger.warn({ teamId, runId: run.id }, "kernel delivery: run points at a missing task");
    return undefined;
  }
  // An assignment run carries the hand-back reply (the reassigner's note) in
  // its wake context - same pure helper the local spawn uses (no drift).
  const handback =
    claimedRun.cause === "assignment"
      ? handbackReplyFor(
          (await readEvents(teamId)).filter((e) => e.objectId === run.taskId),
          claimedRun,
        )
      : undefined;
  const prompt = buildCorePromptForRun(
    claimedRun,
    claimedTask as TaskObject,
    wakeReasonFor(claimedRun, claimedTask as TaskObject, handback),
  );
  const previousWorkflowRun = [...snapshot.runs]
    .filter(
      (candidate) =>
        candidate.taskId === run.taskId &&
        candidate.id !== run.id &&
        candidate.state === "done" &&
        candidate.workflow?.format === "loopany-js-v1" &&
        candidate.workflow.outcome !== "failed" &&
        Object.prototype.hasOwnProperty.call(candidate.workflow, "state"),
    )
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0];

  // Mint the lease BEFORE the claim commits: a mint failure leaves the run
  // pending; a CAS loss below retires the orphan lease right away.
  const runToken = await registerRunLease({
    runId: run.id,
    loopId: run.taskId, // informational for kernel leases; the kernel fields are authoritative
    machineId,
    role: "exec",
    allowControl: true,
    kernelTeamId: teamId,
    kernelTaskId: run.taskId,
  });

  const applied = await applyChangesetForTeam(teamId, d.changeset);
  if (!applied.ok) {
    // CAS loss: the concurrent claimer won at the row level. The run is theirs.
    await retireLease(runToken);
    logger.info({ teamId, runId: run.id }, "kernel delivery: claim CAS lost, skipping");
    return undefined;
  }

  return {
    runId: run.id,
    taskId: run.taskId,
    runToken,
    prompt,
    workdir: (claimedTask as TaskObject).workdir,
    agent,
    workflow: (claimedTask as TaskObject).workflow ?? null,
    prevWorkflowState: previousWorkflowRun?.workflow?.state ?? null,
  };
}
