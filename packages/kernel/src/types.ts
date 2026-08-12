/**
 * The kernel's entity model. Four record classes:
 *
 *   Objects are the PRESENT, Events are the PAST, Triggers are the FUTURE,
 *   Runs are the HANDOFF in flight. Everything else (inbox, board, tree,
 *   loops) is a query and is never stored.
 *
 * Hard types are only where the kernel branches: archetype, mirror.kind,
 * trigger.kind, run.cause. `task.type` and doc front-matter stay soft
 * (stored verbatim, warned about, never refused).
 */

// ---- task status ----

export const TASK_STATUSES = [
  "idea",
  "todo",
  "in-progress",
  "follow-up",
  "done",
  "archived",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "archived"];
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Soft vocabulary — unknown values warn (a notice), never refuse. */
export const TASK_TYPES = ["goal", "strategy", "experiment"] as const;
export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

// ---- objects ----

export interface TaskObject {
  archetype: "task";
  id: string;
  title: string;
  status: TaskStatus;
  /** Person (email), agent name, loop name, or null = backlog. Resolution is the driver's job.
   *  Remote convention: an EXECUTION ADDRESS `<machine>/<agent>` (mbp/claude). */
  assignee: string | null;
  /** The responsible HUMAN (email) - notification / escalation recipient. Not
   *  the executor (that is assignee). Null = unowned. */
  owner: string | null;
  priority: string | null;
  type: string | null;
  /** Single-valued tree edge; cycle-checked at write time. */
  parent: string | null;
  /** Single-valued shepherd reference -> doc | mirror. */
  tracks: string | null;
  /** Loose informational links; no write-back or verdict semantics. */
  refs: readonly string[];
  /** The single follow-up slot. Invariant: non-null <=> status === "follow-up". */
  followUpAt: string | null;
  /** ABSOLUTE working directory the run spawns in (loops usually work inside
   *  another project's checkout). Null = the workspace root. The path is
   *  machine-local by design (assignee already names the machine); spawn fails
   *  LOUD when it does not exist on the executing machine. */
  workdir: string | null;
  /** The FINISH LINE (closed goal). Null = open work (a loop may run forever);
   *  non-null = this task COMPLETES: moving it to done requires a completion
   *  note as evidence, and completion pauses its triggers (the existing
   *  terminal-status invariant). A goal is prose, never a separate entity. */
  goal: string | null;
  /** Curated present (Spec / current understanding). */
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocObject {
  archetype: "doc";
  id: string;
  key: string;
  title: string | null;
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** External-fact pointer. Structurally carries NO body/payload: the
 *  platform never caches the outside world's state. */
export interface MirrorObject {
  archetype: "mirror";
  id: string;
  kind: string;
  coords: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type KernelObject = TaskObject | DocObject | MirrorObject;

/** Hard enum — identity normalization branches on it. */
export const MIRROR_KINDS = ["github-pr", "github-issue", "url"] as const;

// ---- triggers (the future) ----

export interface Trigger {
  id: string;
  taskId: string;
  kind: "cron" | "once";
  /** cron expression | ISO instant (== the task's followUpAt for `once`). */
  spec: string;
  timezone: string | null;
  enabled: boolean;
  /** Who disabled it. "invariant" marks entry-invariant #2 so leaving a
   *  terminal status can symmetrically re-arm (#2'); "owner" is never
   *  auto-revived. */
  disabledBy: "owner" | "invariant" | null;
  nextFireAt: string | null;
}

// ---- runs (the handoff) ----

export type RunCause = "assignment" | "cron" | "once" | "manual";
export type RunState = "pending" | "claimed" | "running" | "done" | "failed" | "superseded";
export const ACTIVE_RUN_STATES: readonly RunState[] = ["pending", "claimed", "running"];

export interface RunRecord {
  id: string;
  taskId: string;
  cause: RunCause;
  scheduledAt: string;
  state: RunState;
  /** Assignee snapshot fixed at dispatch time. */
  assignee: string | null;
  triggerId: string | null;
  createdAt: string;
  /** The agent session that claimed this run (captured at claim, the key to the
   *  transcript deep-dive — context ladder rung ⑤). Null until claimed. */
  sessionId?: string | null;
  /** The HOST AGENT's own session id (e.g. Claude Code's session UUID), reported
   *  at run-finish by the executing host. Distinct from `sessionId` (the kernel's
   *  correlation key stamped at claim): this one names the agent's LOCAL
   *  transcript, so a human can trace what the session actually did
   *  (`find ~/.claude/projects -name '<id>.jsonl'`). Null when the host has no
   *  such notion (replay shim, non-Claude agents until their adapters land). */
  agentSessionId?: string | null;
  /** The finishing note the agent left when it returned the run. Null until finished. */
  note?: string | null;
}

// ---- events (the past; Objects are authoritative, Events are the audit) ----

export type EventKind =
  | "created"
  | "note"
  | "status-changed"
  | "assignee-changed"
  | "fields-changed"
  | "doc-updated"
  | "observation"
  // the run handoff, recorded on the TASK's stream: run-started when an agent
  // claims and begins a run, run-returned when it reports the outcome (§3).
  | "run-started"
  | "run-returned"
  | "trigger-discarded";

export interface Observation {
  observedAt: string;
  /** PR head SHA, ETag, query range … — makes the external read reproducible. */
  sourceRevision?: string;
  facts?: Record<string, string | number | boolean>;
  evidenceRefs?: readonly string[];
}

export interface Provenance {
  entrance: "human" | "agent-run" | "clock";
  /** userId | runId | triggerId — captured at write time, unreconstructable later. */
  actorId: string;
  sessionId?: string;
}

export interface KernelEvent {
  id: string;
  objectId: string;
  kind: EventKind;
  at: string;
  /** Field-level {old,new} captured at write time. */
  diff?: Record<string, { old: unknown; new: unknown }>;
  note?: string;
  observation?: Observation;
  provenance: Provenance;
}

// ---- snapshot (what decide/tick read) ----

export interface Snapshot {
  objects: Readonly<Record<string, KernelObject>>;
  triggers: readonly Trigger[];
  runs: readonly RunRecord[];
}

export function emptySnapshot(): Snapshot {
  return { objects: {}, triggers: [], runs: [] };
}

// ---- commands ----

export interface CreateCommand {
  op: "create";
  id?: string;
  title: string;
  status?: string;
  assignee?: string;
  owner?: string;
  workdir?: string;
  priority?: string;
  type?: string;
  parent?: string;
  tracks?: string;
  refs?: readonly string[];
  body?: string;
  cron?: string;
  timezone?: string;
  followUpAt?: string;
  goal?: string;
}

export interface UpdateCommand {
  op: "update";
  id: string;
  patch: Record<string, unknown>;
  note?: string;
  ifVersion?: number;
}

export interface NoteCommand {
  op: "note";
  id: string;
  note: string;
  observation?: Observation;
}

export interface DocPutCommand {
  op: "doc-put";
  key: string;
  /** Derived from the Markdown body by the CLI. Explicit null clears a title
   *  when the replacement body no longer has an H1; undefined preserves it. */
  title?: string | null;
  body: string;
  ifVersion?: number;
  /** Attach the doc to this task in the SAME decision: append the doc id to the
   *  task's `refs` (idempotent) + a fields-changed event on the TASK's log. One
   *  command, both writes - the two-step attach was skipped by every real agent
   *  across six sim rounds (the doc worked by key convention, but the task page
   *  / forensics / future GC lose the edge). */
  attachTask?: string;
}

export interface MirrorAddCommand {
  op: "mirror-add";
  kind: string;
  coords: string;
  /** Attach the mirror to this task in the SAME decision (append to the task's
   *  `refs`, idempotent) — the doc-put atomic attach, applied to mirrors for
   *  the same reason: the separate second link step never happens, so a bare
   *  `mirror add` leaves an island object no task points at. Attach also fires
   *  on a DEDUP hit (the mirror already existed but the edge may not). */
  attachTask?: string;
}

export interface RunCommand {
  op: "run";
  id: string;
}

/** A host CLAIMS a pending run and begins execution (pending -> running, via the
 *  claimed intermediate). Emits run-started on the task; for a one-shot task it
 *  also flips todo -> in-progress (§5.1). */
export interface RunClaimCommand {
  op: "run-claim";
  runId: string;
  sessionId?: string;
}

/** A host FINISHES an active run with its outcome. Emits run-returned; a failed
 *  run advances nothing else (the task keeps whatever status the agent left). */
export interface RunFinishCommand {
  op: "run-finish";
  runId: string;
  outcome: "done" | "failed";
  note?: string;
  /** The host agent's own session id (see RunRecord.agentSessionId). */
  agentSessionId?: string;
}

export interface DeleteCommand {
  op: "delete";
  id: string;
}

export type Command =
  | CreateCommand
  | UpdateCommand
  | NoteCommand
  | DocPutCommand
  | MirrorAddCommand
  | RunCommand
  | RunClaimCommand
  | RunFinishCommand
  | DeleteCommand;

// ---- decision (what decide returns) ----
//
// A Changeset is a set of EXPLICIT mutations, each carrying its own
// precondition (§9 promises CAS). applyChangeset validates every precondition
// against the target snapshot before folding, so a stale changeset yields a
// typed conflict instead of silently resurrecting an old version. This is the
// same authority-side guarantee whether the fold happens in the local driver
// or in SQL on the server.

/** Object upsert. `expectedVersion: null` means MUST-NOT-EXIST (a create);
 *  a number N means the target's current version MUST equal N (the new
 *  object.version being N+1). */
export interface ObjectMutation {
  object: KernelObject;
  expectedVersion: number | null;
}

/** A trigger's whole fate in one op, CAS-guarded like objects and runs
 *  (finding: trigger mutations carried no precondition, so a stale put/delete
 *  silently overwrote newer scheduling state). Exactly ONE op per trigger id
 *  per changeset — applyChangeset refuses a changeset with two ops on one id
 *  rather than relying on array order.
 *
 *  `expected` is the trigger the decision READ (its precondition):
 *   - put with `expected: null` = MUST-NOT-EXIST (a fresh arm/create).
 *   - put with `expected: Trigger` = the target must EQUAL that trigger (a
 *     re-arm/edit off a known base; a stale put whose base diverged conflicts).
 *   - delete with `expected: Trigger` = the target must EQUAL that trigger (a
 *     disarm off a known base; a stale delete over a newer trigger conflicts). */
export type TriggerMutation =
  | { op: "put"; trigger: Trigger; expected: Trigger | null }
  | { op: "delete"; id: string; expected: Trigger };

/** `insert` = MUST-NOT-EXIST (a fresh dispatch — the run id's uniqueness IS
 *  the dispatch dedup). `put` = a state transition on an existing run whose
 *  current state must be one of `expectedState` (e.g. pending -> superseded). */
export type RunMutation =
  | { op: "insert"; run: RunRecord }
  | { op: "put"; run: RunRecord; expectedState: readonly RunState[] };

export interface Changeset {
  objects: ObjectMutation[];
  events: KernelEvent[];
  triggers: TriggerMutation[];
  runs: RunMutation[];
}

export function emptyChangeset(): Changeset {
  return { objects: [], events: [], triggers: [], runs: [] };
}

export const REFUSAL_CODES = [
  "UNKNOWN_OBJECT",
  "UNKNOWN_FIELD",
  "CONFLICT",
  "PARENT_CYCLE",
  "FOLLOWUP_NEEDS_DATE",
  "DELETE_TAUGHT",
  "RUN_ACTIVE",
  "BAD_MIRROR_KIND",
  // granular validation classes (split out of the old overloaded VALIDATION_ERROR)
  "INVALID_STATUS",
  "INVALID_CRON",
  "INVALID_TIMEZONE",
  "INVALID_REFERENCE",
  "ASSIGNEE_NOT_DISPATCHABLE",
  "TERMINAL_TASK",
  "GOAL_NEEDS_NOTE",
  "NO_OP",
  // run lifecycle (run-claim / run-finish)
  "UNKNOWN_RUN",
  "RUN_NOT_CLAIMABLE",
  "RUN_NOT_ACTIVE",
  "INVALID_OUTCOME",
  // wire-shape guard: a non-object command, or an unknown op verb. decide is
  // the authority-side wire validator and the remote driver POSTs raw Commands,
  // so a malformed envelope must refuse, never throw or return undefined.
  "UNKNOWN_COMMAND",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Typed, never thrown. */
export interface Refusal {
  code: RefusalCode;
  message: string;
  issues?: string[];
  hint?: string;
}

export type Decision =
  | {
      ok: true;
      changeset: Changeset;
      /** Human-facing echoes the CLI must print loudly (e.g. "re-armed cron …"). */
      notices: string[];
      result?: { id: string; existing?: boolean };
    }
  | { ok: false; refusal: Refusal };

export function refuse(
  code: RefusalCode,
  message: string,
  extra?: { issues?: string[]; hint?: string },
): Decision {
  return { ok: false, refusal: { code, message, ...extra } };
}
