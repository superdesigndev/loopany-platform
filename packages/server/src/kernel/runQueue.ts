/** Rewrite unit 3: level-triggered clock, run queue, device claim and finish. */
// Source import keeps a fresh checkout typecheckable before the workspace codec
// has been built to dist; the package remains the dependency/runtime owner.
import { safeParseArtifact } from "../../../artifact-format/src/index.js";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { db } from "../db/index.js";
import { objects, type KernelObject } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import * as legacyStore from "../db/store.js";
import { loops, runs, type Loop, type Machine, type Run } from "../db/schema.js";
import { machineIdFromToken, isDeviceTokenShape, sha256 } from "../gateway/tokens.js";
import { enrollMachine, stampMachineContact, type MachineInfo } from "../gateway/enroll.js";
import { clipText, type HttpResult } from "../gateway/http.js";
import { logger } from "../logger.js";
import { appendOrganicEvent, applyTransitionIn, createObjectIn } from "./applyTransition.js";
import {
  ORGANIC_MINT_ATTEMPTS,
  answeredRunId,
  autoPauseTaskId,
  clockRunId,
  derivedEventId,
  directiveRunId,
  dueRunId,
  newRunId,
  reportDocId,
} from "./ids.js";
import { nextOccurrenceAfter } from "./schedule.js";
import { REFUSAL_STATUS, refusal, type RefusalCode } from "./refusals.js";
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
  if (!run || run.queueState !== null || !productionDispatcher) return;
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

/** The shipping report pipeline's S2 finalize hook. Only trigger runs carry
 * kernel provenance (`reason`/`scope`); ordinary cron/edit/evolve history stays
 * event-silent. The derived seed is the frozen v2 run-finished seed verbatim. */
export async function appendProductionRunFinished(
  run: Run | undefined,
  outcome: "success" | "failure",
  stamp: string,
  summary?: string | null,
): Promise<void> {
  if (!run || (run.reason == null && run.scope == null)) return;
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
}

export const RUN_LEASE_MS = envPositive("LOOPANY_RUN_LEASE_MS", 20 * 60_000);
export const CLAIM_HOLD_MS = envPositive("LOOPANY_CLAIM_HOLD_MS", 20_000);
export const RUN_MAX_ATTEMPTS = envPositive("LOOPANY_RUN_MAX_ATTEMPTS", 3);
export const TERMINAL_GRACE_MS = envPositive("LOOPANY_TERMINAL_GRACE_MS", 24 * 60 * 60_000);
export const FAILURE_AUTOPAUSE_STREAK = envNonNegative("LOOPANY_FAILURE_AUTOPAUSE_STREAK", 10);
export const RUN_TICK_MS = envPositive("LOOPANY_RUN_TICK_MS", 5_000);

/** Server-side mirror of the daemon cutover flag. Lazy for tests and boot
 * orchestration: flag off means no arming, tick, claim-state interference. */
export function runsV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOPANY_RUNS_V2 === "1";
}

function envPositive(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envNonNegative(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export type QueueLoop = KernelObject | Loop;

export function queueLoopTeamId(loop: QueueLoop): string {
  if (loop.teamId) return loop.teamId;
  if (!("kind" in loop)) return legacyStore.teamIdForUser(loop.userId);
  throw new Error(`kernel loop ${loop.id} has no team and cannot emit trigger events`);
}

export interface QueueInput {
  loop: QueueLoop;
  now: string;
  reason: RunReason;
  scope?: string;
  scheduledFor?: string | null;
  /** Required for answered runs so a retried verdict derives the same row. */
  verdictEventId?: string;
  /** Required for DIRECTIVE runs, so a retried `task tell` derives the same row.
   *  It is also PERSISTED (`runs.trigger_event_id`), which is what lets the claim
   *  carry the person's own words into the work order verbatim. */
  triggerEventId?: string;
  /** Required for DUE runs: the task and the follow-up instant that came due,
   *  which together with the loop are the run's identity (`dueRunId`). */
  due?: { taskId: string; followUpAt: string };
}

/** Callable insertion seam for unit 4's R-answer transaction. */
export async function queueKernelRun(tx: store.KernelExec, input: QueueInput) {
  const { loop, now, reason } = input;
  const kernelLoop = "kind" in loop;
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
    reason === "clock" && input.scheduledFor
      ? clockRunId(loop.id, input.scheduledFor)
      : reason === "answered" && input.verdictEventId
        ? answeredRunId(input.verdictEventId)
        : reason === "directive" && input.triggerEventId
          ? directiveRunId(input.triggerEventId)
          : reason === "due" && input.due
            ? dueRunId(loop.id, input.due.taskId, input.due.followUpAt)
            : undefined;
  const row = {
    loopId: loop.id,
    // Convergence S2 fixes the old kernel team-as-user shim and makes a prod
    // watcher's row immediately claimable by the shipping poll path. Kernel
    // watchers stay on their queue lifecycle until S3.
    userId: kernelLoop ? loop.teamId : loop.userId,
    machineId: kernelLoop ? "" : loop.machineId,
    phase: "pending",
    role: "exec",
    ts: now,
    queueState: kernelLoop ? "queued" : null,
    scope: input.scope ?? "routine",
    reason,
    // A DUE fire is the CLOCK's entrance, not a person's: nobody entered
    // anything at the moment it fired — a date that was set earlier simply
    // arrived, which is exactly what `clock` means for a cadence. A DIRECTIVE is
    // `human` alongside `manual`: somebody typed it.
    entrance: reason === "clock" || reason === "due" ? "clock" : reason === "answered" ? "answer" : "human",
    scheduledFor: input.scheduledFor ?? null,
    // The event whose words this run was queued to act on. Persisted rather than
    // only hashed into the id, so `claimRun` can read the note back and put the
    // person's instruction in the work order instead of making the agent hunt.
    triggerEventId: input.triggerEventId ?? input.verdictEventId ?? null,
  } as const;

  // The unique one-queued index retired in S2. Serialize every trigger for this
  // loop on its authoritative row, then let `queueRun` transactionally join an
  // existing open run. Kernel wins an id collision during the dual-read stage.
  if (kernelLoop) {
    await store.getObjectForUpdate(tx, loop.id);
  } else {
    await tx.select({ id: loops.id }).from(loops).where(eq(loops.id, loop.id)).for("update");
  }

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
   *  The loop's cursor is deliberately left un-advanced, so the fire is still
   *  due on the next pass rather than silently lost. */
  failed: number;
}

/** One level-triggered pass. Fire and cursor deliberately commit separately. */
export async function tickRunClock(now: Date = new Date()): Promise<TickResult> {
  const nowIso = now.toISOString();
  const due = await db
    .select()
    .from(objects)
    .where(and(eq(objects.kind, "loop"), eq(objects.status, "active"), lte(objects.nextFire, nowIso)))
    .orderBy(asc(objects.nextFire))
    .limit(25);
  const result: TickResult = { scanned: due.length, queued: 0, skipped: 0, replayed: 0, failed: 0 };

  for (const loop of due) {
    const scheduledFor = loop.nextFire!;
    const attempt = await queueOneFire(loop, scheduledFor, nowIso);
    if (!attempt.ok) {
      // One loop's identity fault must not starve the others, and its fire must
      // not be silently consumed: the cursor advance below is SKIPPED, so the
      // loop stays due and every pass re-raises the error until a human acts.
      log.error({ err: attempt.err, loopId: loop.id, scheduledFor }, "run clock could not queue a due fire");
      result.failed += 1;
      continue;
    }
    const outcome = attempt.outcome;

    // Separate transaction: commit fire first so a crash can replay, never lose it.
    await db.transaction(async (rawTx) => {
      await store.updateObjectFields(rawTx as unknown as store.KernelExec, loop.id, {
        nextFire: nextOccurrenceAfter(loop.cron!, loop.timezone, now),
        updatedAt: nowIso,
      });
    });
    if (outcome === "queued") result.queued += 1;
    else if (outcome === "loop-busy") result.skipped += 1;
    else result.replayed += 1;
  }
  if (result.queued) wakeClaims();
  return result;
}

/** One due loop's queue transaction, with its refusal captured rather than
 *  thrown — see `TickResult.failed`. */
async function queueOneFire(
  loop: KernelObject,
  scheduledFor: string,
  nowIso: string,
): Promise<{ ok: true; outcome: store.QueueRunOutcome } | { ok: false; err: string }> {
  try {
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as store.KernelExec;
      const queued = await queueKernelRun(tx, { loop, now: nowIso, reason: "clock", scheduledFor });
      if (queued.outcome === "queued") {
        await appendDerivedEvent(tx, {
          id: derivedEventId({ loopId: loop.id, kind: "run-queued", scheduledFor }),
          teamId: loop.teamId,
          objectId: loop.id,
          kind: "run-queued",
          origin: "derived",
          entrance: "clock",
          actorId: loop.id,
          payload: { runId: queued.run!.id, reason: "clock", scheduledFor },
          ts: nowIso,
        });
      } else if (queued.outcome === "loop-busy") {
        await appendDerivedEvent(tx, {
          id: derivedEventId({ loopId: loop.id, kind: "clock-skipped", scheduledFor }),
          teamId: loop.teamId,
          objectId: loop.id,
          kind: "clock-skipped",
          origin: "derived",
          entrance: "clock",
          actorId: loop.id,
          payload: { queuedRunId: queued.run?.id ?? null, scheduledFor },
          ts: nowIso,
        });
      }
      return queued.outcome;
    });
    return { ok: true, outcome };
  } catch (err) {
    return { ok: false, err: String(err) };
  }
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
 *    the claim hands the run the task that woke it.
 *  - **ACTIVE watchers only**, the same selection `tickRunClock` makes. Pause
 *    governs the clock (that is the whole of what pause means here), and a due
 *    task is not lost by it: the trigger is level, so the moment the loop
 *    resumes, a still-due task fires on the next tick. RETIRED is excluded by
 *    the same predicate and is the case that really does strand work — which is
 *    why retiring a loop that still watches open tasks WARNS (`loopLifecycle`).
 *
 * A task with a question pending is deliberately NOT excluded: the question
 * blocks a CLOSE, not the loop's own work, and the run may well be able to make
 * progress while a human decides.
 *
 * CONVERGENCE STAGING. Since S1 a `watcher` may name a PRODUCTION `loops` row,
 * and this join does not see one — so a prod-watched task's follow-up queues
 * NOTHING today. That is the stage boundary, not an oversight: S1 repoints loop
 * REFERENCES (`kernel/loopRefs.ts` resolves both worlds for every read), and S2
 * repoints the TRIGGER paths, where a prod watcher queues an ordinary prod
 * pending run on the loop's bound machine (`enabled = true` watchers only) while
 * a kernel-loop watcher keeps this queue. Pulling that dispatch forward here
 * would land half a run world.
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
      ),
    )
    .orderBy(asc(objects.followUpAt))
    .limit(50);
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
        // Due is the only trigger governed by enablement. Kernel pause and prod
        // disable both stand down; the level trigger fires after re-enable.
        if (("kind" in loop && loop.status !== "active") || (!("kind" in loop) && !loop.enabled)) return null;
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
      const { queued, loop } = queuedResult;
      const outcome = queued.outcome;
      if (outcome === "queued") result.queued += 1;
      else if (outcome === "loop-busy") result.skipped += 1;
      else result.replayed += 1;
      if (outcome === "queued" && !("kind" in loop)) await notifyProductionRunQueued(queued.run);
    } catch (err) {
      // Same isolation as the cadence tick: one task's identity fault must not
      // starve the rest, and nothing was consumed, so it is still due next pass.
      log.error({ err: String(err), loopId: task.watcher, taskId: task.id, followUpAt }, "due task could not wake its watcher");
      result.failed += 1;
    }
  }
  if (result.queued) wakeClaims();
  return result;
}

/** Resolve a trigger target kernel-first, matching `loopRefs.ts`'s S1 collision
 * rule. The caller is already in the mutation transaction; queueKernelRun takes
 * the authoritative row lock before the open-run lookup. */
export async function resolveQueueLoopIn(
  tx: store.KernelExec,
  teamId: string,
  loopId: string,
): Promise<QueueLoop | undefined> {
  const kernel = (
    await tx.select().from(objects).where(and(eq(objects.id, loopId), eq(objects.teamId, teamId), eq(objects.kind, "loop")))
  )[0];
  if (kernel) return kernel;
  return (
    await tx.select().from(loops).where(and(eq(loops.id, loopId), eq(loops.teamId, teamId)))
  )[0];
}

/** Cutover repair for migrated active loops plus the create/resume arming seam. */
export async function armUnarmedLoops(now: Date = new Date()): Promise<number> {
  const rows = await db
    .select()
    .from(objects)
    .where(and(eq(objects.kind, "loop"), eq(objects.status, "active"), isNull(objects.nextFire)));
  let armed = 0;
  for (const loop of rows) {
    if (!loop.cron) continue;
    await store.updateObjectFields(undefined, loop.id, {
      nextFire: nextOccurrenceAfter(loop.cron, loop.timezone, now),
      updatedAt: now.toISOString(),
    });
    armed += 1;
  }
  return armed;
}

/**
 * STRICT authentication: resolve an ALREADY-enrolled machine, never create one.
 * Every rewrite endpoint except the claim long-poll uses this — enrollment is a
 * single named surface (`enrollDeviceForClaim`), exactly as it is on the legacy
 * line where `poll` is the only self-register route.
 */
export async function authenticateDevice(token: string): Promise<Machine | undefined> {
  if (!isDeviceTokenShape(token)) return undefined;
  const machine = await legacyStore.getMachine(machineIdFromToken(token));
  if (!machine || machine.tokenHash !== sha256(token)) return undefined;
  return machine;
}

/**
 * THE rewrite line's enrollment surface, and the mirror of legacy `poll`.
 *
 * A daemon running `LOOPANY_RUNS_V2=1` never calls `/api/machine/poll`, so
 * without this a brand-new machine had no way onto the rewrite line at all: the
 * claim 401'd forever and the machine never appeared online in the UI. It
 * delegates to the SHARED `gateway/enroll.ts` gate, so the open-mode/gated
 * policy and the token-hash re-verify cannot drift between the two transports.
 */
export async function enrollDeviceForClaim(token: string, info?: MachineInfo): Promise<Machine | undefined> {
  const resolved = await enrollMachine(token, info);
  if (!resolved.ok) return undefined;
  // The claim IS this machine's heartbeat on the v2 path — nothing else stamps
  // presence there, so the UI would show every v2 machine as permanently
  // offline without it.
  await stampMachineContact(resolved.machine, info);
  return resolved.machine;
}

export interface ClaimBody {
  machine?: string;
  agent?: string;
  wait?: boolean;
  /**
   * The run ids this daemon is STILL EXECUTING — its attestation, and the only
   * thing that renews a lease (see `renewMachineLeasesIn`). Absent or empty
   * attests to nothing.
   */
  inFlight?: string[];
  /** Machine identity, same shape the legacy poll reports. */
  host?: string;
  platform?: string;
  arch?: string;
  version?: string;
}

/** How many run ids one claim may attest to. A machine runs a handful at a
 * time; the cap keeps a hostile body from turning the renew into a huge IN. */
const ATTESTATION_CAP = 64;

/** The identity fields a claim body carries, in `enrollMachine`'s shape. */
export function claimMachineInfo(body: ClaimBody): MachineInfo {
  return { host: body.host, platform: body.platform, arch: body.arch, version: body.version };
}

/** Wire-shaped attestation → a bounded, deduped id set. Anything else is nothing. */
export function attestedRunIds(body: ClaimBody): string[] {
  if (!Array.isArray(body.inFlight)) return [];
  const ids = new Set<string>();
  for (const id of body.inFlight) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
    if (ids.size >= ATTESTATION_CAP) break;
  }
  return [...ids];
}

export async function claimRun(machine: Machine, body: ClaimBody, now = new Date()): Promise<HttpResult> {
  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  if (!agent) return problem(400, "INVALID_BODY", "agent is required");
  if (body.machine && body.machine !== machine.id) return problem(400, "INVALID_BODY", "machine does not match the device credential");

  const attested = attestedRunIds(body);
  let claimed = await claimOnce(machine, agent, now, attested);
  let waitedMs = 0;
  if (!claimed && body.wait) {
    const began = Date.now();
    await waitForClaim(CLAIM_HOLD_MS);
    waitedMs = Date.now() - began;
    claimed = await claimOnce(machine, agent, new Date(), attested);
  }
  if (!claimed) return { status: 200, body: { run: null, waitedMs } };
  const { run, loop } = claimed;
  const taskId = run.scope?.startsWith("task:") ? run.scope.slice(5) : undefined;
  const task = taskId ? await store.getObject(undefined, taskId) : undefined;
  // THE HUMAN'S OWN WORDS, read back through the event that queued this run.
  // A run woken by a person must be told WHAT they said, not merely that
  // something changed — otherwise its first act is a hunt through a timeline it
  // has to guess the shape of.
  const trigger = run.triggerEventId ? await store.getEvent(undefined, run.triggerEventId) : undefined;
  const spoken = trigger?.note?.trim() || null;
  // A scoped run says WHY it is scoped, because the reasons ask for different
  // work: an answer is a reply to something this loop asked, a directive is an
  // instruction it did not ask for, and a due date is the loop's own earlier
  // request to look again.
  const scopeNote = !taskId
    ? null
    : run.reason === "due"
      ? `A task you watch has reached its follow-up date and is waiting for you: ${taskId}.`
      : run.reason === "directive"
        ? `A human left you a DIRECTIVE on ${taskId}. Execute the INTENT against reality first — external systems, then this kernel's records — and report what you actually changed.`
        : `One task was answered by a human and is waiting for you: ${taskId}.`;
  return {
    status: 200,
    body: {
      run: {
        id: run.id,
        loopId: loop.id,
        loopTitle: loop.title,
        scope: run.scope,
        reason: run.reason,
        entrance: run.entrance,
        attempts: run.attempts,
        scheduledFor: run.scheduledFor,
      },
      charter: loop.body ?? "",
      identityLine: `You are running for ${loop.id}${loop.title ? ` (\"${loop.title}\")` : ""}.`,
      scopeNote,
      // VERBATIM, and separated by which conversation it belongs to, so the
      // agent never has to infer whether it is reading a reply or an order.
      ...(spoken && run.reason === "directive" ? { directive: spoken } : {}),
      ...(spoken && run.reason === "answered" ? { answer: spoken } : {}),
      ...(task ? { task } : {}),
      execution: executionConfig(loop),
      roots: machine.roots ?? undefined,
      leaseExpiresAt: run.leaseExpiresAt,
      leaseMs: RUN_LEASE_MS,
    },
  };
}

async function claimOnce(
  machine: Machine,
  agent: string,
  now: Date,
  attested: string[] = [],
): Promise<{ run: Run; loop: KernelObject } | undefined> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    // The daemon's ATTESTATION is the liveness signal — the run ids it says it
    // is still executing. Renew before the expiry sweep so healthy
    // unlimited-duration agent runs cannot be reclaimed.
    await renewMachineLeasesIn(tx, machine.id, now, attested);
    await reclaimExpiredIn(tx, now);
    const rows = await rawTx
      .select({ run: runs, loop: objects })
      .from(runs)
      .innerJoin(objects, eq(objects.id, runs.loopId))
      .where(
        and(
          eq(runs.queueState, "queued"),
          eq(objects.kind, "loop"),
          // A PAUSED loop's queued run is claimable (captain ruling 2026-08-04).
          // Pause governs the cadence — `tickRunClock` selects `active` only, so
          // a paused loop still never fires on its own — but a run a human
          // queued by hand through `run-now` is an explicit act, and leaving it
          // unclaimable would make it a row that waits forever. Retired stays
          // excluded: it is terminal.
          inArray(objects.status, ["active", "paused"]),
          eq(objects.teamId, machine.teamId ?? `team-${machine.userId}`),
        ),
      )
      .orderBy(asc(runs.ts))
      .limit(1)
      .for("update", { skipLocked: true });
    const picked = rows[0];
    if (!picked) return undefined;
    const stamp = now.toISOString();
    const claimed = (
      await rawTx
        .update(runs)
        .set({
          queueState: "claimed",
          phase: "running",
          claimedBy: clipText(agent, 200),
          claimedAt: stamp,
          machineId: machine.id,
          leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS).toISOString(),
          leaseState: "active",
          attempts: picked.run.attempts + 1,
          startedAt: picked.run.startedAt ?? stamp,
        })
        .where(and(eq(runs.id, picked.run.id), eq(runs.queueState, "queued")))
        .returning()
    )[0];
    if (!claimed) return undefined;
    await appendDerivedEvent(tx, {
      id: derivedEventId({ runId: claimed.id, kind: "run-claimed", attempts: claimed.attempts }),
      teamId: picked.loop.teamId,
      objectId: picked.loop.id,
      kind: "run-claimed",
      origin: "derived",
      entrance: "agent",
      actorId: claimed.id,
      payload: { attempts: claimed.attempts, machineId: machine.id },
      ts: stamp,
    });
    return { run: claimed, loop: picked.loop };
  });
}

/**
 * Renew ONLY the leases the polling daemon ATTESTED to (review F1).
 *
 * The liveness question a lease answers is "is this RUN still being executed?",
 * not "is this machine still up" — the legacy line keys its sweep on per-run
 * progress freshness for exactly that reason. Renewing every lease of a live
 * machine substitutes machine liveness for run liveness, and a daemon that
 * crashes or restarts mid-run defeats the substitution: it comes back with an
 * empty in-flight set, never reports the run it lost, and its own polls keep
 * that orphan's lease alive forever. So an unattested lease is deliberately
 * left to expire — `reclaimExpiredIn` (here) and the scheduler's reclaim tick
 * then re-queue it for whichever machine polls next.
 *
 * A daemon too old to attest therefore renews nothing and has its runs
 * reclaimed after the lease. That is the cure, not a regression: the lease is
 * 20 minutes, reclaim re-queues rather than fails, and the alternative is the
 * orphan living forever.
 */
async function renewMachineLeasesIn(tx: store.KernelExec, machineId: string, now: Date, attested: string[]): Promise<number> {
  if (!attested.length) return 0;
  const rows = await tx
    .update(runs)
    .set({ leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS).toISOString() })
    .where(
      and(
        eq(runs.queueState, "claimed"),
        eq(runs.leaseState, "active"),
        eq(runs.machineId, machineId),
        // Scoped to the claimant: attesting to a stranger's run renews nothing.
        inArray(runs.id, attested),
        gt(runs.leaseExpiresAt, now.toISOString()),
      ),
    )
    .returning({ id: runs.id });
  return rows.length;
}

/** Lease-expiry reclaim tick; exported for deterministic tests and maintenance. */
export async function reclaimExpired(now: Date = new Date()): Promise<number> {
  const count = await db.transaction((tx) => reclaimExpiredIn(tx as unknown as store.KernelExec, now));
  if (count) wakeClaims();
  return count;
}

async function reclaimExpiredIn(tx: store.KernelExec, now: Date): Promise<number> {
  const expired = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.queueState, "claimed"), lte(runs.leaseExpiresAt, now.toISOString())))
    .for("update");
  let changed = 0;
  for (const run of expired) {
    const nextAttempts = run.attempts + 1;
    const sibling = await store.queuedRunForLoop(tx, run.loopId);
    if (nextAttempts > RUN_MAX_ATTEMPTS || sibling) {
      await finishExpiredAsFailure(tx, run, now, nextAttempts);
    } else {
      await tx
        .update(runs)
        .set({
          queueState: "queued",
          phase: "pending",
          claimedBy: null,
          claimedAt: null,
          // Retain the former machine as audit context. The run is queued again,
          // so the old claimant has lost authority and finish returns LEASE_LOST.
          leaseState: "terminal-grace",
          leaseExpiresAt: new Date(now.getTime() + TERMINAL_GRACE_MS).toISOString(),
          attempts: nextAttempts,
        })
        .where(eq(runs.id, run.id));
    }
    changed += 1;
  }
  return changed;
}

async function finishExpiredAsFailure(tx: store.KernelExec, run: Run, now: Date, attempts: number): Promise<void> {
  const loop = await store.getObject(tx, run.loopId);
  if (!loop) return;
  const stamp = now.toISOString();
  await tx
    .update(runs)
    .set({
      queueState: "failure",
      phase: "error",
      finishedAt: stamp,
      error: "lease expired repeatedly",
      attempts,
      leaseState: null,
      leaseExpiresAt: null,
    })
    .where(eq(runs.id, run.id));
  await appendDerivedEvent(tx, {
    id: derivedEventId({ runId: run.id, kind: "run-finished", outcome: "failure" }),
    teamId: loop.teamId,
    objectId: loop.id,
    kind: "run-finished",
    origin: "derived",
    entrance: "agent",
    actorId: run.id,
    payload: { outcome: "failure", reason: "lease expired repeatedly", attempts },
    ts: stamp,
  });
  await maybeAutoPause(tx, loop, run.id, now);
}

export interface FinishBody {
  outcome?: "success" | "failure";
  summary?: string;
  report?: { title?: string; body?: string };
  cost?: Record<string, unknown>;
  exitCode?: number;
  durationMs?: number;
}

export async function finishRun(machine: Machine, contextRunId: string, pathRunId: string, body: FinishBody, now = new Date()): Promise<HttpResult> {
  if (contextRunId !== pathRunId) return problem(403, "NOT_YOUR_RUN", "the path run differs from the run context");
  if (body.outcome !== "success" && body.outcome !== "failure") {
    return problem(400, "INVALID_BODY", "outcome must be success or failure");
  }
  const parsedReport = parseReport(body.report, pathRunId, now);
  if (!parsedReport.ok) return parsedReport.result;

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const run = await store.getRunRow(tx, pathRunId);
    if (!run || run.machineId !== machine.id) return problem(403, "RUN_CONTEXT_UNKNOWN", "run context is unknown on this machine");
    const active = run.queueState === "claimed" && run.leaseState === "active" && Date.parse(run.leaseExpiresAt ?? "") > now.getTime();
    if (!active) return problem(409, "LEASE_LOST", "the run no longer holds its lease");
    const loop = await store.getObjectForUpdate(tx, run.loopId);
    if (!loop || loop.kind !== "loop") return problem(404, "NOT_FOUND", "loop not found");
    const stamp = now.toISOString();

    let report: { id: string; created: boolean } | undefined;
    if (parsedReport.value) {
      const doc = parsedReport.value;
      const created = await createObjectIn(tx, {
        id: reportDocId(run.id),
        teamId: loop.teamId,
        kind: "doc",
        actor: { entrance: "agent", actorId: run.id },
        now: stamp,
        title: doc.title ?? `${loop.title ?? loop.id} — ${stamp.slice(0, 10)}`,
        body: doc.body,
        format: doc.format,
        payload: doc.payload,
        createdByRun: run.id,
        createdByLoop: loop.id,
      });
      // A report doc's id is DERIVED from the run, so a refusal here can be the
      // identity guard firing (`ID_COLLISION`, 409) as well as an ordinary
      // content refusal. Surface the code's own status so the agent sees a
      // conflict it must escalate, not a 400 it will try to rewrite its way out of.
      if (!created.ok) return problem(REFUSAL_STATUS[created.code as RefusalCode] ?? 400, created.code, created.message);
      report = { id: created.object.id, created: created.created };
    }

    const finishedEvent = await appendDerivedEvent(tx, {
      id: derivedEventId({ runId: run.id, kind: "run-finished", outcome: body.outcome }),
      teamId: loop.teamId,
      objectId: loop.id,
      kind: "run-finished",
      origin: "derived",
      entrance: "agent",
      actorId: run.id,
      payload: {
        outcome: body.outcome,
        summary: cleanString(body.summary, 8_000),
        cost: cleanCost(body.cost),
        exitCode: finiteNumber(body.exitCode),
        durationMs: finiteNumber(body.durationMs),
      },
      ts: stamp,
    });

    const updated = (
      await rawTx
        .update(runs)
        .set({
          queueState: body.outcome,
          phase: body.outcome === "success" ? "done" : "error",
          outcome: body.outcome === "success" ? "exec" : "error",
          outcomeSummary: cleanString(body.summary, 8_000),
          message: cleanString(body.summary, 2_000),
          runCost: cleanCost(body.cost),
          costUsd: typeof body.cost?.usd === "number" && Number.isFinite(body.cost.usd) ? body.cost.usd : null,
          durationMs: finiteNumber(body.durationMs) ?? null,
          finishedAt: stamp,
          reportDocId: report?.id ?? null,
          leaseState: null,
          leaseExpiresAt: null,
        })
        .where(eq(runs.id, run.id))
        .returning()
    )[0]!;

    const autoPaused = body.outcome === "failure" ? await maybeAutoPause(tx, loop, run.id, now) : undefined;
    return {
      status: 200,
      body: {
        run: {
          id: updated.id,
          state: updated.queueState,
          loopId: updated.loopId,
          startedAt: updated.startedAt,
          finishedAt: updated.finishedAt,
          attempts: updated.attempts,
        },
        ...(report ? { report } : {}),
        replay: !finishedEvent.inserted,
        event: finishedEvent.event.id,
        ...(autoPaused ? { autoPaused } : {}),
      },
    };
  });
}

async function maybeAutoPause(tx: store.KernelExec, loop: KernelObject, runId: string, now: Date) {
  if (!FAILURE_AUTOPAUSE_STREAK || loop.status !== "active") return undefined;
  const history = await tx
    .select()
    .from(runs)
    // In-flight/queued rows are not outcomes and cannot reset a persisted
    // consecutive-failure streak. clock-skipped has no row at all.
    .where(and(eq(runs.loopId, loop.id), inArray(runs.queueState, ["success", "failure"])))
    .orderBy(desc(runs.finishedAt), desc(runs.ts));
  let streak = 0;
  for (const row of history) {
    if (row.queueState !== "failure") break;
    streak += 1;
  }
  if (streak < FAILURE_AUTOPAUSE_STREAK) return undefined;
  const stamp = now.toISOString();
  const paused = await applyTransitionIn(tx, {
    objectId: loop.id,
    transition: "auto-pause",
    actor: { entrance: "agent", actorId: runId },
    now: stamp,
    derivedFrom: { runId, streak },
    eventPayload: { streak, lastFailure: runId },
  });
  // An ordinary refusal here (the loop moved under us) simply means no pause to
  // report. An `ID_COLLISION` is the identity guard, and swallowing it would
  // reproduce exactly the failure it exists to catch: the circuit breaker
  // reporting success while the loop keeps firing. It rides out of the
  // transaction instead, rolling back with it.
  if (!paused.ok) {
    if (paused.code === "ID_COLLISION") throw new Error(`auto-pause refused: ${paused.message}`);
    return undefined;
  }
  const question = autoPauseTaskId(loop.id, runId);
  const task = await createObjectIn(tx, {
    id: question,
    teamId: loop.teamId,
    kind: "task",
    actor: { entrance: "agent", actorId: runId },
    now: stamp,
    title: `${loop.title ?? loop.id} paused after repeated failures`,
    pendingQuestion: `Loop ${loop.title ?? loop.id} (${loop.id}) failed ${streak} consecutive runs, most recently ${runId}. Fix the cause and resume it?`,
    // The auto-pause question is WATCHED BY THE LOOP IT IS ABOUT, per the
    // watcher rule's default (a loop-created task falls back to its creator).
    // It also happens to be the right answer on the merits: the question is
    // "fix the cause and resume it?", so a human's answer should reach the loop
    // it is about. Queueing that R-answer run on a paused loop is deliberate —
    // a paused loop's queued run IS claimable (pause governs the cadence, not an
    // explicit act), and answering this question is as explicit as it gets.
    watcher: loop.id,
    createdByRun: runId,
    createdByLoop: loop.id,
  });
  if (!task.ok) {
    if (task.code === "ID_COLLISION") throw new Error(`auto-pause question refused: ${task.message}`);
    return undefined;
  }
  return { loop: loop.id, streak, question: task.object.id };
}

type ParsedReport =
  | { ok: true; value?: { title?: string; body: string; format: "markdown" | "html"; payload?: Record<string, unknown> } }
  | { ok: false; result: HttpResult };

function parseReport(report: FinishBody["report"], runId: string, now: Date): ParsedReport {
  if (!report) return { ok: true };
  if (typeof report.body !== "string") return { ok: false, result: problem(400, "INVALID_BODY", "report.body must be a string") };
  const parsed = safeParseArtifact(report.body);
  if (!parsed.ok) {
    // Finish is a terminal ingestion seam, not an authored-doc editing API.
    // Any malformed/unsupported head is ordinary Markdown content here; strict
    // codec teaching belongs to unit-4 doc verbs where a caller can rewrite it.
    return plainReport(report);
  }
  const head = parsed.value.frontMatter;
  const unknown = Object.keys(head).find((key) => !["title", "key", "format", "payload"].includes(key));
  if (unknown) return plainReport(report);
  if (head.title !== undefined && typeof head.title !== "string") {
    return plainReport(report);
  }
  if (head.payload !== undefined && (!head.payload || typeof head.payload !== "object" || Array.isArray(head.payload))) {
    return plainReport(report);
  }
  if (head.format !== undefined && typeof head.format !== "string") {
    return plainReport(report);
  }
  return {
    ok: true,
    value: {
      title: (head.title as string | undefined) ?? cleanString(report.title, 2_000) ?? `Run ${runId} — ${now.toISOString().slice(0, 10)}`,
      body: parsed.value.body,
      format: head.format ?? "markdown",
      payload: head.payload as Record<string, unknown> | undefined,
    },
  };
}

function plainReport(report: { title?: string; body?: string }): ParsedReport {
  return {
    ok: true,
    value: { title: cleanString(report.title, 2_000), body: report.body ?? "", format: "markdown" },
  };
}

function cleanCost(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The work order's execution envelope. `workdir` is the loop's OWN bound column
 * (captain ruling 2026-08-04) — the free-zone payload no longer answers WHERE a
 * run executes, so a charter cannot quietly relocate itself past the governance
 * gate in `governLoop`. Everything else still reads the payload free zone.
 */
function executionConfig(loop: KernelObject): Record<string, unknown> {
  const p = loop.payload ?? {};
  const agent = p.agent === "codex" || p.agent === "grok" || p.agent === "claude-code" ? p.agent : "claude-code";
  return {
    agent,
    workdir: loop.workdir,
    /** The claiming machine must not silently invent a bound directory. */
    requireWorkdir: loop.workdir != null,
    taskFile: typeof p.taskFile === "string" ? p.taskFile : null,
    workflow: typeof p.workflow === "string" ? p.workflow : null,
    model: typeof p.model === "string" ? p.model : null,
    allowControl: p.allowControl === true,
    prevState: p.state ?? null,
  };
}

function cleanString(value: unknown, cap: number): string | undefined {
  return typeof value === "string" ? clipText(value, cap) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function problem(status: number, code: string, message: string): HttpResult {
  return { status, body: refusal(code as RefusalCode, message) };
}

let claimGeneration = 0;
const claimWaiters = new Set<() => void>();
/** Call after an answered/manual queue transaction commits so held claims retry. */
export function notifyRunQueued(): void {
  claimGeneration += 1;
  for (const wake of claimWaiters) wake();
  claimWaiters.clear();
}

const wakeClaims = notifyRunQueued;

async function waitForClaim(ms: number): Promise<void> {
  const before = claimGeneration;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      claimWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    claimWaiters.add(done);
    if (claimGeneration !== before) done();
  });
}

export class RunQueueScheduler {
  private timer?: NodeJS.Timeout;
  async start(signal: AbortSignal): Promise<void> {
    await armUnarmedLoops();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), RUN_TICK_MS);
    this.timer.unref?.();
    signal.addEventListener("abort", () => this.stop(), { once: true });
  }
  /**
   * Fire due cadences, THEN reclaim dead leases (review F1). Reclaim must not
   * depend on some daemon happening to poll: the machine holding an orphaned
   * run may never come back, and until unit 10 the only caller of
   * `reclaimExpired` was `claimOnce` — so a team whose single machine died left
   * its run "running" indefinitely. `reclaimExpired` wakes parked claims when
   * it re-queues anything, so a re-queued run is picked up immediately.
   */
  private async tick(): Promise<void> {
    try {
      await tickRunClock();
    } catch (err) {
      log.error({ err: String(err) }, "run clock tick failed");
    }
    // R-due rides the SAME tick as the cadence, and in its own try: a due task
    // is a clock fire on a task's date rather than a loop's cron, so it must not
    // be able to starve — or be starved by — the cadence pass.
    try {
      await tickDueTasks();
    } catch (err) {
      log.error({ err: String(err) }, "due task tick failed");
    }
    try {
      const reclaimed = await reclaimExpired();
      if (reclaimed) log.warn({ reclaimed }, "reclaimed runs whose lease expired unattested");
    } catch (err) {
      log.error({ err: String(err) }, "run reclaim tick failed");
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
