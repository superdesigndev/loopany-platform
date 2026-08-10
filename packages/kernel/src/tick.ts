/**
 * tick(snapshot, now) — the clock's whole job: make due tasks actionable.
 *
 * Due triggers are processed against a WORKING snapshot folded after every
 * fire, so two triggers on the SAME task due in one tick (e.g. a once and a
 * cron) see each other's effect and can never both create an active run
 * (finding #3). Fire order is stable: once before cron (a wait ending should
 * flip status before the cron reads it), then by nextFireAt, then id.
 *
 * One changeset PER FIRE (so a host can apply each atomically and a partial
 * apply never loses later fires). Idempotent by construction: a fire's run id
 * derives from (triggerId, scheduledAt), so replaying a tick collides with the
 * already-created run and is skipped.
 *
 * The clock understands neither task content nor executors: 时钟管"何时",
 * assignee 管"谁", status 管"什么阶段", run 管"这一次".
 */
import { Cron } from "croner";
import {
  type Changeset,
  type Snapshot,
  type TaskObject,
  type Trigger,
  emptyChangeset,
  isTerminal,
} from "./types.js";
import { activeRun, isDispatchable } from "./decide.js";
import { foldChangeset } from "./apply.js";
import { eventId, runId } from "./ids.js";

export interface TickResult {
  changesets: Changeset[];
  notices: string[];
}

function nextAfter(trigger: Trigger, from: string): string | null {
  try {
    const cron = new Cron(trigger.spec, trigger.timezone ? { timezone: trigger.timezone } : undefined);
    const next = cron.nextRun(new Date(from));
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

function due(trigger: Trigger, now: string): boolean {
  return (
    trigger.enabled &&
    trigger.nextFireAt !== null &&
    Date.parse(trigger.nextFireAt) <= Date.parse(now)
  );
}

/** Stable fire order: once before cron, then by nextFireAt, then id. Makes a
 *  tick deterministic regardless of the snapshot's trigger array order. */
function fireOrder(a: Trigger, b: Trigger): number {
  if (a.kind !== b.kind) return a.kind === "once" ? -1 : 1;
  const an = a.nextFireAt ?? "";
  const bn = b.nextFireAt ?? "";
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function tick(snapshot: Snapshot, now: string): TickResult {
  const changesets: Changeset[] = [];
  const notices: string[] = [];

  // Snapshot the set of due triggers up front (a fire never makes a NEW trigger
  // due within the same tick), but fold each fire into a WORKING snapshot so
  // later fires observe earlier ones (the active-run guard is real).
  const dueTriggers = snapshot.triggers.filter((t) => due(t, now)).sort(fireOrder);
  let working = snapshot;

  for (const trigger of dueTriggers) {
    // Re-read the trigger from the working snapshot — an earlier fire on the
    // same task may have advanced/consumed it.
    const live = working.triggers.find((t) => t.id === trigger.id);
    if (!live || !due(live, now)) continue;

    const task = working.objects[live.taskId];
    if (!task || task.archetype !== "task") {
      const cs = emptyChangeset();
      cs.triggers.push({ op: "delete", id: live.id, expected: live });
      changesets.push(cs);
      working = foldChangeset(working, cs);
      notices.push(`dropped orphan trigger ${live.id}`);
      continue;
    }

    const cs = live.kind === "cron"
      ? fireCron(working, live, task, now, notices)
      : fireOnce(working, live, task, now, notices);
    changesets.push(cs);
    working = foldChangeset(working, cs);
  }
  return { changesets, notices };
}

function fireCron(
  snapshot: Snapshot,
  trigger: Trigger,
  task: TaskObject,
  now: string,
  notices: string[],
): Changeset {
  const cs = emptyChangeset();
  const scheduledAt = trigger.nextFireAt as string;
  // Always advance the clock — a skipped fire must not re-fire forever. The CAS
  // precondition is the trigger we READ, so a concurrent owner cron edit that
  // landed after we decided conflicts instead of reverting the spec (finding #1).
  cs.triggers.push({ op: "put", trigger: { ...trigger, nextFireAt: nextAfter(trigger, now) }, expected: trigger });

  if (isTerminal(task.status)) {
    // Defensive: invariant #2 should have disabled us already.
    notices.push(`skipped fire on terminal task ${task.id}`);
    return cs;
  }
  // Cron dispatch eligibility (finding #5): a cron only creates a run when the
  // assignee is dispatchable. An undispatchable assignee advances the cursor
  // and records a notice — never a headless run.
  if (!isDispatchable(task.assignee)) {
    notices.push(`cron fire on ${task.id} skipped — assignee "${task.assignee ?? "none"}" is not dispatchable`);
    return cs;
  }
  const id = runId("cron", trigger.id, scheduledAt);
  if (snapshot.runs.some((r) => r.id === id)) {
    notices.push(`fire ${id} already dispatched (replay) — skipped`);
    return cs;
  }
  const open = activeRun(snapshot, task.id);
  if (open) {
    if (open.state === "pending" && open.cause === "cron") {
      // The next fire supersedes a still-unclaimed one (production semantics).
      cs.runs.push({ op: "put", run: { ...open, state: "superseded" }, expectedState: ["pending"] });
      notices.push(`superseded unclaimed ${open.id}`);
    } else {
      notices.push(`skipped fire on ${task.id} — run ${open.id} is ${open.state} (overlap forbid)`);
      return cs;
    }
  }
  cs.runs.push({
    op: "insert",
    run: {
      id,
      taskId: task.id,
      cause: "cron",
      scheduledAt,
      state: "pending",
      assignee: task.assignee,
      triggerId: trigger.id,
      createdAt: now,
    },
  });
  return cs;
}

function fireOnce(
  snapshot: Snapshot,
  trigger: Trigger,
  task: TaskObject,
  now: string,
  notices: string[],
): Changeset {
  const cs = emptyChangeset();
  const scheduledAt = trigger.nextFireAt as string;
  // The once slot is consumed either way (CAS on the trigger we read).
  cs.triggers.push({ op: "delete", id: trigger.id, expected: trigger });

  // Corrupt-alarm check: `due()` keys on nextFireAt, but the wake decision keys
  // on `spec` (the followUpAt generation). A kernel-built once trigger always
  // has spec===nextFireAt; the M2 store is user-editable files, so a divergence
  // means the firing cursor is not the alarm the task actually set — discard it,
  // never flip status or dispatch off a stale cursor (finding: once fires off a
  // stale nextFireAt). Folds into the same trigger-discarded path below.
  if (
    trigger.spec !== trigger.nextFireAt ||
    task.status !== "follow-up" ||
    task.followUpAt !== trigger.spec
  ) {
    cs.objects.push({
      object: { ...task, version: task.version + 1, updatedAt: now },
      expectedVersion: task.version,
    });
    cs.events.push({
      id: eventId(task.id, task.version + 1, "trigger-discarded"),
      objectId: task.id,
      kind: "trigger-discarded",
      at: now,
      note: `stale once trigger (${trigger.spec}) discarded — task is ${task.status}${
        task.followUpAt ? ` waiting until ${task.followUpAt}` : ""
      }`,
      provenance: { entrance: "clock", actorId: trigger.id },
    });
    notices.push(`discarded stale once trigger on ${task.id}`);
    return cs;
  }

  // The wait ended: flip follow-up -> todo, then the dispatch rule takes over.
  const flipped: TaskObject = {
    ...task,
    status: "todo",
    followUpAt: null,
    version: task.version + 1,
    updatedAt: now,
  };
  cs.objects.push({ object: flipped, expectedVersion: task.version });
  cs.events.push({
    id: eventId(task.id, flipped.version, "status-changed"),
    objectId: task.id,
    kind: "status-changed",
    at: now,
    diff: {
      status: { old: "follow-up", new: "todo" },
      followUpAt: { old: trigger.spec, new: null },
    },
    provenance: { entrance: "clock", actorId: trigger.id },
  });

  if (!isDispatchable(flipped.assignee)) {
    // A person's (or nobody's) wait surfaces via todo/inbox — no run.
    return cs;
  }
  const id = runId("once", trigger.id, scheduledAt);
  if (snapshot.runs.some((r) => r.id === id) || activeRun(snapshot, task.id)) {
    notices.push(`fire ${id} skipped — already dispatched or run active`);
    return cs;
  }
  cs.runs.push({
    op: "insert",
    run: {
      id,
      taskId: task.id,
      cause: "once",
      scheduledAt,
      state: "pending",
      assignee: flipped.assignee,
      triggerId: trigger.id,
      createdAt: now,
    },
  });
  return cs;
}
