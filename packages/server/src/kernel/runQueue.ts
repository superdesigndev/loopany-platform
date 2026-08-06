/**
 * THE TRIGGER SEAM — the one mint point for every run a kernel fact produces.
 *
 * What this module IS, after convergence: `queueKernelRun` writes an ordinary
 * PRODUCTION pending run for a trigger (a due task, a human's answer, a human's
 * directive, a manual fire), the shipping poll claims it, and the shipping
 * report finalizes it. `DueTaskScheduler` is the only clock left here, because
 * a task's follow-up date is a kernel fact and nothing in the production
 * scheduler knows about it.
 *
 * What this module WAS, and no longer is (convergence S5): the rewrite's own run
 * lifecycle — a level-triggered cadence tick, a device claim long-poll,
 * attestation-renewed leases, a scheduler-owned reclaim, and a finish endpoint
 * that minted report docs. All of it retired with the kernel loop kind; the
 * production poll/lease/sweep/report pipeline is the one run world, and it is
 * the richer mechanism (progress heartbeat, artifact sync, transcript capture,
 * transient-failure resume).
 *
 * TWO DISCIPLINES SURVIVE VERBATIM and are the reason this seam still exists:
 *
 *  1. **DERIVED-ID IDEMPOTENCY.** `dueRunId` / `answeredRunId` / `directiveRunId`
 *     are pure functions of the trigger's identity (`ids.ts`), so one due
 *     instant, one verdict and one directive each queue exactly ONE run however
 *     many level-triggered passes see them. Those seeds are FROZEN.
 *  2. **A DERIVED ID MAY NEVER BE RE-MINTED, so a collision is NOTICED.** An id
 *     already held by another loop is two identities truncated onto one id, not
 *     a replay — it fails loudly and rolls back rather than reporting a
 *     stranger's run as this loop's fire.
 */
import { and, asc, eq, exists, isNotNull, lte } from "drizzle-orm";

import { db } from "../db/index.js";
import { objects } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import * as legacyStore from "../db/store.js";
import { loops, runs, type Loop, type Machine, type Run } from "../db/schema.js";
import { authenticateEnrolledMachine } from "../gateway/enroll.js";
import { logger } from "../logger.js";
import { appendOrganicEvent } from "./applyTransition.js";
import {
  ORGANIC_MINT_ATTEMPTS,
  answeredRunId,
  derivedEventId,
  directiveRunId,
  dueRunId,
  newRunId,
} from "./ids.js";
import type { RunReason } from "./types.js";

const log = logger.child({ mod: "run-queue" });

/** Boot wires the shipping gateway dispatcher here once. Trigger producers live
 * in kernel modules, but a prod row must wake the same parked machine poll as a
 * cron-created row. The pending row remains the durable queue if no dispatcher
 * is installed (unit tests / pre-boot calls). */
let productionDispatcher: ((loop: Loop, run: Run) => Promise<void> | void) | undefined;

export function setProductionRunDispatcher(dispatcher: (loop: Loop, run: Run) => Promise<void> | void): void {
  productionDispatcher = dispatcher;
}

export async function notifyProductionRunQueued(run: Run | undefined): Promise<void> {
  if (!run || !productionDispatcher) return;
  const loop = await legacyStore.getLoop(run.loopId);
  if (loop) await productionDispatcher(loop, run);
}

/** Shipping run-now, through the same mint seam as every kernel trigger. A
 * disabled loop is intentionally accepted: the button fires one row now and
 * never changes `enabled`, so its cadence remains off. */
export async function queueProductionManualRun(
  loop: Loop,
  now: Date = new Date(),
  actorId = loop.userId,
): Promise<Awaited<ReturnType<typeof queueKernelRun>>> {
  const stamp = now.toISOString();
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const queued = await queueKernelRun(tx, { loop, now: stamp, reason: "manual" });
    if (queued.outcome === "queued") {
      await appendOrganicEvent(tx, {
        teamId: queueLoopTeamId(loop),
        objectId: loop.id,
        kind: "run-queued",
        origin: "organic",
        entrance: "human",
        actorId,
        payload: { runId: queued.run!.id, reason: "manual" },
        ts: stamp,
      });
    }
    return queued;
  });
}

/** The shipping report pipeline's finalize hook. Only trigger runs carry kernel
 * provenance (`reason`/`scope`); ordinary cron/edit/evolve history stays
 * event-silent. The derived seed is the frozen run-finished seed verbatim. */
export async function appendProductionRunFinished(
  run: Run | undefined,
  outcome: "success" | "failure" | "skipped",
  stamp: string,
  summary?: string | null,
): Promise<void> {
  if (!run || (run.reason == null && run.scope == null)) return;
  try {
    const loop = await legacyStore.getLoop(run.loopId);
    if (!loop) return;
    await db.transaction(async (rawTx) => {
      await appendDerivedEvent(rawTx as unknown as store.KernelExec, {
        id: derivedEventId({ runId: run.id, kind: "run-finished", outcome }),
        teamId: queueLoopTeamId(loop),
        objectId: loop.id,
        kind: "run-finished",
        origin: "derived",
        entrance: "agent",
        actorId: run.id,
        payload: { outcome, reason: run.reason, scope: run.scope, summary: summary ?? null },
        ts: stamp,
      });
    });
  } catch (err) {
    // Audit/SSE is important but subordinate to the shipping run lifecycle: a
    // collision or transient kernel write failure must never wedge report lease
    // retirement (nor a sweep/supersede terminal transition).
    log.error(
      { runId: run.id, outcome, err: err instanceof Error ? err.message : String(err) },
      "production run-finished event append failed — run terminalization continues",
    );
  }
}

/** How often the due-task scan runs. */
export const RUN_TICK_MS = envPositive("LOOPANY_RUN_TICK_MS", 5_000);

/** How many due tasks ONE scan pass considers, oldest follow-up first. The
 *  window is bounded so a large workspace cannot turn one tick into an unbounded
 *  transaction storm; the trigger is level, so anything past it is picked up by
 *  a later pass — provided nothing INERT can squat a slot (see the scan's
 *  enablement predicate). */
export const DUE_SCAN_LIMIT = envPositive("LOOPANY_DUE_SCAN_LIMIT", 50);

function envPositive(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function queueLoopTeamId(loop: Loop): string {
  return loop.teamId ?? legacyStore.teamIdForUser(loop.userId);
}

export interface QueueInput {
  loop: Loop;
  now: string;
  reason: RunReason;
  scope?: string;
  scheduledFor?: string | null;
  /** Required for answered runs so a retried verdict derives the same row. */
  verdictEventId?: string;
  /** Required for DIRECTIVE runs, so a retried `task tell` derives the same row.
   *  It is also PERSISTED (`runs.trigger_event_id`), which is what lets the
   *  delivery carry the person's own words into the work order verbatim. */
  triggerEventId?: string;
  /** Required for DUE runs: the task and the follow-up instant that came due,
   *  which together with the loop are the run's identity (`dueRunId`). */
  due?: { taskId: string; followUpAt: string };
}

/** The ONE insertion seam for a trigger run. */
export async function queueKernelRun(tx: store.KernelExec, input: QueueInput) {
  const { loop, now, reason } = input;
  if (reason === "answered" && !input.verdictEventId) {
    throw new Error("answered runs require verdictEventId for deterministic identity");
  }
  if (reason === "directive" && !input.triggerEventId) {
    throw new Error("directive runs require triggerEventId for deterministic identity");
  }
  if (reason === "due" && !input.due) {
    throw new Error("due runs require the task and follow-up instant for deterministic identity");
  }
  const derivedId =
    reason === "answered" && input.verdictEventId
      ? answeredRunId(input.verdictEventId)
      : reason === "directive" && input.triggerEventId
        ? directiveRunId(input.triggerEventId)
        : reason === "due" && input.due
          ? dueRunId(loop.id, input.due.taskId, input.due.followUpAt)
          : undefined;
  const row = {
    loopId: loop.id,
    userId: loop.userId,
    machineId: loop.machineId,
    phase: "pending",
    role: "exec",
    ts: now,
    scope: input.scope ?? "routine",
    reason,
    // A DUE fire is the CLOCK's entrance, not a person's: nobody entered
    // anything at the moment it fired — a date that was set earlier simply
    // arrived, which is exactly what `clock` means for a cadence. A DIRECTIVE is
    // `human` alongside `manual`: somebody typed it.
    entrance: reason === "due" ? "clock" : reason === "answered" ? "answer" : "human",
    scheduledFor: input.scheduledFor ?? null,
    // The event whose words this run was queued to act on. Persisted rather than
    // only hashed into the id, so the delivery can read the note back and put
    // the person's instruction in the work order instead of making the agent hunt.
    triggerEventId: input.triggerEventId ?? input.verdictEventId ?? null,
    // A trigger born behind an executing sibling has not had a claimable moment
    // yet. The production poll/sweep stamps it after the sibling clears; aging
    // from creation is the sweep/claim race this field exists to prevent.
    claimableAt: (await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.loopId, loop.id), eq(runs.phase, "running")))
      .limit(1))[0]
      ? null
      : now,
  } as const;

  // Serialize every trigger for this loop on its authoritative row, then let
  // `queueRun` transactionally join an existing not-yet-executing run.
  await tx.select({ id: loops.id }).from(loops).where(eq(loops.id, loop.id)).for("update");

  if (derivedId) {
    const queued = await store.queueRun(tx, { ...row, id: derivedId });
    // A DERIVED run id may never be re-minted, so an id already held by ANOTHER
    // loop is not a replay to swallow — it is two identities truncated onto one
    // id. Swallowing it would drop this loop's fire and report the stranger's
    // run as ours. There is no repair inside the seam (the id is a pure function
    // of the seed), so the honest outcome is a loud failure that rolls the
    // transaction back and leaves the fire due for the next level-triggered pass.
    if (queued.outcome === "id-taken") {
      log.error(
        { runId: derivedId, loopId: loop.id, heldBy: queued.run?.loopId, reason },
        "derived run id collision — refusing to report another loop's run as this fire",
      );
      throw new Error(
        `derived run id ${derivedId} already belongs to ${queued.run?.loopId}, not ${loop.id} — refusing to queue`,
      );
    }
    return queued;
  }

  // A MANUAL fire is organic (a person pressing the button twice is two real
  // facts), so its short id carries no identity and a taken number — whether the
  // holder is this loop (`replay`) or another one (`id-taken`) — is a mistake
  // with a cheap fix: re-mint rather than hand the caller a stranger's run.
  // `loop-busy` is the queue discipline firing and is returned untouched.
  for (let attempt = 0; attempt < ORGANIC_MINT_ATTEMPTS; attempt++) {
    const queued = await store.queueRun(tx, { ...row, id: newRunId(attempt) });
    if (queued.outcome !== "replay" && queued.outcome !== "id-taken") return queued;
  }
  throw new Error(`could not mint a free run id after ${ORGANIC_MINT_ATTEMPTS} attempts`);
}

/**
 * Append a DERIVED event, refusing a truncation collision instead of swallowing
 * it.
 *
 * A swallowed insert here is normally the dedup invariant firing — the same fact
 * re-derived, which is the whole point of a derived id. It is NOT that when the
 * existing row hangs on a DIFFERENT object: the seed of every event below names
 * its object (or its run, which names one loop), so a foreign holder can only be
 * two seeds colliding on one truncated hash. Swallowing that would leave the
 * fact permanently absent from its own object's timeline while the caller
 * carried on as if it had been recorded — an audit-log hole nothing ever
 * surfaces. Runs' events are the fastest-growing, never-pruned pool of derived
 * ids in the system, so this is the pool where the collision math actually bites.
 */
export async function appendDerivedEvent(
  tx: store.KernelExec,
  row: Parameters<typeof store.appendEvent>[1],
): Promise<Awaited<ReturnType<typeof store.appendEvent>>> {
  const out = await store.appendEvent(tx, row);
  if (!out.inserted && out.event.objectId !== row.objectId) {
    log.error(
      { eventId: row.id, kind: row.kind, objectId: row.objectId, heldBy: out.event.objectId },
      "derived event id collision — refusing to drop the fact onto a stranger's timeline",
    );
    throw new Error(
      `derived event id ${row.id} already records a fact about ${out.event.objectId}, not ${row.objectId}`,
    );
  }
  return out;
}

export interface TickResult {
  scanned: number;
  queued: number;
  skipped: number;
  replayed: number;
  /** Fires the queue REFUSED (an identity collision, or any transaction error).
   *  Nothing is consumed, so the fire is still due on the next pass rather than
   *  silently lost. */
  failed: number;
}

/**
 * ONE LEVEL-TRIGGERED PASS OVER DUE TASKS — R-due (captain ruling 2026-08-04).
 *
 * A watched task whose `follow_up` has arrived WAKES ITS WATCHER. This is the
 * other half of the watcher rule: once every task names the loop that acts next,
 * a follow-up date stops being a note in a list and becomes a real alarm on a
 * named actor — so the scheduler treats it exactly like a cadence. Before this,
 * a due task waited for its watcher's next cron fire (or forever, on a loop with
 * no cron), and the compensating machinery was the inbox's `due-unwatched`
 * branch, which only ever saw the tasks nobody watched at all.
 *
 * The properties that make it safe to run every tick:
 *
 *  - **LEVEL-TRIGGERED, like the cadence tick.** Nothing is consumed and no
 *    cursor advances: a task is due until its `follow_up` moves or it closes. A
 *    tick that cannot queue (the loop is busy, the transaction failed) simply
 *    leaves it due for the next one.
 *  - **DERIVED-ID IDEMPOTENT per (loop, task, that follow-up instant)**
 *    (`dueRunId`). That is what makes the level trigger safe: the second tick
 *    re-derives the first tick's run id and the insert is swallowed as a replay,
 *    so one due instant queues exactly ONE run no matter how many passes see it.
 *    Re-arming `follow_up` is a new instant, hence a new run — which is how a
 *    loop asks to be woken again.
 *  - **SCOPED to the task** (`task:<id>`, the shape R-answer already uses), so
 *    the delivery hands the run the task that woke it.
 *  - **ENABLED production watchers only.** Pause governs the cadence, and a due
 *    task is not lost by it: the trigger is level, so the moment the loop is
 *    re-enabled, a still-due task fires on the next scan. A deleted watcher is
 *    a legal tombstone and is skipped without changing the task.
 *
 * A task with a question pending is deliberately NOT excluded: the question
 * blocks a CLOSE, not the loop's own work, and the run may well be able to make
 * progress while a human decides.
 */
export async function tickDueTasks(now: Date = new Date()): Promise<TickResult> {
  const nowIso = now.toISOString();
  const dueTasks = await db
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.kind, "task"),
        eq(objects.status, "open"),
        isNotNull(objects.followUpAt),
        lte(objects.followUpAt, nowIso),
        // The enablement gate is IN SQL, not only in the per-task transaction.
        // The scan is a bounded `follow_up asc` window, so a task whose watcher
        // can never act is not merely a wasted round trip — it OCCUPIES a slot
        // for as long as it stays due, and enough of them (a paused or deleted
        // watcher with a stale follow-up never moves) push every actionable due
        // task out of the window forever. Filtering here means an inert task can
        // never hold a slot; the in-transaction re-check below stays the
        // authority (the loop can be paused between this read and the write).
        exists(
          db
            .select({ id: loops.id })
            .from(loops)
            .where(and(eq(loops.id, objects.watcher), eq(loops.teamId, objects.teamId), eq(loops.enabled, true))),
        ),
      ),
    )
    .orderBy(asc(objects.followUpAt))
    .limit(DUE_SCAN_LIMIT);
  const result: TickResult = { scanned: 0, queued: 0, skipped: 0, replayed: 0, failed: 0 };

  for (const task of dueTasks) {
    const followUpAt = task.followUpAt!;
    try {
      const queuedResult = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as store.KernelExec;
        const loop = await resolveQueueLoopIn(tx, task.teamId, task.watcher!);
        if (!loop) {
          log.info({ taskId: task.id, watcher: task.watcher }, "due task skipped: watcher loop was deleted");
          return null;
        }
        // Due is the only trigger governed by enablement. A disabled production
        // watcher stands down; the level trigger fires after re-enable.
        if (!loop.enabled) return null;
        const queued = await queueKernelRun(tx, {
          loop, now: nowIso, reason: "due", scope: `task:${task.id}`,
          scheduledFor: followUpAt, due: { taskId: task.id, followUpAt },
        });
        if (queued.outcome === "queued") {
          await appendDerivedEvent(tx, {
            id: derivedEventId({ loopId: loop.id, taskId: task.id, kind: "run-queued", followUpAt }),
            teamId: queueLoopTeamId(loop),
            objectId: loop.id,
            kind: "run-queued",
            origin: "derived",
            entrance: "clock",
            actorId: loop.id,
            payload: { runId: queued.run!.id, reason: "due", scope: `task:${task.id}`, followUpAt },
            ts: nowIso,
          });
        }
        return { queued, loop };
      });
      if (!queuedResult) continue;
      result.scanned += 1;
      const { queued } = queuedResult;
      const outcome = queued.outcome;
      if (outcome === "queued") result.queued += 1;
      else if (outcome === "loop-busy") result.skipped += 1;
      else result.replayed += 1;
      if (outcome === "queued") await notifyProductionRunQueued(queued.run);
    } catch (err) {
      // One task's identity fault must not starve the rest, and nothing was
      // consumed, so it is still due next pass.
      log.error({ err: String(err), loopId: task.watcher, taskId: task.id, followUpAt }, "due task could not wake its watcher");
      result.failed += 1;
    }
  }
  return result;
}

/** Resolve a trigger target from THE production roster. */
export async function resolveQueueLoopIn(
  tx: store.KernelExec,
  teamId: string,
  loopId: string,
): Promise<Loop | undefined> {
  return (
    await tx.select().from(loops).where(and(eq(loops.id, loopId), eq(loops.teamId, teamId)))
  )[0];
}

/**
 * STRICT authentication: resolve an ALREADY-enrolled machine, never create one.
 * Every rewrite endpoint uses this — enrollment is a single named surface
 * (production `poll`, through the shared `gateway/enroll.ts` gate).
 */
export async function authenticateDevice(token: string): Promise<Machine | undefined> {
  const resolved = await authenticateEnrolledMachine(token);
  return resolved.ok ? resolved.machine : undefined;
}

/** THE KERNEL'S ONE REMAINING CLOCK. A loop's cadence belongs to the production
 * scheduler; a task's follow-up date is a kernel fact and nothing over there
 * knows about it, so the due scan gets its own always-on tick. */
export class DueTaskScheduler {
  private timer?: NodeJS.Timeout;

  async start(signal: AbortSignal): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), RUN_TICK_MS);
    this.timer.unref?.();
    signal.addEventListener("abort", () => this.stop(), { once: true });
  }

  private async tick(): Promise<void> {
    try {
      await tickDueTasks();
    } catch (err) {
      log.error({ err: String(err) }, "due task tick failed");
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
