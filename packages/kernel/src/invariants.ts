/**
 * checkInvariants(snapshot) — the kernel's EXECUTABLE SPEC. Every structural
 * constraint that decide + applyChangeset + tick are jointly supposed to
 * preserve, restated as a pure total check. It never throws and never fixes;
 * it only reports.
 *
 * This is deliberate redundancy: decide enforces these rules at entry, apply
 * enforces the CAS preconditions at fold, and this module re-states the
 * resulting steady-state so property tests (test/invariants.property.test.ts)
 * can assert the whole pipeline lands in a legal world for ARBITRARY command
 * sequences — not just the enumerated examples. Hosts may also assert it in
 * dev after a fold (cheap: linear in snapshot size).
 *
 * Sources of truth for each rule (do not invent rules here — cite the code):
 *  - invariant ①  follow-up ⟺ followUpAt        decide.ts create/update
 *  - invariant ①' once slot mirrors followUpAt   decide.ts finalizeTriggers
 *  - invariant ②  terminal ⇒ triggers disabled   decide.ts finalizeTriggers
 *  - one active run per task (§5.1)              apply.ts run insert guard
 *  - derived trigger/one-slot ids                ids.ts cron/onceTriggerId
 *  - reference shape (parent/tracks)             decide.ts referenceIssues
 *  - field types ("no junk reaches storage")     decide.ts validatePatchFields
 */
import { Cron } from "croner";
import {
  ACTIVE_RUN_STATES,
  MIRROR_KINDS,
  TASK_STATUSES,
  type DocObject,
  type KernelObject,
  type MirrorObject,
  type RunRecord,
  type Snapshot,
  type TaskObject,
  type Trigger,
  isTerminal,
} from "./types.js";
import { cronTriggerId, onceTriggerId } from "./ids.js";

export interface Violation {
  /** Stable rule key, e.g. "task/followup-slot". */
  rule: string;
  /** The offending object/trigger/run id. */
  id: string;
  message: string;
}

const RUN_STATES = ["pending", "claimed", "running", "done", "failed", "superseded"] as const;
const RUN_CAUSES = ["assignment", "cron", "once", "manual"] as const;

export function checkInvariants(snapshot: Snapshot): Violation[] {
  const v: Violation[] = [];
  const bad = (rule: string, id: string, message: string) => v.push({ rule, id, message });

  // ---- objects ----
  for (const [key, obj] of Object.entries(snapshot.objects)) {
    if (key !== obj.id) bad("object/key-mismatch", key, `map key "${key}" holds object id "${obj.id}"`);
    if (!Number.isInteger(obj.version) || obj.version < 1) {
      bad("object/version", obj.id, `version must be an integer >= 1 (got ${String(obj.version)})`);
    }
    if (obj.archetype === "task") checkTask(obj, snapshot, bad);
    else if (obj.archetype === "doc") checkDoc(obj, bad);
    else if (obj.archetype === "mirror") checkMirror(obj, bad);
    else bad("object/archetype", (obj as KernelObject).id, `unknown archetype "${String((obj as { archetype?: unknown }).archetype)}"`);
  }

  // ---- triggers ----
  const triggerIds = new Set<string>();
  for (const t of snapshot.triggers) {
    if (triggerIds.has(t.id)) bad("trigger/duplicate-id", t.id, "duplicate trigger id");
    triggerIds.add(t.id);
    checkTrigger(t, snapshot, bad);
  }

  // ---- runs ----
  const runIds = new Set<string>();
  const activeByTask = new Map<string, string[]>();
  for (const r of snapshot.runs) {
    if (runIds.has(r.id)) bad("run/duplicate-id", r.id, "duplicate run id");
    runIds.add(r.id);
    checkRun(r, snapshot, bad);
    if ((ACTIVE_RUN_STATES as readonly string[]).includes(r.state)) {
      const list = activeByTask.get(r.taskId) ?? [];
      list.push(r.id);
      activeByTask.set(r.taskId, list);
    }
  }
  for (const [taskId, ids] of activeByTask) {
    if (ids.length > 1) {
      bad("run/multiple-active", taskId, `task has ${ids.length} active runs (${ids.join(", ")}) — §5.1 allows one`);
    }
  }

  return v;
}

type Bad = (rule: string, id: string, message: string) => void;

function isStringOrNull(x: unknown): boolean {
  return x === null || typeof x === "string";
}

function validInstant(x: unknown): x is string {
  return typeof x === "string" && Number.isFinite(Date.parse(x));
}

function checkTask(task: TaskObject, snapshot: Snapshot, bad: Bad): void {
  // Field types — "nothing malformed reaches business logic" (decide finding #4),
  // restated over storage so a decide gap or a hand-edited store surfaces here.
  if (typeof task.title !== "string") bad("task/field-types", task.id, `title must be a string`);
  if (typeof task.body !== "string") bad("task/field-types", task.id, `body must be a string`);
  for (const k of ["assignee", "owner", "priority", "type", "parent", "tracks", "goal", "workdir", "followUpAt"] as const) {
    if (!isStringOrNull(task[k])) bad("task/field-types", task.id, `${k} must be a string or null (got ${typeof task[k]})`);
  }
  if (!Array.isArray(task.refs) || !task.refs.every((r) => typeof r === "string")) {
    bad("task/field-types", task.id, "refs must be a string array");
  }

  if (!(TASK_STATUSES as readonly string[]).includes(task.status)) {
    bad("task/status", task.id, `unknown status "${String(task.status)}"`);
  }

  // Invariant ①, both directions: the wait slot exists exactly on follow-up.
  if (task.status === "follow-up") {
    if (!validInstant(task.followUpAt)) {
      bad("task/followup-slot", task.id, `status=follow-up requires a valid followUpAt (got ${String(task.followUpAt)})`);
    }
  } else if (task.followUpAt !== null) {
    bad("task/followup-slot", task.id, `followUpAt "${String(task.followUpAt)}" set but status is "${task.status}"`);
  }

  if (typeof task.workdir === "string" && (!task.workdir.startsWith("/") || task.workdir.split("/").includes(".."))) {
    bad("task/workdir", task.id, `workdir must be an absolute path (got "${task.workdir}")`);
  }

  // References: parent is an existing task and the chain is acyclic; tracks is
  // an existing doc|mirror. (refs are LOOSE by design — never checked.)
  if (typeof task.parent === "string") {
    const target = snapshot.objects[task.parent];
    if (!target) bad("task/parent", task.id, `parent "${task.parent}" does not exist`);
    else if (target.archetype !== "task") bad("task/parent", task.id, `parent "${task.parent}" is a ${target.archetype}`);
    else {
      const seen = new Set<string>([task.id]);
      let cursor: string | null = task.parent;
      while (cursor) {
        if (seen.has(cursor)) {
          bad("task/parent-cycle", task.id, `parent chain cycles through "${cursor}"`);
          break;
        }
        seen.add(cursor);
        const t: KernelObject | undefined = snapshot.objects[cursor];
        cursor = t?.archetype === "task" ? t.parent : null;
      }
    }
  }
  if (typeof task.tracks === "string") {
    const target = snapshot.objects[task.tracks];
    if (!target) bad("task/tracks", task.id, `tracks "${task.tracks}" does not exist`);
    else if (target.archetype === "task") bad("task/tracks", task.id, `tracks must point at a doc or mirror`);
  }
}

function checkDoc(doc: DocObject, bad: Bad): void {
  if (typeof doc.body !== "string") bad("doc/field-types", doc.id, "body must be a string");
  if (doc.key !== doc.id) bad("doc/key", doc.id, `key "${doc.key}" must equal the id (decideDocPut derives both)`);
  if (doc.title !== null && typeof doc.title !== "string") bad("doc/field-types", doc.id, "title must be a string or null");
}

function checkMirror(mirror: MirrorObject, bad: Bad): void {
  if (!(MIRROR_KINDS as readonly string[]).includes(mirror.kind)) {
    bad("mirror/kind", mirror.id, `unknown mirror kind "${String(mirror.kind)}"`);
  }
  if (typeof mirror.coords !== "string" || mirror.coords.trim().length === 0) {
    bad("mirror/field-types", mirror.id, "coords must be a non-empty string");
  }
}

function checkTrigger(t: Trigger, snapshot: Snapshot, bad: Bad): void {
  const owner = snapshot.objects[t.taskId];
  if (!owner || owner.archetype !== "task") {
    bad("trigger/orphan", t.id, `taskId "${t.taskId}" is not an existing task`);
    return; // task-relative rules below are meaningless without the task
  }
  const task = owner;

  if (t.kind !== "cron" && t.kind !== "once") {
    bad("trigger/kind", t.id, `unknown kind "${String(t.kind)}"`);
    return;
  }
  // Derived identity IS the one-slot-per-kind constraint (ids.ts): with unique
  // ids checked by the caller, id === derivedId(taskId) caps each kind at one.
  const derived = t.kind === "cron" ? cronTriggerId(t.taskId) : onceTriggerId(t.taskId);
  if (t.id !== derived) bad("trigger/id-derivation", t.id, `id must be "${derived}"`);

  // enabled and disabledBy move together (finalizeTriggers writes them as a pair).
  if (t.enabled && t.disabledBy !== null) {
    bad("trigger/disabledBy", t.id, `enabled trigger carries disabledBy="${String(t.disabledBy)}"`);
  }
  if (!t.enabled && t.disabledBy !== "owner" && t.disabledBy !== "invariant") {
    bad("trigger/disabledBy", t.id, `disabled trigger must record disabledBy owner|invariant (got ${String(t.disabledBy)})`);
  }

  // Invariant ②: a terminal task's schedule is always paused.
  if (isTerminal(task.status) && t.enabled) {
    bad("trigger/terminal-enabled", t.id, `task "${task.id}" is ${task.status} but the trigger is enabled`);
  }

  if (t.kind === "cron") {
    if (typeof t.spec !== "string" || !validCronSpec(t.spec, t.timezone)) {
      bad("trigger/cron-spec", t.id, `invalid cron "${String(t.spec)}"`);
    }
  } else {
    // Invariant ①': the once slot mirrors the task's followUpAt EXACTLY — the
    // value is the generation (finalizeTriggers), and a kernel-built once
    // always has spec === nextFireAt, tz null, enabled (else it is deleted).
    if (!t.enabled) bad("trigger/once-mirror", t.id, "a once trigger is never kept disabled — it is deleted");
    if (t.timezone !== null) bad("trigger/once-mirror", t.id, "a once trigger carries no timezone");
    if (!validInstant(t.spec)) bad("trigger/once-mirror", t.id, `spec "${String(t.spec)}" is not a valid instant`);
    if (t.nextFireAt !== t.spec) {
      bad("trigger/once-mirror", t.id, `nextFireAt "${String(t.nextFireAt)}" diverged from spec "${t.spec}"`);
    }
    if (task.followUpAt !== t.spec) {
      bad("trigger/once-mirror", t.id, `spec "${t.spec}" diverged from the task's followUpAt "${String(task.followUpAt)}"`);
    }
  }
}

function checkRun(r: RunRecord, snapshot: Snapshot, bad: Bad): void {
  const owner = snapshot.objects[r.taskId];
  if (!owner || owner.archetype !== "task") {
    bad("run/orphan", r.id, `taskId "${r.taskId}" is not an existing task`);
  }
  if (!(RUN_STATES as readonly string[]).includes(r.state)) {
    bad("run/state", r.id, `unknown state "${String(r.state)}"`);
  }
  if (!(RUN_CAUSES as readonly string[]).includes(r.cause)) {
    bad("run/cause", r.id, `unknown cause "${String(r.cause)}"`);
  }
}

function validCronSpec(spec: string, timezone: string | null): boolean {
  try {
    // Same probe as decide's validCron/tick's nextAfter: croner parse.
    new Cron(spec, timezone ? { timezone } : undefined);
    return true;
  } catch {
    return false;
  }
}
