/**
 * The wire, from the agent's side.
 *
 * These types MIRROR the server (`graph/effects/channel.ts`,
 * `graph/effects/instruction.ts`, `graph/sensing/watch.ts`, `graph/agent/runs.ts`)
 * deliberately rather than importing them: the agent must be installable on a
 * machine that has no copy of the server, and a type-only import today is a runtime
 * import after one careless refactor. Everything crosses as JSON.
 *
 * The mirroring is checked the only way it can honestly be checked - by a real round
 * trip against a running server, which is what the e2e demo is.
 */

export type EffectKind = "github-comment" | "github-merge" | "run-task";

/**
 * The typed refusal codes the server accepts on a report. Repeated here for the same
 * reason as everything else in this file, and kept as a closed union so a typo
 * becomes a compile error rather than a 400 at the far end.
 */
export type RefusalCode =
  | "AGENT_ERROR"
  | "LEASE_EXPIRED"
  | "REPO_NOT_ALLOWED"
  | "DEFAULT_BRANCH_REFUSED"
  | "APPROVAL_INVALID"
  | "TARGET_UNRESOLVED"
  | "NOT_MERGEABLE"
  | "UNSUPPORTED_KIND"
  | "RUN_FAILED"
  | "RUN_TIMEOUT"
  | "RUN_NOT_PERMITTED";

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

/** What an executed effect produced out there - the PROOF, reported back and stored
 *  on the directive row so "did it actually happen?" has an answer that is not "go
 *  and look". */
export interface EffectResult {
  /** The comment, the merged PR, or the run's own id. */
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

// ---- the instruction work order (the `run-task` payload) ----

/** What an instruction may touch - the half a DETERMINISTIC pre-flight check reads. */
export interface RunScope {
  workdir?: string;
  repos: string[];
  writes: string[];
  timeoutMs: number;
}

/**
 * One instruction work order: INTENT + CONTEXT + SCOPE.
 *
 * Captain decision 12's generic shape. The agent does not branch on what KIND of
 * work this is - a PR comment, an Intercom reply, an investigation are all the same
 * three fields - which is exactly what makes it the default path rather than a
 * special case that grew.
 */
export interface Instruction {
  runId: string;
  intent: string;
  context: Record<string, unknown>;
  scope: RunScope;
  label: string;
  onSuccess?: string;
  onFailure?: string;
  /** The transitions a work order binds to what the run FOUND (see `RunFinding`).
   *  Their PRESENCE is what tells this agent the declaration wants a finding at all,
   *  which is why they are mirrored here even though the agent never runs one. */
  onFinding?: string;
  onNothingNew?: string;
  report: boolean;
}

/** Does this work order care what the run found? Asking for a verdict a declaration
 *  binds nothing to would be putting words in a spec's mouth, so the prompt only
 *  states the contract when one of the two paths is declared. */
export function wantsFinding(spec: Instruction): boolean {
  return Boolean(spec.onFinding || spec.onNothingNew);
}

/** Read an instruction off a directive's payload, or undefined when it is not one.
 *  Defensive by design: this is data that crossed a wire. */
export function instructionOf(payload: Record<string, unknown>): Instruction | undefined {
  const runId = str(payload.runId);
  const intent = str(payload.intent);
  if (!runId || !intent) return undefined;
  const rawScope = (payload.scope ?? {}) as Record<string, unknown>;
  const timeout = Number(rawScope.timeoutMs);
  const workdir = str(rawScope.workdir);
  const onSuccess = str(payload.onSuccess);
  const onFailure = str(payload.onFailure);
  const onFinding = str(payload.onFinding);
  const onNothingNew = str(payload.onNothingNew);
  return {
    runId,
    intent,
    context: isRecord(payload.context) ? payload.context : {},
    scope: {
      ...(workdir ? { workdir } : {}),
      repos: strings(rawScope.repos),
      writes: strings(rawScope.writes),
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 0,
    },
    label: str(payload.label) ?? intent.split("\n")[0]!.slice(0, 120),
    ...(onSuccess ? { onSuccess } : {}),
    ...(onFailure ? { onFailure } : {}),
    ...(onFinding ? { onFinding } : {}),
    ...(onNothingNew ? { onNothingNew } : {}),
    report: payload.report === true,
  };
}

// ---- sensing ----

/** One mirror the server asks this agent to keep fresh. */
export interface WatchItem {
  objectId: string;
  externalId: string;
  repo: string;
  number: number;
  observedAt: string | null;
}

export interface WatchListResponse {
  ok: true;
  teamId: string;
  source: string;
  items: WatchItem[];
  truncated: boolean;
}

/** The four facts observed per PR, plus the cross-references found in its prose.
 *  Mirrors the server's `ObservedPr` exactly - the closed sets included, because a
 *  value outside them is refused at the wire rather than coerced. */
export interface ObservedPr {
  repo: string;
  number: number;
  state: "open" | "merged" | "closed";
  merged: boolean;
  checks: "passing" | "failing" | "pending" | "none";
  title: string;
  draft: boolean;
  references?: { repo: string; number: number }[];
}

export interface ObservationReportResponse {
  ok: true;
  mirrors: number;
  reported: number;
  unknown: number;
  changed: number;
  events: number;
  waitsClosed: number;
  discovered: number;
  refusals: string[];
  capped: boolean;
}

// ---- the run lifecycle ----

export type RunOutcome = "success" | "failure";

/**
 * WHAT THE RUN FOUND - mirrors the server's `RUN_FINDINGS` (see
 * `graph/effects/instruction.ts`), and a closed union for the same reason
 * `RefusalCode` is: a typo must be a compile error here, not a 400 at the far end.
 *
 * Distinct from the OUTCOME on purpose. "Did the run work?" and "did it turn
 * anything up?" are different questions, and a watch that ran perfectly on a quiet
 * day must not have to claim failure to avoid waking somebody.
 */
export const RUN_FINDINGS = ["discovery", "nothing-new"] as const;
export type RunFinding = (typeof RUN_FINDINGS)[number];

export interface RunStartedResponse {
  ok: true;
  runId: string;
  objectId: string;
  replay: boolean;
}

export interface RunFinishedResponse {
  ok: true;
  runId: string;
  objectId: string;
  outcome: RunOutcome;
  finding?: RunFinding;
  replay: boolean;
  advanced?: { transition: string; status: string; replay: boolean };
  notAdvanced?: string;
  report?: { objectId: string; created: boolean };
}

// ---- local helpers ----

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
}
