/**
 * The wire, from the agent's side.
 *
 * These types MIRROR `packages/server/src/graph/effects/channel.ts` deliberately
 * rather than importing it: the agent must be installable on a machine that has
 * no copy of the server, and a type-only import today is a runtime import after
 * one careless refactor. Everything crosses as JSON.
 *
 * The mirroring is checked the only way it can honestly be checked - by a real
 * round trip against a running server, which is what the e2e demo is.
 */

export type EffectKind = "github-comment" | "github-merge";

/**
 * The typed refusal codes the server accepts on a report. Repeated here for the
 * same reason as everything else in this file, and kept as a closed union so a
 * typo becomes a compile error rather than a 400 at the far end.
 */
export type RefusalCode =
  | "AGENT_ERROR"
  | "LEASE_EXPIRED"
  | "REPO_NOT_ALLOWED"
  | "DEFAULT_BRANCH_REFUSED"
  | "APPROVAL_INVALID"
  | "TARGET_UNRESOLVED"
  | "NOT_MERGEABLE"
  | "UNSUPPORTED_KIND";

/** The approval evidence that rides with a work order, for the agent to re-check. */
export interface ApprovalBlock {
  eventId: string;
  entrance: string;
  actorId: string;
  ts: string;
  transition: string | null;
}

/** One work order. Self-contained: the agent never queries the graph. */
export interface Directive {
  id: string;
  kind: EffectKind | string;
  teamId: string;
  objectId: string | null;
  target: { source: string; externalId: string; repo: string | null; number: number | null };
  payload: Record<string, unknown>;
  approval?: ApprovalBlock;
  attempts: number;
  leaseExpiresAt: string;
  createdAt: string;
}

export interface ClaimResponse {
  ok: true;
  directives: Directive[];
  requeued: number;
  expired: number;
  leaseMs: number;
}

/** What an executed effect produced out there - the PROOF, reported back and
 *  stored on the directive row so "did it actually happen?" has an answer that is
 *  not "go and look". */
export interface EffectResult {
  /** The comment or the merged PR. */
  url?: string;
  /** A one-line human summary the workspace renders. */
  detail?: string;
  /** True when the effect was ALREADY in place and this run did nothing - the
   *  idempotency path. Still a success: the world is as the verdict asked. */
  alreadyDone?: boolean;
  [k: string]: unknown;
}

export type ExecuteOutcome =
  | { ok: true; result: EffectResult }
  | { ok: false; code: RefusalCode; error: string };
