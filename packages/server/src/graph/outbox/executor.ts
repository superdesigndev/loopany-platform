/**
 * Graph Engineering v1 - the OUTBOX EXECUTOR. Verdicts start causing things here.
 *
 * `applyTransition` writes a transition and its actions in one transaction; until
 * this module existed, nothing consumed those rows, so a human verdict was
 * recorded and then had no effect. The executor closes that loop: claim due
 * actions, re-check the safety ceiling, run the handler, stamp the outcome.
 *
 * ── the claim ────────────────────────────────────────────────────────────────
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` inside the statement that flips rows to
 * `executing` (see `graphStore.claimActions`). Two passes racing take DISJOINT
 * batches instead of one blocking on the other, so "single instance" is a
 * deployment convenience rather than a correctness requirement - which matters,
 * because a rolling deploy has two instances alive for a few seconds by design.
 *
 * ── the failure ladder, and why nothing is ever dropped ──────────────────────
 *
 *   handler ok                → `done` + `deliveredAt`
 *   handler throws / retryable→ `failed` + `nextAttemptAt` (exponential backoff),
 *                               up to `MAX_ATTEMPTS`, then `dead-letter`
 *   safety re-check refuses   → `dead-letter` IMMEDIATELY (a missing human
 *                               approval will not appear by waiting)
 *   no handler for the kind   → `dead-letter` (`NO_HANDLER`)
 *
 * There is no branch that marks a row `done` without its effect and no branch
 * that leaves it invisible. A dead-letter row IS an attention item
 * (`outbox/attention.ts`), so the end of the ladder is a person, not a log line.
 *
 * ── defense in depth at execution time ───────────────────────────────────────
 *
 * The enqueue path already refuses an R3/R4 action without an approval event (a
 * schema CHECK plus a guard in `applyTransition`). The executor re-checks anyway,
 * and checks MORE than the enqueue could: that the approval event actually EXISTS
 * and was entered by a HUMAN. A schema CHECK can only require the column to be
 * non-null - it cannot know whether the id points at a real row, or whether that
 * row was a rule quietly approving itself. That gap is precisely where an
 * auto-approval would hide, so it is closed at the moment of effect.
 *
 * ── the clock ────────────────────────────────────────────────────────────────
 *
 * `runOnce` takes `now` as an argument, exactly like `applyTransition`. The
 * background loop is the only thing here that reads a clock, which keeps every
 * probe deterministic (kill mid-batch, restart, assert) without fake timers.
 */
import { logger } from "../../logger.js";
import { db } from "../../db/index.js";
import type { OutboxAction } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import type { GraphExec } from "../../db/graphStore.js";
import { DEFAULT_CHAIN_BUDGET } from "../applyTransition.js";
import type { OutboxRefusalCode } from "../types.js";
import { handledKinds, handlerFor, type HandlerResult } from "./handlers.js";

/** Rows claimed per pass. Small on purpose: a batch is one transaction per row,
 *  and a long batch is a long window in which a crash leaves claims to recover. */
export const DEFAULT_BATCH_SIZE = 25;

/** Attempts (including the first) before a row dead-letters. Bounded, so a
 *  permanently broken handler surfaces to a human instead of retrying forever. */
export const MAX_ATTEMPTS = 4;

/** First backoff step; each further attempt quadruples it (10s → 40s → 160s).
 *  No jitter: these are in-graph effects against our own database, not a shared
 *  third-party endpoint with a thundering-herd problem. */
export const RETRY_BASE_MS = 10_000;

/** How long an `executing` claim may sit before it is treated as a crashed
 *  executor's and re-claimed. Longer than any in-graph handler could legitimately
 *  take, short enough that a restart recovers promptly. */
export const EXECUTING_STALE_MS = 60_000;

/** Background loop cadence. */
export const TICK_MS = 2_000;

export interface RunOnceInput {
  /** ISO instant. REQUIRED - the executor never reads a clock (design §12 item 8). */
  now: string;
  limit?: number;
  /** Scope the drain to one team. Omitted ⇒ every team. */
  teamId?: string;
  /** Identifies the claiming instance in `claimed_by` (forensics only - the row
   *  lock is what makes a claim exclusive). */
  owner?: string;
  chainBudget?: number;
}

export interface ActionOutcome {
  id: string;
  kind: string;
  state: "done" | "failed" | "dead-letter";
  detail: string;
  refusalCode?: OutboxRefusalCode;
}

export interface RunOnceResult {
  claimed: number;
  done: number;
  failed: number;
  deadLettered: number;
  outcomes: ActionOutcome[];
}

/**
 * Drain ONE batch. Returns what happened to every row, so a caller (the demo
 * endpoint, a probe, the log line) can say what the pass did rather than trust it.
 *
 * Each action runs in its OWN transaction: the effect and its stamp commit
 * together, and one poisoned row cannot roll back its batch-mates' effects. The
 * claim is a separate transaction ahead of them - so a crash after the claim
 * leaves rows `executing`, which the next pass recovers via `EXECUTING_STALE_MS`.
 */
export async function runOnce(input: RunOnceInput): Promise<RunOnceResult> {
  const now = input.now;
  const nowMs = Date.parse(now);
  const owner = input.owner ?? defaultOwner();
  const claimed = await graph.claimActions(undefined, {
    limit: input.limit ?? DEFAULT_BATCH_SIZE,
    now,
    owner,
    staleBefore: new Date((Number.isNaN(nowMs) ? Date.now() : nowMs) - EXECUTING_STALE_MS).toISOString(),
    ...(input.teamId ? { teamId: input.teamId } : {}),
  });

  const result: RunOnceResult = { claimed: claimed.length, done: 0, failed: 0, deadLettered: 0, outcomes: [] };
  for (const action of claimed) {
    const outcome = await executeClaimed(action, {
      now,
      chainBudget: input.chainBudget ?? DEFAULT_CHAIN_BUDGET,
    });
    result.outcomes.push(outcome);
    if (outcome.state === "done") result.done++;
    else if (outcome.state === "failed") result.failed++;
    else result.deadLettered++;
  }
  if (claimed.length) {
    logger.info(
      { claimed: result.claimed, done: result.done, failed: result.failed, dead: result.deadLettered },
      "outbox: batch drained",
    );
  }
  return result;
}

/**
 * One claimed row: safety re-checks, then the handler, then the stamp - all in a
 * single transaction. A thrown handler rolls the effect back and the row is
 * re-stamped in a FRESH transaction, so a failed attempt never leaves a partial
 * effect behind with a `failed` stamp that suggests otherwise.
 */
async function executeClaimed(
  action: OutboxAction,
  ctx: { now: string; chainBudget: number },
): Promise<ActionOutcome> {
  const refusal = await safetyRefusal(action, ctx.chainBudget);
  if (refusal) {
    await graph.deadLetterAction(undefined, {
      id: action.id,
      refusalCode: refusal.code,
      error: refusal.detail,
      now: ctx.now,
    });
    logger.warn(
      { action: action.id, kind: action.kind, code: refusal.code },
      `outbox: refused at execution time - ${refusal.detail}`,
    );
    return { id: action.id, kind: action.kind, state: "dead-letter", detail: refusal.detail, refusalCode: refusal.code };
  }

  const handler = handlerFor(action.kind);
  if (!handler) {
    const detail = `no handler for "${action.kind}" - implemented kinds: ${handledKinds().join(", ")}`;
    await graph.deadLetterAction(undefined, { id: action.id, refusalCode: "NO_HANDLER", error: detail, now: ctx.now });
    logger.warn({ action: action.id, kind: action.kind }, `outbox: ${detail}`);
    return { id: action.id, kind: action.kind, state: "dead-letter", detail, refusalCode: "NO_HANDLER" };
  }

  let outcome: HandlerResult;
  try {
    outcome = await db.transaction(async (tx) => {
      const exec = tx as unknown as GraphExec;
      const r = await handler({ tx: exec, action, now: ctx.now, chainBudget: ctx.chainBudget });
      // A refusal must not keep the partial writes the handler made on its way to
      // deciding, so roll them back by throwing - and carry the decision out.
      if (!r.ok) throw new HandlerRefusal(r);
      await graph.markActionDone(exec, action.id, ctx.now);
      return r;
    });
  } catch (err) {
    if (err instanceof HandlerRefusal) outcome = err.result;
    else outcome = { ok: false, retryable: true, detail: err instanceof Error ? err.message : String(err) };
  }

  if (outcome.ok) {
    return { id: action.id, kind: action.kind, state: "done", detail: outcome.detail ?? "effect landed" };
  }

  // Permanent refusals stop here; transient ones stop once the budget is gone.
  const exhausted = action.attempts >= MAX_ATTEMPTS;
  if (!outcome.retryable || exhausted) {
    const code: OutboxRefusalCode = outcome.retryable ? "RETRIES_EXHAUSTED" : "HANDLER_REFUSED";
    const detail = outcome.retryable
      ? `${MAX_ATTEMPTS} attempts exhausted - last error: ${outcome.detail}`
      : outcome.detail;
    await graph.deadLetterAction(undefined, { id: action.id, refusalCode: code, error: detail, now: ctx.now });
    logger.warn({ action: action.id, kind: action.kind, code }, `outbox: dead-lettered - ${detail}`);
    return { id: action.id, kind: action.kind, state: "dead-letter", detail, refusalCode: code };
  }

  const nextAttemptAt = backoffAt(ctx.now, action.attempts);
  await graph.markActionFailed(undefined, { id: action.id, error: outcome.detail, nextAttemptAt });
  logger.warn(
    { action: action.id, kind: action.kind, attempts: action.attempts, nextAttemptAt },
    `outbox: attempt failed, retry scheduled - ${outcome.detail}`,
  );
  return { id: action.id, kind: action.kind, state: "failed", detail: outcome.detail };
}

/** Carries a handler's typed refusal out through the transaction rollback. */
class HandlerRefusal extends Error {
  constructor(readonly result: Extract<HandlerResult, { ok: false }>) {
    super(result.detail);
    this.name = "HandlerRefusal";
  }
}

/** `attempts` is already incremented at claim time, so attempt 1 waits one base
 *  step. Quadrupling matches the daemon's transient-retry shape. */
export function backoffAt(now: string, attempts: number): string {
  const base = Date.parse(now);
  const from = Number.isNaN(base) ? Date.now() : base;
  const step = RETRY_BASE_MS * Math.pow(4, Math.max(0, attempts - 1));
  return new Date(from + step).toISOString();
}

// ---- safety re-checks (defense in depth) ----

export interface SafetyRefusal {
  code: OutboxRefusalCode;
  detail: string;
}

/**
 * The execution-time ceiling. Everything here is ALREADY constrained at enqueue
 * time; it is re-checked because the enqueue constraints cannot see what these
 * can:
 *
 *  - the schema CHECK requires `approval_event` to be non-null. It cannot verify
 *    the id resolves to a real event, nor that the event was entered by a HUMAN.
 *    A rule that stamped its own id into that column would satisfy the CHECK and
 *    be exactly the auto-approved outward effect decision 2 forbids.
 *  - `applyTransition` refuses a transition past the chain budget. It cannot
 *    refuse an action row that was legal when enqueued and is now being executed
 *    at the bottom of a longer chain.
 *
 * A refusal here is TERMINAL by construction: none of these conditions can become
 * true by waiting, so retrying would only be a slower way of not telling anyone.
 */
export async function safetyRefusal(action: OutboxAction, chainBudget: number): Promise<SafetyRefusal | undefined> {
  if (action.chainDepth > chainBudget) {
    return {
      code: "CHAIN_BUDGET_EXCEEDED",
      detail: `action is at chain depth ${action.chainDepth}, past the budget of ${chainBudget} - refusing rather than letting a rule chain run away`,
    };
  }

  if (action.consequenceClass !== "R3" && action.consequenceClass !== "R4") return undefined;

  if (!action.approvalEvent) {
    return {
      code: "APPROVAL_MISSING",
      detail: `${action.consequenceClass} action carries no approval event - outward and governance effects are never auto-approved`,
    };
  }
  const approval = await graph.getEvent(undefined, action.approvalEvent);
  if (!approval) {
    return {
      code: "APPROVAL_MISSING",
      detail: `approval event ${action.approvalEvent} does not exist - a non-null column is not an approval`,
    };
  }
  if (approval.entrance !== "human") {
    return {
      code: "APPROVAL_NOT_HUMAN",
      detail: `approval event ${action.approvalEvent} was entered via "${approval.entrance}", not by a human - a rule cannot approve its own outward effect`,
    };
  }
  return undefined;
}

// ---- the background loop ----

interface Running {
  stop: () => void;
}

/**
 * ONE executor per process, guarded on `globalThis` the same way `ensureServer`
 * guards the scheduler - dev HMR re-imports this module, and two intervals would
 * double the drain rate for no benefit. Correctness does not depend on the guard
 * (the claim does); tidiness does.
 */
const g = globalThis as unknown as { __loopanyOutboxExecutor?: Running };

export function startOutboxExecutor(options: { signal?: AbortSignal; tickMs?: number } = {}): Running {
  if (g.__loopanyOutboxExecutor) return g.__loopanyOutboxExecutor;

  let draining = false;
  const tick = async () => {
    // Skip rather than queue: a pass that outruns the cadence would otherwise
    // stack up passes that all contend for the same rows.
    if (draining) return;
    draining = true;
    try {
      await runOnce({ now: new Date().toISOString() });
    } catch (err) {
      logger.error({ err: String(err) }, "outbox: drain tick failed");
    } finally {
      draining = false;
    }
  };

  const timer = setInterval(() => void tick(), options.tickMs ?? TICK_MS);
  timer.unref?.();
  const running: Running = {
    stop: () => {
      clearInterval(timer);
      if (g.__loopanyOutboxExecutor === running) g.__loopanyOutboxExecutor = undefined;
    },
  };
  options.signal?.addEventListener("abort", () => running.stop(), { once: true });
  g.__loopanyOutboxExecutor = running;
  logger.info({ tickMs: options.tickMs ?? TICK_MS, kinds: handledKinds() }, "outbox executor: started");
  return running;
}

export function stopOutboxExecutor(): void {
  g.__loopanyOutboxExecutor?.stop();
}

/**
 * Drain until nothing is left to claim - used by the seeders and the tests, where
 * "run the executor to completion" must be a single await rather than a sleep.
 * Bounded by `maxPasses` so a handler that re-enqueues its own work (the chain
 * bomb) terminates the caller instead of spinning; the budget refusal is what
 * stops the CHAIN, this only stops the loop around it.
 */
export async function drainOutbox(
  input: RunOnceInput & { maxPasses?: number },
): Promise<RunOnceResult> {
  const total: RunOnceResult = { claimed: 0, done: 0, failed: 0, deadLettered: 0, outcomes: [] };
  const maxPasses = input.maxPasses ?? 200;
  for (let pass = 0; pass < maxPasses; pass++) {
    const r = await runOnce(input);
    total.claimed += r.claimed;
    total.done += r.done;
    total.failed += r.failed;
    total.deadLettered += r.deadLettered;
    total.outcomes.push(...r.outcomes);
    // Only `done`/`dead-letter` are progress. A pass that only produced `failed`
    // rows scheduled them into the future, so claiming again at the same `now`
    // would return nothing and spin.
    if (r.claimed === 0 || r.done + r.deadLettered === 0) break;
  }
  return total;
}

function defaultOwner(): string {
  return `exec-${process.pid}`;
}
