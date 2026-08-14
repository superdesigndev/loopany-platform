import type { Changeset, Command, Snapshot, TaskObject } from "./types.js";

export interface OperationalContext {
  changed: string[];
  taskId: string | null;
  run: {
    createdId: string | null;
    retainedId: string | null;
    supersededId: string | null;
    consequence: "created" | "retained" | "superseded" | "superseded-and-replaced" | "none";
  };
  machine: { alias: string; presence: string } | null;
  nextTriggerAt: string | null;
  action: string | null;
  nextCommand: string | null;
}

/** Project the immediate consequence of one successful write from facts owned by
 * that write: its applied changeset and the authoritative post-apply snapshot.
 * Run attribution never compares a later read, so an interleaved writer cannot
 * be credited to this command. */
export function projectOperationalContext(
  command: Command,
  changeset: Changeset,
  after: Snapshot,
  presence?: Readonly<Record<string, string>>,
): OperationalContext {
  const targeted = command as Command & { id?: string; attachTask?: string; patch?: Record<string, unknown> };
  const candidate = targeted.attachTask ?? targeted.id ?? (command.op === "create" ? changeset.objects[0]?.object.id : undefined);
  const taskId = candidate && after.objects[candidate]?.archetype === "task" ? candidate : null;
  const runMutations = taskId
    ? changeset.runs.filter((m) => m.run.taskId === taskId)
    : [];
  const created = runMutations.find((m) => m.op === "insert")?.run ?? null;
  const superseded = runMutations.find((m) => m.op === "put" && m.run.state === "superseded")?.run ?? null;
  const retained = !created && !superseded && taskId
    ? after.runs.find((r) => r.taskId === taskId && (r.state === "pending" || r.state === "claimed" || r.state === "running")) ?? null
    : null;
  const consequence = superseded && created ? "superseded-and-replaced" : superseded ? "superseded" : created ? "created" : retained ? "retained" : "none";
  const task = taskId && after.objects[taskId]?.archetype === "task" ? after.objects[taskId] as TaskObject : null;
  const alias = task?.assignee?.includes("/") ? task.assignee.slice(0, task.assignee.indexOf("/")) : null;
  const machine = alias
    ? { alias, presence: presence ? presence[alias] ?? "unregistered" : "unavailable" }
    : null;
  const trigger = taskId
    ? after.triggers.filter((t) => t.taskId === taskId && t.enabled && t.nextFireAt).sort((a, b) => a.nextFireAt!.localeCompare(b.nextFireAt!))[0]
    : undefined;
  let action: string | null = null;
  let nextCommand: string | null = null;
  if (machine && machine.presence !== "online" && machine.presence !== "unavailable" && (created || retained)) {
    action = machine.presence === "unregistered"
      ? `human action needed: machine alias "${machine.alias}" is not registered; this pending run cannot be delivered`
      : `no action required if the daemon will reconnect; the pending run is retained for the ${machine.presence} machine`;
    if (machine.presence === "unregistered" && taskId) nextCommand = `lk update ${taskId} assignee=<registered-machine/agent> --note "correct dispatch target"`;
  } else if (created) {
    action = "no action required; the run is queued for delivery";
  } else if (task?.status === "todo" && task.assignee && !task.assignee.includes("@") && !retained && !trigger) {
    action = "manual dispatch is needed to run this task now";
    nextCommand = `lk run ${task.id}`;
  } else if (trigger?.nextFireAt) {
    action = "no action required; the task has a future trigger";
  }
  const changed = command.op === "update"
    ? Object.keys(targeted.patch ?? {})
    : command.op === "note" ? ["note"] : command.op === "doc-put" ? ["doc"] : command.op === "doc-append" ? ["doc appended"] : command.op === "mirror-add" ? ["mirror"] : command.op === "run" ? ["manual run"] : ["task"];
  return { changed, taskId, run: { createdId: created?.id ?? null, retainedId: retained?.id ?? null, supersededId: superseded?.id ?? null, consequence }, machine, nextTriggerAt: trigger?.nextFireAt ?? null, action, nextCommand };
}
