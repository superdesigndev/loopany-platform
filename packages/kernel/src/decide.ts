/**
 * decide(command, snapshot, actor, now) -> Decision — the ONE write chokepoint.
 *
 * Pure: no I/O, no clock reads (now is a parameter), no randomness (ids are
 * derived). Every invariant, every event, every trigger side effect and every
 * run-record creation lives here and only here, so the local driver and the
 * loopany server cannot drift: both execute this same function at their
 * authority.
 *
 * Malformed input NEVER throws — every bad field, cron, timezone or reference
 * becomes a typed Refusal (§9). Trigger finalization is computed ONCE per
 * changeset (`finalizeTriggers`), keyed off the task's FINAL status, so a
 * trigger id appears at most once and a terminal task's schedule is always
 * disabled regardless of how it got there (create-with-terminal, cron-update
 * on a terminal task, or a status transition).
 */
import { Cron } from "croner";
import {
  ACTIVE_RUN_STATES,
  type Changeset,
  type Command,
  type CreateCommand,
  type Decision,
  type DocPutCommand,
  type KernelEvent,
  type KernelObject,
  type MirrorAddCommand,
  MIRROR_KINDS,
  type NoteCommand,
  type ObjectMutation,
  type Provenance,
  type RefusalCode,
  type RunClaimCommand,
  type RunCommand,
  type RunFinishCommand,
  type RunRecord,
  type RunState,
  type Snapshot,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type TaskObject,
  type TaskStatus,
  type Trigger,
  type TriggerMutation,
  type UpdateCommand,
  emptyChangeset,
  isTerminal,
  refuse,
} from "./types.js";
import { cronTriggerId, eventId, mirrorId, onceTriggerId, runId, slugify } from "./ids.js";

const PARENT_MAX_HOPS = 64;

/** Editable task fields — an unknown key is refused listing this set. */
export const EDITABLE_TASK_FIELDS = [
  "title",
  "status",
  "assignee",
  "priority",
  "type",
  "parent",
  "tracks",
  "refs",
  "body",
  "followUpAt",
  "owner",
  "workdir",
  "goal",
  "cron",
  "timezone",
] as const;

/** The kernel's one addressing heuristic: an email is a person (inbox),
 *  anything else is an agent/loop name (dispatchable). Resolution beyond
 *  this is the driver's job. */
export function isPersonAssignee(assignee: string): boolean {
  return assignee.includes("@");
}

/** An assignee a dispatch can actually target: a non-empty, non-person name. */
export function isDispatchable(assignee: string | null): boolean {
  return assignee !== null && assignee.length > 0 && !isPersonAssignee(assignee);
}

/** workdir must be an ABSOLUTE machine-local path (loops usually work inside
 *  another project's checkout). Relative segments would silently anchor to
 *  whatever cwd the daemon happens to run from. */
function workdirRefusal(workdir: string | null): Decision | null {
  if (workdir === null) return null;
  if (!workdir.startsWith("/") || workdir.split("/").includes("..")) {
    return refuse("INVALID_REFERENCE", `workdir must be an absolute path (got "${workdir}")`);
  }
  return null;
}

export function activeRun(snapshot: Snapshot, taskId: string): RunRecord | undefined {
  return snapshot.runs.find((r) => r.taskId === taskId && ACTIVE_RUN_STATES.includes(r.state));
}

function getObject(snapshot: Snapshot, id: string): KernelObject | undefined {
  return snapshot.objects[id];
}

function getTask(snapshot: Snapshot, id: string): TaskObject | undefined {
  const o = snapshot.objects[id];
  return o?.archetype === "task" ? o : undefined;
}

/** True when some task already points at `id` (refs or tracks). Backs the
 *  island warning on doc-put/mirror-add: an unattached artifact is invisible
 *  from every task page, so the writer should hear it at write time. */
function anyTaskPointsAt(snapshot: Snapshot, id: string): boolean {
  return Object.values(snapshot.objects).some(
    (o) => o.archetype === "task" && (o.refs.includes(id) || o.tracks === id),
  );
}

// ---- cron / timezone validation (validated as a PAIR — an invalid tz throws
// in croner, so it must be caught alongside the spec, never separately) ----

function validTimezone(timezone: string): boolean {
  try {
    // croner's constructor does NOT validate the zone — only a date conversion
    // does. A bare, always-valid minute cron isolates the tz check from the spec.
    new Cron("* * * * *", { timezone }).nextRun(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function validCron(spec: string, timezone: string | null): boolean {
  try {
    const cron = new Cron(spec, timezone ? { timezone } : undefined);
    // Force a date computation so an invalid tz (lazy-thrown by croner) is caught.
    cron.nextRun(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function cronNextFire(spec: string, timezone: string | null, after: string): string | null {
  try {
    const cron = new Cron(spec, timezone ? { timezone } : undefined);
    const next = cron.nextRun(new Date(after));
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Refuse a cron/timezone pair; returns the granular Refusal or null if valid. */
function cronPairRefusal(spec: string, timezone: string | null): Decision | null {
  if (timezone !== null && !validTimezone(timezone)) {
    return refuse("INVALID_TIMEZONE", `invalid timezone "${timezone}"`);
  }
  if (!validCron(spec, timezone)) {
    return refuse("INVALID_CRON", `invalid cron "${spec}"`);
  }
  return null;
}

/** Walk ancestors from `parent`; refuse a cycle through `taskId`. */
function parentCycleIssue(snapshot: Snapshot, taskId: string, parent: string): string | null {
  let cursor: string | null = parent;
  let hops = 0;
  while (cursor) {
    if (cursor === taskId) return `parent chain cycles back to "${taskId}"`;
    if (++hops > PARENT_MAX_HOPS) return `parent chain exceeds ${PARENT_MAX_HOPS} hops`;
    cursor = getTask(snapshot, cursor)?.parent ?? null;
  }
  return null;
}

interface Ctx {
  snapshot: Snapshot;
  actor: Provenance;
  now: string;
}

// ---- shared task-write helpers ----

function softVocabularyNotices(task: Pick<TaskObject, "type" | "priority">): string[] {
  const notices: string[] = [];
  if (task.type && !(TASK_TYPES as readonly string[]).includes(task.type)) {
    notices.push(`type "${task.type}" is outside the suggested vocabulary (${TASK_TYPES.join("|")}) — stored verbatim`);
  }
  if (task.priority && !(TASK_PRIORITIES as readonly string[]).includes(task.priority)) {
    notices.push(`priority "${task.priority}" is outside P0..P3 — stored verbatim`);
  }
  return notices;
}

function referenceIssues(snapshot: Snapshot, taskId: string, parent: string | null, tracks: string | null): string[] {
  const issues: string[] = [];
  if (parent) {
    const target = getObject(snapshot, parent);
    if (!target) issues.push(`parent "${parent}" does not exist`);
    else if (target.archetype !== "task") issues.push(`parent "${parent}" is a ${target.archetype}, not a task`);
    else {
      const cycle = parentCycleIssue(snapshot, taskId, parent);
      if (cycle) issues.push(cycle);
    }
  }
  if (tracks) {
    const target = getObject(snapshot, tracks);
    if (!target) issues.push(`tracks "${tracks}" does not exist`);
    else if (target.archetype === "task") issues.push(`tracks must point at a doc or mirror, not a task`);
  }
  return issues;
}

/** The task's DESIRED cron trigger after the command, as if the task were
 *  non-terminal. Null = no cron trigger should exist (never armed, or
 *  owner-disarmed). This is the SINGLE cron decision; terminality is layered
 *  on top by finalizeTriggers, never re-decided. */
interface CronIntent {
  spec: string;
  timezone: string | null;
}

/** Compute the FINAL trigger mutations for a task in one place, keyed off the
 *  task's final status. This is the single source shared by create and update,
 *  so invariants #2 / #2' cannot drift and every trigger id appears at most
 *  once (last-write-wins can never resurrect a stale spec — finding #1).
 *
 *  - cronIntent: the desired cron after the command (null = none should exist).
 *  - a terminal task's cron is ALWAYS disabled (enabled=false, invariant).
 *  - a non-terminal task's cron is enabled with a fresh nextFireAt, UNLESS the
 *    owner disarmed it (which the caller expresses as cronIntent=null + an
 *    explicit delete), so leaving terminal re-arms invariant pauses but never
 *    an owner disarm (#2').
 *  - the once slot mirrors `after.followUpAt` exactly (value IS the generation).
 */
function sameTrigger(a: Trigger, b: Trigger): boolean {
  return (
    a.id === b.id &&
    a.spec === b.spec &&
    a.timezone === b.timezone &&
    a.enabled === b.enabled &&
    a.disabledBy === b.disabledBy &&
    a.nextFireAt === b.nextFireAt
  );
}

function finalizeTriggers(
  after: TaskObject,
  existing: readonly Trigger[],
  cronIntent: CronIntent | null,
  now: string,
  cronExplicitEdit: boolean,
): { mutations: TriggerMutation[]; notices: string[] } {
  const mutations: TriggerMutation[] = [];
  const notices: string[] = [];
  const terminal = isTerminal(after.status);
  const cronExisting = existing.find((t) => t.kind === "cron");
  const onceExisting = existing.find((t) => t.kind === "once");

  // An owner-paused cron (disabledBy="owner") is NEVER auto-revived (invariant
  // #2') and NEVER re-stamped by invariant #2 — it stays exactly as the owner
  // left it. Only an explicit owner cron edit (patch.cron set) may re-arm it.
  // Without this, the carried-intent path (an unrelated update carries the
  // existing cron as intent) would flip enabled=true / disabledBy=null. Emit
  // nothing so the row is preserved verbatim.
  if (cronExisting?.disabledBy === "owner" && !cronExplicitEdit) {
    // Fall through to the once handling; the cron is left untouched.
  } else if (cronIntent !== null) {
    const specChanged =
      !cronExisting || cronExisting.spec !== cronIntent.spec || cronExisting.timezone !== cronIntent.timezone;
    // Recompute the cursor only when the spec/tz changed or we are (re)arming a
    // disabled cron; an unchanged, still-enabled cron keeps its nextFireAt so a
    // plain edit never disturbs the schedule (and stays a NO_OP where it should).
    const nextFireAt = terminal
      ? cronExisting?.nextFireAt ?? null
      : specChanged || !cronExisting?.enabled
        ? cronNextFire(cronIntent.spec, cronIntent.timezone, now)
        : cronExisting.nextFireAt;
    const desired: Trigger = {
      id: cronTriggerId(after.id),
      taskId: after.id,
      kind: "cron",
      spec: cronIntent.spec,
      timezone: cronIntent.timezone,
      enabled: !terminal,
      disabledBy: terminal ? "invariant" : null,
      nextFireAt,
    };
    // Skip the mutation entirely when nothing about the cron changed (keeps the
    // NO_OP guard honest for plain edits on a loop). The CAS precondition is the
    // cron we READ (null = arming a fresh one) — a stale put over a newer cron
    // conflicts at the fold instead of reverting it.
    if (!cronExisting || !sameTrigger(cronExisting, desired)) {
      mutations.push({ op: "put", trigger: desired, expected: cronExisting ?? null });
    }
    if (specChanged) {
      notices.push(`armed cron "${cronIntent.spec}" — this task is a loop`);
    }
    if (terminal && cronExisting?.enabled) {
      notices.push(`paused cron "${cronIntent.spec}" (invariant #2)`);
    }
    if (!terminal && cronExisting && !cronExisting.enabled && cronExisting.disabledBy === "invariant") {
      notices.push(`re-armed cron "${cronIntent.spec}" (invariant #2')`);
    }
  }
  // cronIntent === null with an existing cron is an owner disarm: the caller
  // emits the explicit delete, so nothing to do here.

  // ---- once (single slot; mirrors after.followUpAt, the generation) ----
  const wantOnce = after.followUpAt !== null && !terminal;
  if (wantOnce) {
    if (!onceExisting || onceExisting.spec !== after.followUpAt || !onceExisting.enabled) {
      mutations.push({
        op: "put",
        trigger: {
          id: onceTriggerId(after.id),
          taskId: after.id,
          kind: "once",
          spec: after.followUpAt as string,
          timezone: null,
          enabled: true,
          disabledBy: null,
          nextFireAt: after.followUpAt,
        },
        expected: onceExisting ?? null,
      });
    }
  } else if (onceExisting) {
    // Slot cleared (left follow-up) or terminal — the once trigger is gone.
    mutations.push({ op: "delete", id: onceExisting.id, expected: onceExisting });
  }

  return { mutations, notices };
}

function assignmentRunMutation(
  ctx: Ctx,
  task: TaskObject,
  previouslyEligible: boolean,
  /** A run this changeset is ALREADY superseding - the snapshot still holds it,
   *  so the active-run guard must look past it (the assignee-handoff path). */
  supersededRunId?: string,
): Changeset["runs"] {
  const eligible = task.status === "todo" && isDispatchable(task.assignee);
  if (!eligible || previouslyEligible) return [];
  const open = activeRun(ctx.snapshot, task.id);
  if (open && open.id !== supersededRunId) return [];
  return [
    {
      op: "insert",
      run: {
        id: runId("assignment", task.id, ctx.now),
        taskId: task.id,
        cause: "assignment",
        scheduledAt: ctx.now,
        state: "pending",
        assignee: task.assignee,
        triggerId: null,
        createdAt: ctx.now,
      },
    },
  ];
}

function taskEligible(task: TaskObject): boolean {
  return task.status === "todo" && isDispatchable(task.assignee);
}

// ---- create ----

/** Guard a wire value that MUST be a string before it reaches string ops
 *  (slugify/.trim/.toLowerCase/Buffer.byteLength) — decide is the authority-side
 *  wire validator and NEVER throws on malformed JSON (spec §9). */
function requireString(value: unknown, field: string, code: RefusalCode): Decision | null {
  if (typeof value !== "string") {
    return refuse(code, `"${field}" must be a string`, { issues: [`got ${value === null ? "null" : typeof value}`] });
  }
  return null;
}

function decideCreate(cmd: CreateCommand, ctx: Ctx): Decision {
  const { snapshot, actor, now } = ctx;
  // Validate wire VALUES before any string op or verbatim copy into the object.
  const titleBad = requireString(cmd.title, "title", "INVALID_REFERENCE");
  if (titleBad) return titleBad;
  for (const [k, v] of [
    ["id", cmd.id],
    ["assignee", cmd.assignee],
    ["priority", cmd.priority],
    ["type", cmd.type],
    ["parent", cmd.parent],
    ["tracks", cmd.tracks],
    ["body", cmd.body],
  ] as const) {
    if (v !== undefined) {
      const bad = requireString(v, k, "INVALID_REFERENCE");
      if (bad) return bad;
    }
  }
  if (cmd.refs !== undefined && (!Array.isArray(cmd.refs) || !cmd.refs.every((r) => typeof r === "string"))) {
    return refuse("INVALID_REFERENCE", `"refs" must be a string array`);
  }
  if (cmd.cron !== undefined) {
    const bad = requireString(cmd.cron, "cron", "INVALID_CRON");
    if (bad) return bad;
  }
  if (cmd.timezone !== undefined) {
    const bad = requireString(cmd.timezone, "timezone", "INVALID_TIMEZONE");
    if (bad) return bad;
  }
  const id = cmd.id ?? slugify(cmd.title);
  if (getObject(snapshot, id)) {
    return refuse("CONFLICT", `object "${id}" already exists`, {
      hint: "pick another --id, or update the existing task",
    });
  }

  let status: TaskStatus;
  if (cmd.status !== undefined) {
    if (!(TASK_STATUSES as readonly string[]).includes(cmd.status)) {
      return refuse("INVALID_STATUS", `unknown status "${cmd.status}"`, {
        issues: [`valid statuses: ${TASK_STATUSES.join(" | ")}`],
      });
    }
    status = cmd.status as TaskStatus;
  } else {
    status = cmd.followUpAt !== undefined ? "follow-up" : "todo";
  }

  if (cmd.followUpAt !== undefined && !validInstant(cmd.followUpAt)) {
    return refuse("FOLLOWUP_NEEDS_DATE", `followUpAt "${String(cmd.followUpAt)}" is not a valid instant`);
  }
  // Invariant #1 both directions: follow-up <=> followUpAt.
  if (status === "follow-up" && cmd.followUpAt === undefined) {
    return refuse("FOLLOWUP_NEEDS_DATE", "entering follow-up requires followUpAt", {
      hint: "any wait must carry its revival date",
    });
  }
  if (status !== "follow-up" && cmd.followUpAt !== undefined) {
    return refuse("FOLLOWUP_NEEDS_DATE", "followUpAt only lives on status=follow-up (the waiting state)");
  }
  if (cmd.cron !== undefined) {
    const bad = cronPairRefusal(cmd.cron, cmd.timezone ?? null);
    if (bad) return bad;
  } else if (cmd.timezone !== undefined && !validTimezone(cmd.timezone)) {
    return refuse("INVALID_TIMEZONE", `invalid timezone "${cmd.timezone}"`);
  }

  const task: TaskObject = {
    archetype: "task",
    id,
    title: cmd.title,
    status,
    assignee: cmd.assignee ?? null,
    owner: cmd.owner ?? null,
    priority: cmd.priority ?? null,
    type: cmd.type ?? null,
    parent: cmd.parent ?? null,
    tracks: cmd.tracks ?? null,
    refs: cmd.refs ?? [],
    followUpAt: status === "follow-up" ? (cmd.followUpAt as string) : null,
    workdir: cmd.workdir ?? null,
    goal: cmd.goal ?? null,
    body: cmd.body ?? "",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const workdirIssue = workdirRefusal(task.workdir);
  if (workdirIssue) return workdirIssue;

  const issues = referenceIssues(snapshot, id, task.parent, task.tracks);
  if (issues.length > 0) {
    return issues.some((i) => i.includes("cycle"))
      ? refuse("PARENT_CYCLE", "parent would create a cycle", { issues })
      : refuse("INVALID_REFERENCE", "invalid references", { issues });
  }

  const cs = emptyChangeset();
  const notices = softVocabularyNotices(task);
  cs.objects.push({ object: task, expectedVersion: null });
  cs.events.push({
    id: eventId(id, 1, "created"),
    objectId: id,
    kind: "created",
    at: now,
    note: cmd.title,
    provenance: actor,
  });

  const cronIntent: CronIntent | null =
    cmd.cron !== undefined ? { spec: cmd.cron, timezone: cmd.timezone ?? null } : null;
  // Create never sees a pre-existing owner-paused cron (there is no existing
  // trigger), so the explicit-edit flag is moot; pass true for clarity.
  const { mutations, notices: trigNotices } = finalizeTriggers(task, [], cronIntent, now, true);
  cs.triggers.push(...mutations);
  notices.push(...trigNotices);

  const minted = assignmentRunMutation(ctx, task, false);
  cs.runs.push(...minted);
  // Dispatch-consequence echo (sim seo-scale round 2): the producer of a handoff
  // task could not SEE that its `--status in-progress` made the task invisible to
  // the consumer's pull query — both loops idled honestly for three virtual
  // weeks. Every create now states what it armed: world feedback over prompt
  // discipline (the branch-protection lesson). Cron has its own notice above.
  if (minted.length > 0) {
    notices.push(`dispatching — @${task.assignee} runs this at the next tick`);
  } else if (!cronIntent) {
    if (task.status === "follow-up" && task.followUpAt) {
      notices.push(`sleeps until ${task.followUpAt} (once trigger armed)`);
    } else if (task.status === "todo" && task.assignee === null) {
      notices.push("born todo, unassigned — waits to be CLAIMED (set assignee + status in ONE update)");
    } else if (task.status === "todo") {
      notices.push(`waits on ${task.assignee} (a person — dispatch never targets an inbox)`);
    } else {
      notices.push(`inert — no trigger armed; a "${task.status}" task is never dispatched`);
    }
  }
  return { ok: true, changeset: cs, notices, result: { id } };
}

// ---- update ----

function decideUpdate(cmd: UpdateCommand, ctx: Ctx): Decision {
  const { snapshot, actor, now } = ctx;
  const idBad = requireString(cmd.id, "id", "UNKNOWN_OBJECT");
  if (idBad) return idBad;
  if (cmd.patch === null || typeof cmd.patch !== "object" || Array.isArray(cmd.patch)) {
    return refuse("UNKNOWN_FIELD", `patch must be an object`);
  }
  const before = getTask(snapshot, cmd.id);
  if (!before) {
    const other = getObject(snapshot, cmd.id);
    if (other) {
      return refuse("UNKNOWN_OBJECT", `"${cmd.id}" is a ${other.archetype}; update edits tasks`, {
        hint: other.archetype === "doc" ? "use doc put" : "mirrors are immutable pointers",
      });
    }
    return refuse("UNKNOWN_OBJECT", `no task "${cmd.id}"`);
  }
  if (cmd.ifVersion !== undefined && cmd.ifVersion !== before.version) {
    return refuse("CONFLICT", `version is ${before.version}, expected ${cmd.ifVersion}`, {
      hint: "re-read and retry",
    });
  }

  const unknown = Object.keys(cmd.patch).filter(
    (k) => !(EDITABLE_TASK_FIELDS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    return refuse("UNKNOWN_FIELD", `unknown field(s): ${unknown.join(", ")}`, {
      issues: [`editable fields: ${EDITABLE_TASK_FIELDS.join(", ")}`],
    });
  }

  const patch = cmd.patch as Partial<Record<(typeof EDITABLE_TASK_FIELDS)[number], unknown>>;

  // ---- validate every field value BEFORE constructing `after` (no .includes
  // on a non-string, no bad cron reaching nextFire) ----
  const fieldIssue = validatePatchFields(patch);
  if (fieldIssue) return fieldIssue;
  if (patch.workdir !== undefined) {
    const wd = workdirRefusal(patch.workdir as string | null);
    if (wd) return wd;
  }

  if (patch.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(patch.status as string)) {
    return refuse("INVALID_STATUS", `unknown status "${String(patch.status)}"`, {
      issues: [`valid statuses: ${TASK_STATUSES.join(" | ")}`],
    });
  }

  const after: TaskObject = {
    ...before,
    title: patch.title !== undefined ? String(patch.title) : before.title,
    status: patch.status !== undefined ? (patch.status as TaskStatus) : before.status,
    assignee: patch.assignee !== undefined ? (patch.assignee as string | null) : before.assignee,
    priority: patch.priority !== undefined ? (patch.priority as string | null) : before.priority,
    type: patch.type !== undefined ? (patch.type as string | null) : before.type,
    parent: patch.parent !== undefined ? (patch.parent as string | null) : before.parent,
    tracks: patch.tracks !== undefined ? (patch.tracks as string | null) : before.tracks,
    refs: patch.refs !== undefined ? (patch.refs as string[]) : before.refs,
    body: patch.body !== undefined ? String(patch.body) : before.body,
    followUpAt: patch.followUpAt !== undefined ? (patch.followUpAt as string | null) : before.followUpAt,
    owner: patch.owner !== undefined ? (patch.owner as string | null) : before.owner,
    workdir: patch.workdir !== undefined ? (patch.workdir as string | null) : before.workdir,
    goal: patch.goal !== undefined ? (patch.goal as string | null) : before.goal,
    version: before.version + 1,
    updatedAt: now,
  };

  // Invariant #1, both directions (the once slot mirrors followUpAt exactly).
  if (after.status === "follow-up") {
    if (!after.followUpAt) {
      return refuse("FOLLOWUP_NEEDS_DATE", "entering follow-up requires followUpAt", {
        hint: "update <id> status=follow-up followUpAt=<date>",
      });
    }
    if (!validInstant(after.followUpAt)) {
      return refuse("FOLLOWUP_NEEDS_DATE", `followUpAt "${after.followUpAt}" is not a valid instant`);
    }
  } else if (patch.followUpAt !== undefined && patch.followUpAt !== null) {
    return refuse("FOLLOWUP_NEEDS_DATE", "followUpAt only lives on status=follow-up (the waiting state)");
  } else {
    after.followUpAt = null; // leaving follow-up clears the slot
  }

  // CLOSED-GOAL COMPLETION CONTRACT: a task with a finish line (`goal` set)
  // cannot silently become done - the completing update must carry a note (the
  // completion evidence, recorded on the status-changed event). Trigger
  // pausing on completion + deterministic reopen re-arm are the EXISTING
  // terminal-status invariants #2/#2' - no goal-specific trigger logic.
  if (after.goal != null && after.status === "done" && before.status !== "done" && !cmd.note?.trim()) {
    return refuse("GOAL_NEEDS_NOTE", `"${after.id}" is a closed goal - marking it done needs a completion note`, {
      hint: 'update <id> status=done --note "<how the finish line was met>"',
    });
  }

  const issues = referenceIssues(snapshot, after.id, after.parent, after.tracks);
  if (issues.length > 0) {
    return issues.some((i) => i.includes("cycle"))
      ? refuse("PARENT_CYCLE", "parent would create a cycle", { issues })
      : refuse("INVALID_REFERENCE", "invalid references", { issues });
  }

  // ---- resolve the cron intent (a timezone-only update re-derives the cron
  // trigger rather than being a silent no-op — finding #4) ----
  const myTriggers = snapshot.triggers.filter((t) => t.taskId === after.id);
  const cronExisting = myTriggers.find((t) => t.kind === "cron");
  const cronExplicitDisarm = patch.cron === null;

  // An owner-PAUSED cron (disabledBy="owner") CAN be present in the snapshot
  // (types.ts models it publicly, even though no M1 command produces it): an
  // unrelated update carries it as intent below, and finalizeTriggers preserves
  // it verbatim (no revive) unless this update explicitly sets patch.cron. An
  // owner-DISARMED cron deletes the row (cronExplicitDisarm), so a present cron
  // is enabled, invariant-disabled, or owner-paused.
  let cronIntent: CronIntent | null;
  if (cronExplicitDisarm) {
    cronIntent = null; // owner disarm — deleted below, never auto-revived
  } else if (patch.cron !== undefined) {
    const timezone = patch.timezone !== undefined ? (patch.timezone as string | null) : cronExisting?.timezone ?? null;
    const bad = cronPairRefusal(String(patch.cron), timezone);
    if (bad) return bad;
    cronIntent = { spec: String(patch.cron), timezone };
  } else if (patch.timezone !== undefined && cronExisting) {
    // timezone-only update on a loop: re-derive the cron trigger with the new tz.
    const timezone = patch.timezone as string | null;
    if (timezone !== null && !validTimezone(timezone)) {
      return refuse("INVALID_TIMEZONE", `invalid timezone "${timezone}"`);
    }
    cronIntent = { spec: cronExisting.spec, timezone };
  } else if (cronExisting) {
    // No cron change but a cron exists: carry it as the intent so terminality
    // (invariant #2/#2') is decided uniformly in finalizeTriggers.
    cronIntent = { spec: cronExisting.spec, timezone: cronExisting.timezone };
  } else {
    cronIntent = null; // no cron at all
  }

  // ---- events (built before we know trigger notices, but after `after`) ----
  const cs = emptyChangeset();
  const events: KernelEvent[] = [];
  const push = (kind: KernelEvent["kind"], diff: KernelEvent["diff"], note?: string) => {
    events.push({
      id: eventId(after.id, after.version, kind),
      objectId: after.id,
      kind,
      at: now,
      ...(diff ? { diff } : {}),
      ...(note !== undefined ? { note } : {}),
      provenance: actor,
    });
  };
  const fieldDiff: NonNullable<KernelEvent["diff"]> = {};
  for (const key of ["title", "priority", "type", "parent", "tracks", "refs", "body", "followUpAt", "owner", "workdir", "goal"] as const) {
    const oldValue = before[key];
    const newValue = after[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      fieldDiff[key] = { old: oldValue, new: newValue };
    }
  }
  if (before.status !== after.status) {
    push("status-changed", { status: { old: before.status, new: after.status } }, cmd.note);
  }
  if (before.assignee !== after.assignee) {
    push("assignee-changed", { assignee: { old: before.assignee, new: after.assignee } }, before.status === after.status ? cmd.note : undefined);
  }
  if (Object.keys(fieldDiff).length > 0) {
    push(
      "fields-changed",
      fieldDiff,
      before.status === after.status && before.assignee === after.assignee ? cmd.note : undefined,
    );
  }
  if (events.length === 0 && cmd.note !== undefined) {
    push("note", undefined, cmd.note);
  }

  // ---- trigger finalization (single source, keyed off after.status) ----
  const { mutations: trigMutations, notices: trigNotices } = finalizeTriggers(
    after,
    myTriggers,
    cronIntent,
    now,
    patch.cron !== undefined,
  );
  const triggerMutations: TriggerMutation[] = [...trigMutations];
  if (cronExplicitDisarm && cronExisting) {
    triggerMutations.push({ op: "delete", id: cronExisting.id, expected: cronExisting });
  }
  // Dedup by id — the explicit disarm delete must win over any put.
  const byId = new Map<string, TriggerMutation>();
  for (const m of triggerMutations) {
    const key = m.op === "delete" ? m.id : m.trigger.id;
    if (m.op === "delete") byId.set(key, m);
    else if (!(byId.get(key)?.op === "delete")) byId.set(key, m);
  }

  // ---- run side effects ----
  const runMutations: Changeset["runs"] = [];
  const enteredTerminal = !isTerminal(before.status) && isTerminal(after.status);
  const open = activeRun(snapshot, after.id);
  // An assignee change makes a pending run toward the OLD assignee stale - the
  // haiku-4 handoff bug: tim's reassignment back to claude minted nothing
  // because (a) tim looked dispatchable, so there was no eligibility edge, and
  // (b) the stale pending run toward tim blocked the active-run guard. The
  // handoff supersedes the stale run and re-dispatches to the new assignee.
  const assigneeChanged = before.assignee !== after.assignee;
  const staleAssignment =
    !enteredTerminal && assigneeChanged && open?.state === "pending" && open.assignee !== after.assignee;
  if (open?.state === "pending" && (enteredTerminal || staleAssignment)) {
    runMutations.push({ op: "put", run: { ...open, state: "superseded" }, expectedState: ["pending"] });
  }
  runMutations.push(
    ...assignmentRunMutation(
      ctx,
      after,
      taskEligible(before) && !assigneeChanged,
      staleAssignment ? open.id : undefined,
    ),
  );

  // ---- NO-OP guard: an update that changes nothing must not bump the
  //  version with no event (finding #4). If there is no event, no trigger
  //  mutation, and no run mutation, the object write is a pure version bump
  //  with nothing to show for it — refuse it. ----
  const cronDisarmNotice = cronExplicitDisarm && cronExisting;
  if (events.length === 0 && byId.size === 0 && runMutations.length === 0 && !cronDisarmNotice) {
    return refuse("NO_OP", "nothing changed", {
      hint: "add --note to record intent, or change a field",
    });
  }

  const notices = softVocabularyNotices(after);
  cs.objects.push({ object: after, expectedVersion: before.version });
  cs.events.push(...events);
  cs.triggers.push(...byId.values());
  notices.push(...trigNotices);
  if (cronDisarmNotice) notices.push("disarmed cron (owner) — will not auto-revive");
  if (enteredTerminal && runMutations.some((m) => m.op === "put")) {
    notices.push("superseded the pending run");
  }
  if (staleAssignment) {
    notices.push(
      `superseded the pending run for "${open!.assignee}" — re-dispatched to "${after.assignee}"`,
    );
  }
  cs.runs.push(...runMutations);
  return { ok: true, changeset: cs, notices, result: { id: after.id } };
}

/** Validate patch field VALUES so nothing malformed reaches business logic
 *  (finding #4). Returns a granular Refusal or null. */
function validatePatchFields(
  patch: Partial<Record<(typeof EDITABLE_TASK_FIELDS)[number], unknown>>,
): Decision | null {
  const stringOrNull = (k: (typeof EDITABLE_TASK_FIELDS)[number]): Decision | null => {
    const v = patch[k];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return refuse("INVALID_REFERENCE", `"${k}" must be a string`, { issues: [`got ${typeof v}`] });
    }
    return null;
  };
  // title/body are REQUIRED non-nullable strings (types.ts) — refuse null rather
  // than let String(null) store the literal "null". The genuinely nullable
  // fields (assignee/priority/type/parent/tracks) keep accepting null.
  for (const k of ["title", "body"] as const) {
    const v = patch[k];
    if (v !== undefined && typeof v !== "string") {
      return refuse("INVALID_REFERENCE", `"${k}" must be a string`, {
        issues: [`got ${v === null ? "null" : typeof v}`],
      });
    }
  }
  for (const k of ["assignee", "priority", "type", "parent", "tracks", "goal"] as const) {
    const bad = stringOrNull(k);
    if (bad) return bad;
  }
  if (patch.refs !== undefined) {
    if (!Array.isArray(patch.refs) || !patch.refs.every((r) => typeof r === "string")) {
      return refuse("INVALID_REFERENCE", `"refs" must be a string array`);
    }
  }
  if (patch.followUpAt !== undefined && patch.followUpAt !== null && typeof patch.followUpAt !== "string") {
    return refuse("FOLLOWUP_NEEDS_DATE", `followUpAt must be an ISO instant string`);
  }
  if (patch.cron !== undefined && patch.cron !== null && typeof patch.cron !== "string") {
    return refuse("INVALID_CRON", `cron must be a string expression`);
  }
  if (patch.timezone !== undefined && patch.timezone !== null) {
    if (typeof patch.timezone !== "string") {
      return refuse("INVALID_TIMEZONE", `timezone must be a string`);
    }
    // Validate the zone SEMANTICALLY regardless of cron presence — decideCreate
    // already refuses an invalid tz with no cron, so the two write paths must
    // agree (finding: invalid tz on a non-loop update returned NO_OP). A VALID
    // tz with no cron still has nothing to re-derive and stays a NO_OP downstream.
    if (!validTimezone(patch.timezone)) {
      return refuse("INVALID_TIMEZONE", `invalid timezone "${patch.timezone}"`);
    }
  }
  return null;
}

// ---- note ----

function decideNote(cmd: NoteCommand, ctx: Ctx): Decision {
  const { snapshot, actor, now } = ctx;
  const idBad = requireString(cmd.id, "id", "UNKNOWN_OBJECT");
  if (idBad) return idBad;
  const noteBad = requireString(cmd.note, "note", "INVALID_REFERENCE");
  if (noteBad) return noteBad;
  const before = getObject(snapshot, cmd.id);
  if (!before) return refuse("UNKNOWN_OBJECT", `no object "${cmd.id}"`);
  const after = { ...before, version: before.version + 1, updatedAt: now } as KernelObject;
  const kind = cmd.observation ? "observation" : "note";
  const cs = emptyChangeset();
  cs.objects.push({ object: after, expectedVersion: before.version });
  cs.events.push({
    id: eventId(cmd.id, after.version, kind),
    objectId: cmd.id,
    kind,
    at: now,
    note: cmd.note,
    ...(cmd.observation ? { observation: cmd.observation } : {}),
    provenance: actor,
  });
  return { ok: true, changeset: cs, notices: [], result: { id: cmd.id } };
}

// ---- doc put (no state machine => one upsert verb) ----

function decideDocPut(cmd: DocPutCommand, ctx: Ctx): Decision {
  const { snapshot, actor, now } = ctx;
  const keyBad = requireString(cmd.key, "key", "INVALID_REFERENCE");
  if (keyBad) return keyBad;
  const bodyBad = requireString(cmd.body, "body", "INVALID_REFERENCE");
  if (bodyBad) return bodyBad;
  if (cmd.title !== undefined && cmd.title !== null) {
    const titleBad = requireString(cmd.title, "title", "INVALID_REFERENCE");
    if (titleBad) return titleBad;
  }
  const id = slugify(cmd.key);
  const existing = getObject(snapshot, id);
  if (existing && existing.archetype !== "doc") {
    return refuse("CONFLICT", `"${id}" exists and is a ${existing.archetype}`);
  }
  if (existing && cmd.ifVersion !== undefined && cmd.ifVersion !== existing.version) {
    return refuse("CONFLICT", `version is ${existing.version}, expected ${cmd.ifVersion}`, {
      hint: "re-read and retry",
    });
  }
  const version = existing ? existing.version + 1 : 1;
  const doc: KernelObject = {
    archetype: "doc",
    id,
    key: id,
    title: cmd.title ?? (existing?.archetype === "doc" ? existing.title : null),
    body: cmd.body,
    version,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  // Validate the attach TARGET before mutating anything (fail whole, not half).
  let attachTo: TaskObject | null = null;
  if (cmd.attachTask !== undefined) {
    const t = getTask(snapshot, cmd.attachTask);
    if (!t) return refuse("UNKNOWN_OBJECT", `attach target "${cmd.attachTask}" is not a task`);
    attachTo = t;
  }

  const cs = emptyChangeset();
  const notices: string[] = [];
  cs.objects.push({ object: doc, expectedVersion: existing ? existing.version : null });
  cs.events.push({
    id: eventId(id, version, existing ? "doc-updated" : "created"),
    objectId: id,
    kind: existing ? "doc-updated" : "created",
    at: now,
    note: `body ${existing ? "updated" : "created"} (${Buffer.byteLength(cmd.body)} bytes)`,
    provenance: actor,
  });
  // The atomic attach (sim rounds 1-6: nobody ever ran the second step, so the
  // graph edge task->doc simply never existed). Idempotent: an already-attached
  // doc changes nothing on the task.
  if (attachTo && !attachTo.refs.includes(id)) {
    const patched: TaskObject = {
      ...attachTo,
      refs: [...attachTo.refs, id],
      version: attachTo.version + 1,
      updatedAt: now,
    };
    cs.objects.push({ object: patched, expectedVersion: attachTo.version });
    cs.events.push({
      id: eventId(patched.id, patched.version, "fields-changed"),
      objectId: patched.id,
      kind: "fields-changed",
      at: now,
      diff: { refs: { old: attachTo.refs, new: patched.refs } },
      note: `doc "${id}" attached`,
      provenance: actor,
    });
    notices.push(`attached — ${patched.id} refs += ${id}`);
  } else if (attachTo) {
    notices.push(`already attached to ${attachTo.id}`);
  } else if (!anyTaskPointsAt(snapshot, id)) {
    // The island warning: nothing points at this doc, so no task page will
    // ever surface it. Loud at write time — the writer is the one who knows
    // which task it belongs to.
    notices.push(
      `unattached — no task refs this doc; it is invisible from every task page. ` +
        `Attach it: doc put ${id} --task <task-id> (in-run, LOOPANY_TASK_ID auto-fills)`,
    );
  }
  return { ok: true, changeset: cs, notices, result: { id, existing: Boolean(existing) } };
}

// ---- mirror add (get-or-create on external identity) ----

function decideMirrorAdd(cmd: MirrorAddCommand, ctx: Ctx): Decision {
  const { snapshot, actor, now } = ctx;
  if (typeof cmd.kind !== "string" || !(MIRROR_KINDS as readonly string[]).includes(cmd.kind)) {
    return refuse("BAD_MIRROR_KIND", `unknown mirror kind "${String(cmd.kind)}"`, {
      issues: [`known kinds: ${MIRROR_KINDS.join(" | ")}`],
    });
  }
  const coordsBad = requireString(cmd.coords, "coords", "INVALID_REFERENCE");
  if (coordsBad) return coordsBad;
  const coords = cmd.coords.trim();
  if (coords.length === 0) return refuse("INVALID_REFERENCE", "coords must be non-empty");
  const id = mirrorId(cmd.kind, coords);
  const existing = getObject(snapshot, id);
  if (existing && (existing.archetype !== "mirror" || existing.kind !== cmd.kind)) {
    // A derived id collision with a DIFFERENT archetype/kind — never silently
    // return the occupier as "existing" (finding: mirror id occupied).
    return refuse("CONFLICT", `id "${id}" is occupied by a ${existing.archetype}`, {
      hint: "the (kind, coords) pair hashes onto an existing object of another kind",
    });
  }
  // Validate the attach TARGET before mutating anything (fail whole, not half —
  // same discipline as decideDocPut).
  let attachTo: TaskObject | null = null;
  if (cmd.attachTask !== undefined) {
    const t = getTask(snapshot, cmd.attachTask);
    if (!t) return refuse("UNKNOWN_OBJECT", `attach target "${cmd.attachTask}" is not a task`);
    attachTo = t;
  }
  const cs = emptyChangeset();
  const notices: string[] = [];
  if (!existing) {
    cs.objects.push({
      object: { archetype: "mirror", id, kind: cmd.kind, coords, version: 1, createdAt: now, updatedAt: now },
      expectedVersion: null,
    });
    cs.events.push({
      id: eventId(id, 1, "created"),
      objectId: id,
      kind: "created",
      at: now,
      note: `${cmd.kind} ${coords}`,
      provenance: actor,
    });
  }
  // The attach rides BOTH branches: a dedup hit still links the existing mirror
  // to the task when the edge is missing (idempotent when it is already there).
  if (attachTo && !attachTo.refs.includes(id)) {
    const patched: TaskObject = {
      ...attachTo,
      refs: [...attachTo.refs, id],
      version: attachTo.version + 1,
      updatedAt: now,
    };
    cs.objects.push({ object: patched, expectedVersion: attachTo.version });
    cs.events.push({
      id: eventId(patched.id, patched.version, "fields-changed"),
      objectId: patched.id,
      kind: "fields-changed",
      at: now,
      diff: { refs: { old: attachTo.refs, new: patched.refs } },
      note: `mirror "${id}" attached`,
      provenance: actor,
    });
    notices.push(`attached — ${patched.id} refs += ${id}`);
  } else if (attachTo) {
    notices.push(`already attached to ${attachTo.id}`);
  } else if (!anyTaskPointsAt(snapshot, id)) {
    // The island warning (same as doc-put): an unlinked pointer is only
    // findable via `mirror list`/search — say so where the writer can act.
    notices.push(
      `unattached — no task refs this mirror. ` +
        `Attach it: mirror add ${cmd.kind} <coords> --task <task-id> (in-run, LOOPANY_TASK_ID auto-fills)`,
    );
  }
  return { ok: true, changeset: cs, notices, result: { id, existing: Boolean(existing) } };
}

// ---- manual run ----

function decideRun(cmd: RunCommand, ctx: Ctx): Decision {
  const { snapshot, actor, now } = ctx;
  const idBad = requireString(cmd.id, "id", "UNKNOWN_OBJECT");
  if (idBad) return idBad;
  const task = getTask(snapshot, cmd.id);
  if (!task) return refuse("UNKNOWN_OBJECT", `no task "${cmd.id}"`);
  if (isTerminal(task.status)) {
    return refuse("TERMINAL_TASK", `"${cmd.id}" is ${task.status}`, {
      hint: "update status=todo revives it (and re-arms its schedule)",
    });
  }
  if (!isDispatchable(task.assignee)) {
    return refuse("ASSIGNEE_NOT_DISPATCHABLE", "a run needs an agent assignee", {
      hint: "update <id> assignee=<agent> first",
    });
  }
  const open = activeRun(snapshot, cmd.id);
  if (open) {
    return refuse("RUN_ACTIVE", `run ${open.id} is ${open.state}`, {
      hint: "wait for it to finish (or let the next fire supersede it)",
    });
  }
  const cs = emptyChangeset();
  cs.runs.push({
    op: "insert",
    run: {
      id: runId("manual", cmd.id, now),
      taskId: cmd.id,
      cause: "manual",
      scheduledAt: now,
      state: "pending",
      assignee: task.assignee,
      triggerId: null,
      createdAt: now,
    },
  });
  void actor;
  return { ok: true, changeset: cs, notices: [], result: { id: cmd.id } };
}

// ---- run-claim (a host claims a pending run and begins it) ----

/** A cause is ONE-SHOT (its claim flips the task's status) exactly when it is not
 *  a recurring cron fire: a cron run leaves the task resident in-progress and only
 *  the run record moves (§5.1). assignment/once/manual are one-shot dispatches. */
function isOneShotCause(cause: RunRecord["cause"]): boolean {
  return cause !== "cron";
}

function findRun(snapshot: Snapshot, runId: string): RunRecord | undefined {
  return snapshot.runs.find((r) => r.id === runId);
}

function decideRunClaim(cmd: RunClaimCommand, ctx: Ctx): Decision {
  const { snapshot, actor, now } = ctx;
  const idBad = requireString(cmd.runId, "runId", "UNKNOWN_RUN");
  if (idBad) return idBad;
  if (cmd.sessionId !== undefined) {
    const sidBad = requireString(cmd.sessionId, "sessionId", "UNKNOWN_RUN");
    if (sidBad) return sidBad;
  }
  const run = findRun(snapshot, cmd.runId);
  if (!run) return refuse("UNKNOWN_RUN", `no run "${cmd.runId}"`);
  // A claim consumes a PENDING run (pending -> claimed -> running). Anything else
  // (already running, done, superseded) is not claimable.
  if (run.state !== "pending") {
    return refuse("RUN_NOT_CLAIMABLE", `run "${cmd.runId}" is ${run.state}, not pending`, {
      hint: "only a pending run can be claimed",
    });
  }
  const task = getTask(snapshot, run.taskId);
  if (!task) return refuse("UNKNOWN_OBJECT", `run "${cmd.runId}" points at missing task "${run.taskId}"`);

  const cs = emptyChangeset();
  // The run moves pending -> running (the claimed state is the transient the CLI
  // passes through; a single decision lands it in running with the session fixed).
  const claimed: RunRecord = {
    ...run,
    state: "running",
    sessionId: cmd.sessionId ?? null,
  };
  cs.runs.push({ op: "put", run: claimed, expectedState: ["pending"] });

  // A ONE-SHOT task (assignment/once/manual dispatch) flips todo -> in-progress on
  // claim (§5.1); a cron run leaves the resident status untouched.
  let after = task;
  if (isOneShotCause(run.cause) && task.status === "todo") {
    after = { ...task, status: "in-progress", version: task.version + 1, updatedAt: now };
    cs.objects.push({ object: after, expectedVersion: task.version });
    cs.events.push({
      id: eventId(task.id, after.version, "status-changed"),
      objectId: task.id,
      kind: "status-changed",
      at: now,
      diff: { status: { old: task.status, new: "in-progress" } },
      provenance: actor,
    });
  }
  // run-started rides the TASK's stream. Its id keys off the RUN id (unique per
  // dispatch) so it never collides with a status-changed at the same task version,
  // nor with a later cron run-start that leaves the resident status untouched.
  cs.events.push({
    id: eventId(run.id, 0, "run-started"),
    objectId: task.id,
    kind: "run-started",
    at: now,
    note: `run ${run.id} started (${run.cause})`,
    provenance: actor,
  });
  return { ok: true, changeset: cs, notices: [], result: { id: run.id } };
}

// ---- run-finish (a host reports a run's outcome) ----

function decideRunFinish(cmd: RunFinishCommand, ctx: Ctx): Decision {
  const { snapshot, actor, now } = ctx;
  const idBad = requireString(cmd.runId, "runId", "UNKNOWN_RUN");
  if (idBad) return idBad;
  if (cmd.outcome !== "done" && cmd.outcome !== "failed") {
    return refuse("INVALID_OUTCOME", `outcome "${String(cmd.outcome)}" must be "done" or "failed"`);
  }
  if (cmd.note !== undefined) {
    const noteBad = requireString(cmd.note, "note", "INVALID_OUTCOME");
    if (noteBad) return noteBad;
  }
  if (cmd.agentSessionId !== undefined) {
    const sidBad = requireString(cmd.agentSessionId, "agentSessionId", "INVALID_OUTCOME");
    if (sidBad) return sidBad;
    if (cmd.agentSessionId.length > 200) {
      return refuse("INVALID_OUTCOME", "agentSessionId is too long (max 200 chars)");
    }
  }
  const run = findRun(snapshot, cmd.runId);
  if (!run) return refuse("UNKNOWN_RUN", `no run "${cmd.runId}"`);
  // Only a CLAIMED or RUNNING run can be finished. The §3 lifecycle is strict —
  // pending -> claimed -> running -> done|failed|superseded — and dispatch creates
  // only run(pending), which claim atomically consumes (§5.1). Finishing a PENDING
  // run directly would skip the claim: no run-started event (a run-returned with no
  // matching start) and, for a one-shot task, the todo -> in-progress flip never
  // happens (a "done" run against a still-todo task). Refuse it and point at claim.
  // A terminal run (done/failed/superseded) is likewise not re-finishable.
  const FINISHABLE_STATES: readonly RunState[] = ["claimed", "running"];
  if (run.state === "pending") {
    return refuse("RUN_NOT_ACTIVE", `run "${cmd.runId}" is pending, not claimed`, {
      hint: "claim it first (run-claim) — a pending run cannot be finished directly",
    });
  }
  if (!FINISHABLE_STATES.includes(run.state)) {
    return refuse("RUN_NOT_ACTIVE", `run "${cmd.runId}" is ${run.state}, not active`, {
      hint: "only a claimed or running run can be finished",
    });
  }
  const cs = emptyChangeset();
  const finished: RunRecord = {
    ...run,
    state: cmd.outcome,
    ...(cmd.note !== undefined ? { note: cmd.note } : {}),
    ...(cmd.agentSessionId !== undefined ? { agentSessionId: cmd.agentSessionId } : {}),
  };
  cs.runs.push({ op: "put", run: finished, expectedState: [...FINISHABLE_STATES] });
  // run-returned rides the TASK's stream. A DONE run advances nothing else — the
  // task keeps whatever status the agent left; the outcome is only recorded on the
  // run + this event.
  cs.events.push({
    id: eventId(run.id, 1, "run-returned"),
    objectId: run.taskId,
    kind: "run-returned",
    at: now,
    note: `run ${run.id} returned ${cmd.outcome}${cmd.note ? `: ${cmd.note}` : ""}`,
    provenance: actor,
  });

  // ---- failed-run resilience (haiku-5): a one-shot dispatch has no natural
  // retry — a cron loop self-heals on its next fire, but a once/assignment fire
  // that dies (a transient API error) used to strand the task: alarm consumed,
  // status stuck in-progress, silence forever. A failed one-shot now re-arms
  // the follow-up alarm (+1 day), BOUNDED by a consecutive-failure budget
  // derived from the persisted run rows (deploy-safe, no new field): at the
  // 3rd straight failure the task auto-parks to `idea` (the triage state) with
  // a loud note instead of retrying forever. Only the STRANDED shape is
  // touched — if the agent moved the task off in-progress before dying, its
  // write is respected. ----
  const notices: string[] = [];
  if (cmd.outcome === "failed" && (run.cause === "once" || run.cause === "assignment")) {
    const task = getTask(snapshot, run.taskId);
    if (task && task.status === "in-progress") {
      const streak = 1 + trailingFailedRuns(snapshot, run.taskId);
      const parked = streak > FAILED_RUN_BACKOFF_HOURS.length;
      const backoffHours = FAILED_RUN_BACKOFF_HOURS[streak - 1] ?? 0;
      const after: TaskObject = {
        ...task,
        status: parked ? "idea" : "follow-up",
        followUpAt: parked ? null : addHoursIso(now, backoffHours),
        version: task.version + 1,
        updatedAt: now,
      };
      const myTriggers = snapshot.triggers.filter((t) => t.taskId === task.id);
      const cronExisting = myTriggers.find((t) => t.kind === "cron");
      const { mutations, notices: trigNotices } = finalizeTriggers(
        after,
        myTriggers,
        cronExisting ? { spec: cronExisting.spec, timezone: cronExisting.timezone } : null,
        now,
        false,
      );
      cs.objects.push({ object: after, expectedVersion: task.version });
      cs.triggers.push(...mutations);
      cs.events.push({
        id: eventId(run.id, 2, "status-changed"),
        objectId: task.id,
        kind: "status-changed",
        at: now,
        note: parked
          ? `auto-parked after ${streak} consecutive failed runs — set a new follow-up date or reassign to retry`
          : `failed run — follow-up re-armed for ${after.followUpAt} (+${backoffHours}h backoff, attempt ${streak}/${FAILED_RUN_BACKOFF_HOURS.length})`,
        diff: { status: { old: task.status, new: after.status } },
        provenance: actor,
      });
      notices.push(
        parked
          ? `auto-parked (idea) after ${streak} consecutive failed runs`
          : `failed run — re-armed follow-up for ${after.followUpAt} (+${backoffHours}h backoff, attempt ${streak}/${FAILED_RUN_BACKOFF_HOURS.length})`,
      );
      notices.push(...trigNotices);
    }
  }
  return { ok: true, changeset: cs, notices, result: { id: run.id } };
}

/** Consecutive FAILED runs for a task, newest-first, before the one being
 *  finished (superseded runs are skips, not executions — they neither count
 *  nor break the streak; a done run breaks it). */
function trailingFailedRuns(snapshot: Snapshot, taskId: string): number {
  const settled = snapshot.runs
    .filter((r) => r.taskId === taskId && (r.state === "done" || r.state === "failed"))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  let n = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i]?.state !== "failed") break;
    n++;
  }
  return n;
}

/** Re-arm backoff ladder (x4, the daemon's transient-retry convention): the
 *  Nth consecutive failure re-arms +ladder[N-1] hours; one failure past the
 *  ladder parks. 1h absorbs blips, ~21h total rides out day-scale outages,
 *  at most 4 wasted runs, and a task either heals or parks within a day. */
const FAILED_RUN_BACKOFF_HOURS = [1, 4, 16] as const;

function addHoursIso(now: string, hours: number): string {
  return new Date(Date.parse(now) + hours * 3_600_000).toISOString();
}

// ---- entry ----

const KNOWN_OPS = [
  "create",
  "update",
  "note",
  "doc-put",
  "mirror-add",
  "run",
  "run-claim",
  "run-finish",
  "delete",
] as const;

export function decide(command: Command, snapshot: Snapshot, actor: Provenance, now: string): Decision {
  // Wire-shape guard FIRST: the remote driver POSTs raw Commands, so a
  // non-object envelope or an unknown op must refuse (typed), never throw on
  // `command.op` (null) nor fall off the switch as `undefined` (unknown op).
  if (command === null || typeof command !== "object" || Array.isArray(command)) {
    return refuse("UNKNOWN_COMMAND", "command must be an object");
  }
  const op = (command as { op?: unknown }).op;
  if (typeof op !== "string" || !(KNOWN_OPS as readonly string[]).includes(op)) {
    return refuse("UNKNOWN_COMMAND", `unknown op "${String(op)}"`, {
      issues: [`known ops: ${KNOWN_OPS.join(" | ")}`],
    });
  }
  const ctx: Ctx = { snapshot, actor, now };
  switch (command.op) {
    case "create":
      return decideCreate(command, ctx);
    case "update":
      return decideUpdate(command, ctx);
    case "note":
      return decideNote(command, ctx);
    case "doc-put":
      return decideDocPut(command, ctx);
    case "mirror-add":
      return decideMirrorAdd(command, ctx);
    case "run":
      return decideRun(command, ctx);
    case "run-claim":
      return decideRunClaim(command, ctx);
    case "run-finish":
      return decideRunFinish(command, ctx);
    case "delete":
      return refuse("DELETE_TAUGHT", "nothing is ever deleted", {
        hint: "update <id> status=archived is the terminal state",
      });
  }
}
