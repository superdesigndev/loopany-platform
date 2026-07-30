/**
 * Graph Engineering v1 - EFFECT DELIVERY: the DIRECTIVE CHANNEL.
 *
 * The three verbs an effect agent speaks, over `effect_directives`:
 *
 *   claim(agent)        take up to N pending work orders, with a lease
 *   heartbeat(agent,id) "still working" - push the lease out
 *   report(agent,id,…)  the effect landed, or it did not, with a typed reason
 *
 * ── what the server does and does not do here ────────────────────────────────
 *
 * It hands out work and records outcomes. It does NOT reach GitHub, evaluate a
 * repo allowlist, or decide whether a merge is safe - all of that belongs where
 * the credentials are. The one thing it does that looks like policy is SHIPPING
 * THE APPROVAL for the agent to re-check, and that is not the server deciding, it
 * is the server handing over the evidence so the far end can decide again.
 *
 * ── the approval travels with the work order ────────────────────────────────
 *
 * Every claimed directive carries an `approval` block: the resolved event row's
 * id, entrance and actor. The agent refuses anything whose approval is absent,
 * mismatched, or not `human`. That is the THIRD independent check on the same
 * fact - the schema CHECK when the action was enqueued, the executor's re-check
 * at effect time, and now the agent's - and the reason there are three is that
 * they fail differently: a constraint cannot see whether an id resolves, the
 * executor cannot see whether the wire was tampered with, and the agent cannot
 * see the graph. An outward effect should have to get past all three.
 *
 * ── the clock ───────────────────────────────────────────────────────────────
 *
 * Every function takes `now`. Same discipline as `applyTransition`, the outbox
 * executor and the mirror poller: the route reads the clock, so a probe can
 * expire a lease at a chosen instant without fake timers.
 */
import { logger } from "../../logger.js";
import type { EffectDirective, GraphEvent } from "../../db/graph-schema.js";
import * as graph from "../../db/graphStore.js";
import type { DirectiveRefusalCode } from "../types.js";
import { CLAIM_BATCH, leaseMs, maxClaims } from "./config.js";

/** The approval evidence a work order carries, for the agent to re-check. */
export interface ApprovalBlock {
  eventId: string;
  entrance: string;
  actorId: string;
  ts: string;
  /** The transition a person ran, when the approving event was a state change. */
  transition: string | null;
}

/** One work order as the agent sees it. A flat, self-contained shape: the agent
 *  never queries the graph, so anything it needs is here. */
export interface DirectiveWire {
  id: string;
  kind: EffectDirective["kind"];
  teamId: string;
  objectId: string | null;
  target: { source: string; externalId: string; repo: string | null; number: number | null };
  payload: Record<string, unknown>;
  /** Present unless the approval event has vanished from the log - in which case
   *  the agent MUST refuse, which is exactly why this is optional rather than
   *  faked into a plausible shape. */
  approval?: ApprovalBlock;
  attempts: number;
  /** When this claim stops being believed. The agent heartbeats before then. */
  leaseExpiresAt: string;
  createdAt: string;
}

export interface ClaimInput {
  /** ISO. Required - the channel never reads a clock. */
  now: string;
  /** Who is claiming: an agent instance id, recorded on the row. */
  agent: string;
  /** The machine this agent runs on. A directive BOUND to a machine is only
   *  offered to that machine; an unbound one to anybody. */
  machine?: string;
  teamId?: string;
  limit?: number;
}

export interface ClaimResult {
  directives: DirectiveWire[];
  /** Leases this call reclaimed from a dead agent (returned to `pending`). */
  requeued: number;
  /** Leases this call gave up on entirely - now attention items. */
  expired: number;
  /** How long the agent's leases run, so it can pick a heartbeat cadence rather
   *  than hard-coding one that a server-side change would silently invalidate. */
  leaseMs: number;
}

/**
 * Claim a batch.
 *
 * Lease expiry runs FIRST, every time. It is not a background job: the agent's
 * own poll is the most reliable clock this channel has, so recovering a dead
 * agent's work is folded into the act of asking for more. A server with no agent
 * polling has no directives moving anyway - there is nothing to recover.
 */
export async function claimDirectives(input: ClaimInput): Promise<ClaimResult> {
  const expiry = await graph.expireDirectiveLeases(undefined, {
    now: input.now,
    maxAttempts: maxClaims(),
    ...(input.teamId ? { teamId: input.teamId } : {}),
  });
  for (const row of expiry.failed) {
    logger.warn(
      { directive: row.id, kind: row.kind, attempts: row.attempts },
      "effects: directive gave up after repeated lease expiry - it is now an attention item",
    );
  }
  if (expiry.requeued.length) {
    logger.info({ n: expiry.requeued.length }, "effects: expired leases returned to pending");
  }

  const ms = leaseMs();
  const rows = await graph.claimDirectives(undefined, {
    limit: input.limit ?? CLAIM_BATCH,
    now: input.now,
    agent: input.agent,
    leaseUntil: new Date(msOf(input.now) + ms).toISOString(),
    ...(input.teamId ? { teamId: input.teamId } : {}),
    ...(input.machine ? { machine: input.machine } : {}),
  });

  const directives: DirectiveWire[] = [];
  for (const row of rows) directives.push(await toWire(row));
  if (directives.length) {
    logger.info({ agent: input.agent, n: directives.length }, "effects: directives claimed");
  }
  return { directives, requeued: expiry.requeued.length, expired: expiry.failed.length, leaseMs: ms };
}

export type HeartbeatResult =
  | { ok: true; leaseExpiresAt: string }
  | { ok: false; code: "LEASE_LOST"; message: string };

/**
 * Push the lease out. A heartbeat that matches nothing means the agent no longer
 * holds the row - it was reclaimed while this agent was busy - and the honest
 * answer is to say so, so the agent can abandon the work rather than finish an
 * effect somebody else is also running.
 */
export async function heartbeatDirective(input: {
  now: string;
  agent: string;
  id: string;
}): Promise<HeartbeatResult> {
  const ms = leaseMs();
  const leaseUntil = new Date(msOf(input.now) + ms).toISOString();
  const row = await graph.heartbeatDirective(undefined, {
    id: input.id,
    agent: input.agent,
    now: input.now,
    leaseUntil,
  });
  if (!row) {
    return {
      ok: false,
      code: "LEASE_LOST",
      message: `${input.id} is no longer claimed by ${input.agent} - stop work on it`,
    };
  }
  return { ok: true, leaseExpiresAt: leaseUntil };
}

export interface ReportInput {
  now: string;
  agent: string;
  id: string;
  ok: boolean;
  /** What the effect produced out there - a comment url, a merge sha. The PROOF. */
  result?: Record<string, unknown> | null;
  /** Required when `ok` is false: WHY, typed. An untyped failure would leave the
   *  attention list guessing whether to offer a retry. */
  refusalCode?: DirectiveRefusalCode | null;
  error?: string | null;
}

export type ReportResult =
  | { ok: true; state: EffectDirective["state"]; detail: string }
  | { ok: false; code: "LEASE_LOST" | "UNKNOWN_DIRECTIVE"; message: string };

/**
 * Record the outcome. Guarded on the reporting agent still holding the lease, so
 * a zombie that wakes up after being reclaimed cannot overwrite what its
 * successor recorded - it is told `LEASE_LOST` instead, which is the truth.
 */
export async function reportDirective(input: ReportInput): Promise<ReportResult> {
  const settled = await graph.settleDirective(undefined, {
    id: input.id,
    agent: input.agent,
    now: input.now,
    ok: input.ok,
    result: input.result ?? null,
    refusalCode: input.refusalCode ?? null,
    error: input.error ?? null,
  });
  if (!settled) {
    const existing = await graph.getDirective(undefined, input.id);
    if (!existing) {
      return { ok: false, code: "UNKNOWN_DIRECTIVE", message: `no directive ${input.id}` };
    }
    return {
      ok: false,
      code: "LEASE_LOST",
      message: `${input.id} is "${existing.state}" and held by ${existing.claimedBy ?? "nobody"} - this report is too late`,
    };
  }
  if (settled.state === "done") {
    logger.info({ directive: settled.id, kind: settled.kind, result: settled.result }, "effects: outward effect landed");
  } else {
    logger.warn(
      { directive: settled.id, kind: settled.kind, code: settled.refusalCode, error: settled.lastError },
      "effects: outward effect FAILED - it is now an attention item",
    );
  }
  return {
    ok: true,
    state: settled.state,
    detail: settled.state === "done" ? "recorded" : `recorded as failed (${settled.refusalCode})`,
  };
}

// ---- wire shaping ----

async function toWire(row: EffectDirective): Promise<DirectiveWire> {
  const approval = await graph.getEvent(undefined, row.approvalEvent);
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    kind: row.kind,
    teamId: row.teamId,
    objectId: row.objectId,
    target: {
      source: row.targetSource,
      externalId: row.targetExternalId,
      repo: typeof payload.repo === "string" ? payload.repo : null,
      number: typeof payload.number === "number" ? payload.number : null,
    },
    payload,
    ...(approval ? { approval: approvalBlock(approval) } : {}),
    attempts: row.attempts,
    leaseExpiresAt: row.leaseExpiresAt ?? "",
    createdAt: row.createdAt,
  };
}

function approvalBlock(e: GraphEvent): ApprovalBlock {
  return { eventId: e.id, entrance: e.entrance, actorId: e.actorId, ts: e.ts, transition: e.transition };
}

function msOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}
