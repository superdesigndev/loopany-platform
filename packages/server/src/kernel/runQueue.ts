/** Rewrite unit 3: level-triggered clock, run queue, device claim and finish. */
// Source import keeps a fresh checkout typecheckable before the workspace codec
// has been built to dist; the package remains the dependency/runtime owner.
import { safeParseArtifact } from "../../../artifact-format/src/index.js";
import { and, asc, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { db } from "../db/index.js";
import { objects, type KernelObject } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import * as legacyStore from "../db/store.js";
import { runs, type Machine, type Run } from "../db/schema.js";
import { machineIdFromToken, isDeviceTokenShape, sha256 } from "../gateway/tokens.js";
import { clipText, type HttpResult } from "../gateway/http.js";
import { logger } from "../logger.js";
import { applyTransitionIn, createObjectIn } from "./applyTransition.js";
import {
  answeredRunId,
  autoPauseTaskId,
  clockRunId,
  derivedEventId,
  newRunId,
  reportDocId,
} from "./ids.js";
import { nextOccurrenceAfter } from "./schedule.js";

const log = logger.child({ mod: "run-queue" });

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

export interface QueueInput {
  loop: KernelObject;
  now: string;
  reason: "clock" | "answered" | "manual";
  scope?: string;
  scheduledFor?: string | null;
  /** Required for answered runs so a retried verdict derives the same row. */
  verdictEventId?: string;
}

/** Callable insertion seam for unit 4's R-answer transaction. */
export async function queueKernelRun(tx: store.KernelExec, input: QueueInput) {
  const { loop, now, reason } = input;
  if (reason === "answered" && !input.verdictEventId) {
    throw new Error("answered runs require verdictEventId for deterministic identity");
  }
  const id =
    reason === "clock" && input.scheduledFor
      ? clockRunId(loop.id, input.scheduledFor)
      : reason === "answered" && input.verdictEventId
        ? answeredRunId(input.verdictEventId)
        : newRunId(Date.parse(now));
  return store.queueRun(tx, {
    id,
    loopId: loop.id,
    // Additive reuse of the legacy table requires these columns. They are not
    // authority in v2: claim stamps the actual machine and loop→team owns scope.
    userId: loop.teamId,
    machineId: "",
    phase: "pending",
    role: "exec",
    ts: now,
    queueState: "queued",
    scope: input.scope ?? "routine",
    reason,
    entrance: reason === "clock" ? "clock" : reason === "answered" ? "answer" : "human",
    scheduledFor: input.scheduledFor ?? null,
  });
}

export interface TickResult {
  scanned: number;
  queued: number;
  skipped: number;
  replayed: number;
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
  const result: TickResult = { scanned: due.length, queued: 0, skipped: 0, replayed: 0 };

  for (const loop of due) {
    const scheduledFor = loop.nextFire!;
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as store.KernelExec;
      const queued = await queueKernelRun(tx, { loop, now: nowIso, reason: "clock", scheduledFor });
      if (queued.outcome === "queued") {
        await store.appendEvent(tx, {
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
        await store.appendEvent(tx, {
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

export async function authenticateDevice(token: string): Promise<Machine | undefined> {
  if (!isDeviceTokenShape(token)) return undefined;
  const machine = await legacyStore.getMachine(machineIdFromToken(token));
  if (!machine || machine.tokenHash !== sha256(token)) return undefined;
  return machine;
}

export interface ClaimBody {
  machine?: string;
  agent?: string;
  wait?: boolean;
}

export async function claimRun(machine: Machine, body: ClaimBody, now = new Date()): Promise<HttpResult> {
  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  if (!agent) return problem(400, "INVALID_BODY", "agent is required");
  if (body.machine && body.machine !== machine.id) return problem(403, "NOT_YOUR_MACHINE", "machine does not match the device credential");

  let claimed = await claimOnce(machine, agent, now);
  let waitedMs = 0;
  if (!claimed && body.wait) {
    const began = Date.now();
    await waitForClaim(CLAIM_HOLD_MS);
    waitedMs = Date.now() - began;
    claimed = await claimOnce(machine, agent, new Date());
  }
  if (!claimed) return { status: 200, body: { run: null, waitedMs } };
  const { run, loop } = claimed;
  const taskId = run.scope?.startsWith("task:") ? run.scope.slice(5) : undefined;
  const task = taskId ? await store.getObject(undefined, taskId) : undefined;
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
      scopeNote: taskId ? `One task was answered by a human and is waiting for you: ${taskId}.` : null,
      ...(task ? { task } : {}),
      execution: executionConfig(loop.payload),
      roots: machine.roots ?? undefined,
      leaseExpiresAt: run.leaseExpiresAt,
      leaseMs: RUN_LEASE_MS,
    },
  };
}

async function claimOnce(machine: Machine, agent: string, now: Date): Promise<{ run: Run; loop: KernelObject } | undefined> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    // A poll from the holding device is the liveness signal. Renew before the
    // expiry sweep so healthy unlimited-duration agent runs cannot be reclaimed.
    await renewMachineLeasesIn(tx, machine.id, now);
    await reclaimExpiredIn(tx, now);
    const rows = await rawTx
      .select({ run: runs, loop: objects })
      .from(runs)
      .innerJoin(objects, eq(objects.id, runs.loopId))
      .where(
        and(
          eq(runs.queueState, "queued"),
          eq(objects.kind, "loop"),
          eq(objects.status, "active"),
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
    await store.appendEvent(tx, {
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

async function renewMachineLeasesIn(tx: store.KernelExec, machineId: string, now: Date): Promise<number> {
  const rows = await tx
    .update(runs)
    .set({ leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS).toISOString() })
    .where(
      and(
        eq(runs.queueState, "claimed"),
        eq(runs.leaseState, "active"),
        eq(runs.machineId, machineId),
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
  await store.appendEvent(tx, {
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
      if (!created.ok) return problem(400, created.code, created.message);
      report = { id: created.object.id, created: created.created };
    }

    const finishedEvent = await store.appendEvent(tx, {
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
  if (!paused.ok) return undefined;
  const question = autoPauseTaskId(loop.id, runId);
  const task = await createObjectIn(tx, {
    id: question,
    teamId: loop.teamId,
    kind: "task",
    actor: { entrance: "agent", actorId: runId },
    now: stamp,
    title: `${loop.title ?? loop.id} paused after repeated failures`,
    pendingQuestion: `Loop ${loop.title ?? loop.id} (${loop.id}) failed ${streak} consecutive runs, most recently ${runId}. Fix the cause and resume it?`,
    watcher: null,
    createdByRun: runId,
    createdByLoop: loop.id,
  });
  if (!task.ok) return undefined;
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

function executionConfig(payload: Record<string, unknown> | null): Record<string, unknown> {
  const p = payload ?? {};
  const agent = p.agent === "codex" || p.agent === "grok" || p.agent === "claude-code" ? p.agent : "claude-code";
  return {
    agent,
    workdir: typeof p.workdir === "string" ? p.workdir : null,
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
  return { status, body: { error: { code, message } } };
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
    await tickRunClock();
    this.timer = setInterval(() => void tickRunClock().catch((err) => log.error({ err: String(err) }, "run clock tick failed")), RUN_TICK_MS);
    this.timer.unref?.();
    signal.addEventListener("abort", () => this.stop(), { once: true });
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
