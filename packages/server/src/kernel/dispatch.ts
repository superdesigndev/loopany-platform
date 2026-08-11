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
import { buildCorePromptForRun, wakeReasonFor } from "@loopany/cli";
import { decide, type Provenance, type RunRecord, type TaskObject } from "@loopany/kernel";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { kernelRuns } from "../db/schema.js";
import * as store from "../db/store.js";
import { registerRunLease } from "../gateway/tokens.js";
import { logger } from "../logger.js";
import { applyChangesetForTeam, readSnapshot } from "./store.js";
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
 *  (across the owner's teams) whose assignee machine segment matches this
 *  machine's alias (or friendly name), claimed atomically and packaged. A claim
 *  CAS loss (another poll won) skips silently; a prompt/lease failure logs and
 *  leaves the run pending for the next poll. */
export async function kernelDeliveriesForMachine(machineId: string): Promise<KernelRunDelivery[]> {
  const machine = await store.getMachine(machineId);
  if (!machine?.userId) return [];
  const handles = new Set(
    [machine.alias, machine.name].filter((h): h is string => !!h && h.trim().length > 0),
  );
  if (handles.size === 0) return [];

  const out: KernelRunDelivery[] = [];
  for (const team of await store.listTeamsForUser(machine.userId)) {
    for (const run of await pendingKernelRuns(team.id)) {
      const seg = assigneeSegments(run.assignee);
      if (!seg || !handles.has(seg.machine)) continue;
      const delivery = await claimAndPackage(team.id, machineId, run, seg.agent);
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
  // The kernel claim: pending -> running, sessionId captured on the run + the
  // task's stream (same synthetic id scheme the local tick --spawn uses).
  const sessionId = `spawn-${run.id}`;
  const actor: Provenance = { entrance: "agent-run", actorId: run.id, sessionId };
  const snapshot = await readSnapshot(teamId);
  const d = decide({ op: "run-claim", runId: run.id, sessionId }, snapshot, actor, new Date().toISOString());
  if (!d.ok) {
    // Most likely a concurrent poll already claimed it - not an error.
    logger.info({ teamId, runId: run.id, code: d.refusal.code }, "kernel delivery: claim refused, skipping");
    return undefined;
  }
  const applied = await applyChangesetForTeam(teamId, d.changeset);
  if (!applied.ok) {
    // CAS loss: the concurrent claimer won at the row level. The run is theirs.
    logger.info({ teamId, runId: run.id }, "kernel delivery: claim CAS lost, skipping");
    return undefined;
  }

  // Render the CORE against the POST-claim state (the claim just flipped the
  // task to in-progress; the agent must see what it will find).
  const claimed = await readSnapshot(teamId);
  const claimedTask = claimed.objects[run.taskId];
  const claimedRun = claimed.runs.find((r) => r.id === run.id);
  if (!claimedRun || claimedTask?.archetype !== "task") {
    logger.warn({ teamId, runId: run.id }, "kernel delivery: post-claim state missing task/run");
    return undefined;
  }
  const prompt = buildCorePromptForRun(
    claimedRun,
    claimedTask as TaskObject,
    wakeReasonFor(claimedRun, claimedTask as TaskObject),
  );

  const runToken = await registerRunLease({
    runId: run.id,
    loopId: run.taskId, // informational for kernel leases; the kernel fields are authoritative
    machineId,
    role: "exec",
    allowControl: true,
    kernelTeamId: teamId,
    kernelTaskId: run.taskId,
  });

  return {
    runId: run.id,
    taskId: run.taskId,
    runToken,
    prompt,
    workdir: (claimedTask as TaskObject).workdir,
    agent,
  };
}
