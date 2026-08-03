/**
 * THE KERNEL — the single server-side seam every object mutation flows through.
 *
 * Three entry points, one rule underneath all of them (spec §4): **status changes
 * only through the single transition function — one code exit — and every
 * mutation writes its event, with field-level `{old,new}`, in the same
 * transaction as the mutation**. There is no path in the server that updates an
 * object without an event, and none that writes an event describing a change
 * that did not commit.
 *
 *   `createObject`    — insert (or resolve a key collision) + `object-created`
 *   `applyUpdate`     — content/facet fields + `object-updated`, never `status`
 *   `applyTransition` — THE status write: close / pause / auto-pause / resume /
 *                       retire, each guarded by kind and from-state
 *
 * WHAT THIS UNIT DELIBERATELY DOES NOT DO. There is no HTTP surface, no CLI, no
 * verdict, no scheduler tick and no claim loop — those are units 3 and 4. The
 * verdict's R-answer insertion (§4.2) and the failure backoff (§6.6) will COMPOSE
 * from here: both are one transaction that calls a transition plus a queue write,
 * which is why every function below also has an `…In(tx, …)` form.
 *
 * OPERATIONAL DISCIPLINES honored here:
 *  - THE KERNEL NEVER READS A CLOCK. `now` is a required input on every call, read
 *    at the route and passed down (spec §4 header). That is what makes history
 *    seedable and tests deterministic.
 *  - PER-OBJECT SERIAL APPLICATION. The row is read `FOR UPDATE` as the FIRST
 *    statement, before any guard runs, so two mutations racing on one object
 *    serialize and the second re-validates against the committed result rather
 *    than racing it. A mutation legal when requested but illegal against the
 *    state that actually exists is REFUSED, never applied over the top.
 *  - EVERY REFUSAL IS A TYPED RESULT (`{ok:false, code, message, issues, hint}`,
 *    spec §3.1) and is logged at warn level — loud, attributable, never swallowed.
 *    There is NO retry in here: a lost race and a stale guard are decisions for
 *    the caller to make with the code in hand. Retrying inside the seam would
 *    silently re-run guards against a moved world.
 *  - REFUSAL CARRIES TEACHING. `hint` names the legal move (design §8: "the CLI
 *    is a teacher, not a gatekeeper" — the server produces the teaching, the CLI
 *    only renders it).
 *
 * DB-LEVEL ENFORCEMENT of the chokepoint (making a direct `UPDATE objects SET
 * status` physically impossible via a trigger token or a column grant) stays
 * deprioritized per the standing decision, exactly as design §2 invariant 2
 * words it: "by convention in v1 — one code exit". The floor that IS welded is
 * the schema's three kind-firewall CHECKs plus the events payload-sufficiency
 * CHECK (`db/kernel-schema.ts`).
 */
import { db } from "../db/index.js";
import type { KernelEvent, KernelObject, NewKernelObject } from "../db/kernel-schema.js";
import * as kernel from "../db/kernelStore.js";
import type { KernelExec } from "../db/kernelStore.js";
import { logger } from "../logger.js";
import { createdEventId, derivedEventId, msOf, newObjectId, organicEventId } from "./ids.js";
import { nextOccurrenceAfter } from "./schedule.js";
import {
  INITIAL_STATUS,
  STATUSES_BY_KIND,
  TRANSITIONS,
  firewallHint,
  firewallIssues,
  hasOpenQuestion,
  immutableIssues,
  isTransitionName,
  refuse,
  type Actor,
  type EventDiff,
  type KernelRefusal,
  type ObjectKind,
  type TransitionName,
  type TransitionSpec,
} from "./types.js";

// ---- the writable field surface ----

/**
 * Every column a caller may set through the kernel. `status`, `kind`, `key`,
 * `teamId` and the timestamps are absent by construction: the first moves only
 * through a transition, the rest are fixed at creation.
 */
export interface WritableFields {
  title?: string | null;
  body?: string | null;
  payload?: Record<string, unknown> | null;
  // loop facets
  cron?: string | null;
  timezone?: string | null;
  nextFire?: string | null;
  // task facets
  followUpAt?: string | null;
  pendingQuestion?: string | null;
  watcher?: string | null;
  // doc facet
  format?: string | null;
}

const WRITABLE_KEYS = [
  "title",
  "body",
  "payload",
  "cron",
  "timezone",
  "nextFire",
  "followUpAt",
  "pendingQuestion",
  "watcher",
  "format",
] as const;

/** The fields a key-collision comparison reads (§4.1 `differs`). */
const CONTENT_KEYS = ["title", "body", "payload", "followUpAt", "watcher", "pendingQuestion"] as const;

// ---- results ----

export interface CreateObjectOk {
  ok: true;
  object: KernelObject;
  /** False when the key (or a derived id) already existed — an idempotent
   *  replay, which is a SUCCESS, not a conflict (design §8, spec §4.1). */
  created: boolean;
  /** The `object-created` event. Present on a real create and on the replay that
   *  resolved to the same row; the event is derived, so it is the same row. */
  event: KernelEvent | null;
  /** Set on a key collision: the submitted content differs from what is stored.
   *  Nothing was applied — idempotent replay is free, silent discard is
   *  forbidden, and those are the two halves of one ruling (spec §4.1). */
  contentDiffers?: boolean;
}

export interface ApplyUpdateOk {
  ok: true;
  object: KernelObject;
  /** False when the patch changed nothing: **a no-op is not a fact**, so no
   *  event is written (spec §4.3). */
  changed: boolean;
  event: KernelEvent | null;
}

export interface ApplyTransitionOk {
  ok: true;
  object: KernelObject;
  event: KernelEvent;
  /** True when the event id already existed: this call was a REPLAY and applied
   *  nothing. The caller's correct response is to carry on — that is dedup
   *  working, not a failure. */
  replay: boolean;
}

export type CreateObjectResult = CreateObjectOk | KernelRefusal;
export type ApplyUpdateResult = ApplyUpdateOk | KernelRefusal;
export type ApplyTransitionResult = ApplyTransitionOk | KernelRefusal;

// ---- inputs ----

export interface CreateObjectInput extends WritableFields {
  teamId: string;
  kind: ObjectKind;
  actor: Actor;
  /** ISO. REQUIRED — the kernel never reads a clock. */
  now: string;
  /** Creation-time idempotency, per team. Omitted ⇒ no idempotency, caller's risk. */
  key?: string | null;
  /** Provenance stamps, pinned at creation (design §10 principle 2). */
  createdByRun?: string | null;
  createdByLoop?: string | null;
  /** An explicit DERIVED id (a run's report doc, the auto-pause question). Omitted
   *  ⇒ an organic `<kind>-<ulid>`. */
  id?: string;
  /**
   * Initial status, when it is not the kind's default. The ONLY caller is the
   * production-loop migration, which imports loops that are already paused or
   * retired — synthesizing an `active → paused` transition for them would write a
   * fact that never happened. Validated against the kind's status set; the DDL's
   * `objects_closed_pair` CHECK is the floor underneath it.
   *
   * Creation is NOT a transition (the object has no prior state to guard), so
   * setting it here does not weaken "status CHANGES only through one code exit".
   */
  status?: string;
}

export interface ApplyUpdateInput {
  objectId: string;
  actor: Actor;
  now: string;
  fields: WritableFields;
  /** Free text recorded on the event (an attestation, a reason). Never parsed. */
  note?: string | null;
  /** Override the event kind — `question-withdrawn`, `charter-evolved`,
   *  `loop-updated`. Defaults to `object-updated`. */
  eventKind?: string;
  /** Extra event payload (a resolved approval block). */
  eventPayload?: Record<string, unknown>;
}

export interface ApplyTransitionInput {
  objectId: string;
  transition: TransitionName;
  actor: Actor;
  now: string;
  note?: string | null;
  eventPayload?: Record<string, unknown>;
  /**
   * IDEMPOTENCY. Supply a seed when this transition is RE-DERIVABLE — the
   * circuit breaker's auto-pause on a retried `finish`, a replayed sweep. The
   * event id becomes a pure function of the seed, so a second derivation collides
   * on the primary key and the whole transition is a no-op replay.
   *
   * Omit it for an ORGANIC occurrence (a human pausing a loop, an agent closing a
   * task): the event gets a ULID and is never deduplicated. A window is never a
   * dedup key.
   */
  derivedFrom?: unknown;
}

// ---- refusal helper ----

function fail(r: KernelRefusal, ctx: Record<string, unknown>): KernelRefusal {
  logger.warn({ code: r.code, ...ctx }, `kernel refused: ${r.message}`);
  return r;
}

// ---- pure helpers (exported for direct unit testing) ----

/** Structural equality over JSON-able values; `null` and `undefined` are one. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * PAYLOAD SUFFICIENCY. Build the per-field `{old,new}` diff over EXACTLY the
 * fields a write changes. Unchanged fields are omitted: the diff answers "what
 * changed", and a field listed with old === new would be noise that erodes the
 * very sufficiency this guarantees.
 */
export function buildFieldDiff(before: Record<string, unknown>, fields: Record<string, unknown>): EventDiff {
  const diff: EventDiff = {};
  for (const [k, next] of Object.entries(fields)) {
    if (next === undefined) continue;
    const prev = before[k] ?? null;
    if (!sameValue(prev, next)) diff[k] = { old: prev ?? null, new: next ?? null };
  }
  return diff;
}

/** The submitted-vs-stored comparison of §4.1. PURE — a read, never a write. */
export function contentDiffers(stored: KernelObject, submitted: WritableFields): boolean {
  const before = stored as unknown as Record<string, unknown>;
  for (const k of CONTENT_KEYS) {
    const next = (submitted as Record<string, unknown>)[k];
    if (next === undefined) continue;
    if (!sameValue(before[k] ?? null, next ?? null)) return true;
  }
  return false;
}

/** The subset of `fields` that is actually present (so the firewall and the diff
 *  only ever see keys the caller meant to write). */
function presentFields(fields: WritableFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WRITABLE_KEYS) {
    const v = (fields as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A facet that is being CLEARED (set to null) never trips the firewall — writing
 *  `cron: null` on a task is a no-op, not an attempt to give a task a cadence. */
function assertedFields(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((k) => fields[k] !== null);
}

// ---- create ----

export async function createObject(input: CreateObjectInput): Promise<CreateObjectResult> {
  return db.transaction(async (tx) => createObjectIn(tx as unknown as KernelExec, input));
}

/**
 * §4.1, verbatim: insert with `ON CONFLICT DO NOTHING`; on a swallow, resolve the
 * existing row, refuse only a KIND mismatch, and report whether the submitted
 * content differs — **the comparison is a read, not a write**. Same key ⇒ 200
 * with the existing object, never a 409: the conflict is swallowed at the unique
 * index, not surfaced.
 */
export async function createObjectIn(tx: KernelExec, input: CreateObjectInput): Promise<CreateObjectResult> {
  const { teamId, kind, actor, now } = input;
  const where = { teamId, kind, key: input.key ?? null };

  const fields = presentFields(input);
  const issues = firewallIssues(kind, assertedFields(fields));
  if (issues.length) {
    return fail(
      refuse("WRONG_KIND", `a ${kind} cannot carry ${issues.map((i) => i.path).join(", ")}`, issues, firewallHint(kind)),
      where,
    );
  }

  const status = input.status ?? INITIAL_STATUS[kind];
  if (!STATUSES_BY_KIND[kind].includes(status)) {
    return fail(
      refuse(
        "SCHEMA_VIOLATION",
        `"${status}" is not a status a ${kind} can hold`,
        [{ path: "status", message: "unknown status", got: status, expected: STATUSES_BY_KIND[kind].join("|") }],
        `a ${kind} is one of: ${STATUSES_BY_KIND[kind].join(", ")}`,
      ),
      where,
    );
  }

  const id = input.id ?? newObjectId(kind, msOf(now));
  const row: NewKernelObject = {
    id,
    teamId,
    kind,
    status,
    title: input.title ?? null,
    cron: input.cron ?? null,
    timezone: input.timezone ?? null,
    nextFire:
      input.nextFire !== undefined
        ? input.nextFire
        : kind === "loop" && status === "active" && input.cron
          ? nextOccurrenceAfter(input.cron, input.timezone ?? null, now)
          : null,
    followUpAt: input.followUpAt ?? null,
    pendingQuestion: input.pendingQuestion ?? null,
    watcher: input.watcher ?? null,
    format: input.format ?? null,
    key: input.key ?? null,
    payload: input.payload ?? null,
    body: input.body ?? null,
    createdByRun: input.createdByRun ?? null,
    createdByLoop: input.createdByLoop ?? null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };

  const { object, inserted } = await kernel.insertObject(tx, row);

  if (!inserted) {
    // The insert was swallowed. Either the key collided (idempotent re-create) or
    // the explicit derived id already existed (a replayed derivation).
    const found =
      (input.key ? await kernel.getObjectByKey(tx, teamId, input.key) : undefined) ??
      (await kernel.getObject(tx, id));
    if (!found) {
      // Only reachable if the row vanished between the swallow and this read.
      return fail(refuse("NOT_FOUND", "the conflicting object could not be resolved", []), where);
    }
    if (found.kind !== kind) {
      return fail(
        refuse(
          "KEY_KIND_MISMATCH",
          `key "${input.key}" already names a ${found.kind} in this team`,
          [{ path: "key", message: `already used by a ${found.kind}`, got: input.key ?? "", expected: kind }],
          `pick a different key, or address the existing ${found.kind} by its id (${found.id})`,
        ),
        where,
      );
    }
    return {
      ok: true,
      object: found,
      created: false,
      event: (await kernel.getEvent(tx, createdEventId(found.id))) ?? null,
      contentDiffers: contentDiffers(found, input),
    };
  }

  // The creation event's id is DERIVED FROM THE RESULTING OBJECT ID, so even a
  // racing double-create writes exactly one `object-created` row. A born-gated
  // task (created WITH a question) records it in this same event's diff — it is
  // not a second transition (§4.1).
  const diff: EventDiff = {};
  if (hasOpenQuestion(row.pendingQuestion)) diff.pendingQuestion = { old: null, new: row.pendingQuestion };

  const { event } = await kernel.appendEvent(tx, {
    id: createdEventId(id),
    teamId,
    objectId: id,
    kind: "object-created",
    origin: "derived",
    entrance: actor.entrance,
    actorId: actor.actorId,
    transition: null,
    diff: Object.keys(diff).length ? diff : null,
    note: null,
    payload: { kind, status: row.status },
    ts: now,
  });

  return { ok: true, object: object!, created: true, event };
}

// ---- update ----

export async function applyUpdate(input: ApplyUpdateInput): Promise<ApplyUpdateResult> {
  return db.transaction(async (tx) => applyUpdateIn(tx as unknown as KernelExec, input));
}

/**
 * §4.3's shape, minus the status half: lock, guard by kind, diff over exactly the
 * fields this write changes, refuse nothing silently, and write the event in the
 * same transaction. An empty diff commits with `changed: false` and NO event —
 * two identical patches are one fact, and a no-op is not a fact at all.
 */
export async function applyUpdateIn(tx: KernelExec, input: ApplyUpdateInput): Promise<ApplyUpdateResult> {
  const { objectId, actor, now } = input;
  const where = { objectId };

  const before = await kernel.getObjectForUpdate(tx, objectId);
  if (!before) return fail(refuse("NOT_FOUND", `no object ${objectId}`, []), where);

  // Double-cover the human-only question-clear at the kernel boundary. Replacing
  // a live question is a clear in disguise: it discards what a person may be
  // reading. The HTTP seam performs the same early guard for a richer refusal.
  if (
    before.kind === "task" &&
    hasOpenQuestion(before.pendingQuestion) &&
    input.fields.pendingQuestion !== undefined &&
    input.fields.pendingQuestion !== before.pendingQuestion &&
    actor.entrance !== "human"
  ) {
    return fail(
      refuse(
        "NOT_HUMAN",
        "a run cannot clear or replace a pending question",
        [{ path: "pendingQuestion", message: "only a human may clear or replace it", got: String(input.fields.pendingQuestion) }],
        "a human answers it in the inbox; an agent may update fields that do not discard the question",
      ),
      where,
    );
  }

  // Identity and status are not patchable — a content write can never smuggle a
  // state change (the failure class the single code exit exists to eliminate).
  const immutable = immutableIssues(Object.keys(input.fields));
  if (immutable.length) {
    return fail(
      refuse(
        "IMMUTABLE_KEY",
        `${immutable.map((i) => i.path).join(", ")} cannot be changed by an update`,
        immutable,
        immutable.some((i) => i.path === "status")
          ? "status moves through a transition: close a task, pause/resume/retire a loop"
          : "create a new object instead",
      ),
      where,
    );
  }

  const fields = presentFields(input.fields);
  const issues = firewallIssues(before.kind, assertedFields(fields));
  if (issues.length) {
    return fail(
      refuse(
        "WRONG_KIND",
        `a ${before.kind} cannot carry ${issues.map((i) => i.path).join(", ")}`,
        issues,
        firewallHint(before.kind),
      ),
      where,
    );
  }

  // A closed task is done. Reopening is not a v1 transition, so mutating one is a
  // refusal with a name rather than a silent write into a settled record.
  if (before.kind === "task" && before.status === "closed") {
    return fail(
      refuse("CLOSED", `task ${objectId} is closed`, [{ path: "status", message: "closed", got: "closed" }], "closed tasks are a record; create a new task for new work"),
      where,
    );
  }

  const diff = buildFieldDiff(before as unknown as Record<string, unknown>, fields);
  if (!Object.keys(diff).length) return { ok: true, object: before, changed: false, event: null };

  const after = (await kernel.updateObjectFields(tx, objectId, { ...fields, updatedAt: now }))!;

  // Update events are ORGANIC: two identical-looking patches a week apart are two
  // real facts, and deduplicating them would erase history (spec §4.3).
  const { event } = await kernel.appendEvent(tx, {
    id: organicEventId(msOf(now)),
    teamId: before.teamId,
    objectId,
    kind: input.eventKind ?? "object-updated",
    origin: "organic",
    entrance: actor.entrance,
    actorId: actor.actorId,
    transition: null,
    diff,
    note: input.note ?? null,
    payload: input.eventPayload ?? null,
    ts: now,
  });

  return { ok: true, object: after, changed: true, event };
}

// ---- the status write ----

export async function applyTransition(input: ApplyTransitionInput): Promise<ApplyTransitionResult> {
  return db.transaction(async (tx) => applyTransitionIn(tx as unknown as KernelExec, input));
}

/**
 * THE ONE CODE EXIT for `objects.status`.
 *
 * Guard order is deliberate and is the contract:
 *   1. lock the row (serialize concurrent writers);
 *   2. replay latch, ahead of every guard — a re-derivable transition whose event
 *      already exists is a re-delivery of work that ALREADY landed. It has to be
 *      checked before the from-state guard, or the first application's own status
 *      move would make the guard (correctly, but uselessly) refuse the replay,
 *      turning every retry into a spurious refusal;
 *   3. KIND FIREWALL — `close` refuses a loop by name, with the legal move
 *      (pause/retire) in the hint (design §4 rule 2);
 *   4. from-state;
 *   5. ATTESTED CLOSE — refused while `pending_question` is non-empty (§3.4);
 *   6. the event first, then the status, both in this transaction.
 */
export async function applyTransitionIn(tx: KernelExec, input: ApplyTransitionInput): Promise<ApplyTransitionResult> {
  const { objectId, transition, actor, now } = input;
  const where = { objectId, transition };

  const before = await kernel.getObjectForUpdate(tx, objectId);
  if (!before) return fail(refuse("NOT_FOUND", `no object ${objectId}`, []), where);

  // Widened deliberately: the type says this is a legal name, but the value can
  // arrive from a wire body in unit 4, so the guard is a real runtime check.
  const name: string = transition;
  if (!isTransitionName(name)) {
    return fail(
      refuse(
        "UNKNOWN_TRANSITION",
        `"${name}" is not a transition`,
        [{ path: "transition", message: "unknown", got: name }],
        `legal transitions: ${Object.keys(TRANSITIONS).join(", ")}`,
      ),
      where,
    );
  }
  const spec: TransitionSpec = TRANSITIONS[transition];

  const eventId =
    input.derivedFrom === undefined
      ? organicEventId(msOf(now))
      : derivedEventId({ objectId, transition, seed: input.derivedFrom });
  if (input.derivedFrom !== undefined) {
    const prior = await kernel.getEvent(tx, eventId);
    if (prior) return { ok: true, object: before, event: prior, replay: true };
  }

  // KIND FIREWALL. A loop's lifecycle is operational — `close` does not apply to
  // it, and saying so by name (with the legal move) is the whole point of the
  // teaching refusal.
  if (before.kind !== spec.kind) {
    return fail(
      refuse(
        "WRONG_KIND",
        `${transition} applies to a ${spec.kind}, and ${objectId} is a ${before.kind}`,
        [{ path: "kind", message: `${transition} is a ${spec.kind} transition`, got: before.kind, expected: spec.kind }],
        before.kind === "loop"
          ? "loops do not close — pause or retire instead"
          : `only a ${spec.kind} can be ${transition}d`,
      ),
      where,
    );
  }

  if (!spec.from.includes(before.status)) {
    return fail(
      refuse(
        "ILLEGAL_FROM_STATE",
        `${transition} cannot run from "${before.status}"`,
        [{ path: "status", message: "illegal source state", got: before.status, expected: spec.from.join("|") }],
        `${transition} runs from: ${spec.from.join(", ")}`,
      ),
      where,
    );
  }

  // ATTESTED CLOSE (design §3): a task is refused while a question is waiting for
  // a human. Closing EARLY (before `follow_up_at`) stays legal — that date is a
  // resurface schedule, not an obligation to wait — so the only close guard is
  // the question.
  if (spec.to === "closed" && hasOpenQuestion(before.pendingQuestion)) {
    return fail(
      refuse(
        "OPEN_QUESTION",
        `${objectId} cannot be closed while a question is waiting for a human`,
        [{ path: "pendingQuestion", message: "must be empty to close", got: before.pendingQuestion ?? "" }],
        `a human answers it at POST /api/tasks/${objectId}/verdict; after that the task closes normally`,
      ),
      where,
    );
  }

  const diff: EventDiff = { status: { old: before.status, new: spec.to } };
  const patch: { status: string; updatedAt: string; closedAt?: string | null; nextFire?: string | null } = {
    status: spec.to,
    updatedAt: now,
  };
  if (before.kind === "task") {
    // The `objects_closed_pair` CHECK pairs the stamp with the status, so this is
    // not bookkeeping the caller could forget — an unpaired write cannot commit.
    patch.closedAt = spec.to === "closed" ? now : null;
    diff.closedAt = { old: before.closedAt ?? null, new: patch.closedAt };
  }
  if (before.kind === "loop" && spec.to !== "active" && before.nextFire !== null) {
    // A paused or retired loop is DISARMED: the cursor is what makes a cadence
    // live, so leaving it set would let the tick fire a loop the system stopped.
    patch.nextFire = null;
    diff.nextFire = { old: before.nextFire, new: null };
  }
  if (before.kind === "loop" && spec.to === "active" && before.cron) {
    patch.nextFire = nextOccurrenceAfter(before.cron, before.timezone, now);
    diff.nextFire = { old: before.nextFire, new: patch.nextFire };
  }

  // The event lands FIRST. The latch above catches the ordinary replay; this
  // insert is its race-safe backstop — a re-derived transition mints the same id,
  // the conflict is swallowed, and we return before touching the status, so a
  // replay can never double-apply even if two derivations arrive in one instant.
  const { event, inserted } = await kernel.appendEvent(tx, {
    id: eventId,
    teamId: before.teamId,
    objectId,
    kind: spec.eventKind,
    origin: input.derivedFrom === undefined ? "organic" : "derived",
    entrance: actor.entrance,
    actorId: actor.actorId,
    // NOT NULL for a status diff, enforced by `events_state_change_sufficient`.
    transition,
    diff,
    note: input.note ?? null,
    payload: { from: before.status, to: spec.to, ...(input.eventPayload ?? {}) },
    ts: now,
  });
  if (!inserted) {
    return { ok: true, object: (await kernel.getObject(tx, objectId))!, event, replay: true };
  }

  const after = await kernel.setObjectStatus(tx, objectId, patch);
  return { ok: true, object: after, event, replay: false };
}
