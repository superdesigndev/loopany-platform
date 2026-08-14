import type { RunRecord, Snapshot, TaskObject } from "./types.js";

/** Machine segment of a remote execution address (`alias/profile`). Person
 * addresses and local-driver bare profiles carry no machine affinity. */
export function executionAddressMachine(address: string | null): string | null {
  if (!address || address.startsWith("person:") || address.includes("@")) return null;
  const slash = address.indexOf("/");
  return slash > 0 && slash < address.length - 1 ? address.slice(0, slash) : null;
}

function latestRunMachine(runs: readonly RunRecord[], taskId: string): string | null {
  const ordered = runs
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const run of ordered) {
    const machine = executionAddressMachine(run.assignee);
    if (machine) return machine;
  }
  return null;
}

/** Derive a Task's execution home without storing a second machine field.
 * A null workdir is intentionally portable. A child with a machine-local
 * workdir belongs to the nearest ancestor with an execution address/history;
 * a root falls back to its own current address or latest Run. */
export function taskExecutionMachine(snapshot: Snapshot, task: TaskObject): string | null {
  if (task.workdir === null) return null;
  const seen = new Set<string>([task.id]);
  let parentId = task.parent;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = snapshot.objects[parentId];
    if (!parent || parent.archetype !== "task") break;
    const machine = executionAddressMachine(parent.assignee) ?? latestRunMachine(snapshot.runs, parent.id);
    if (machine) return machine;
    parentId = parent.parent;
  }
  return executionAddressMachine(task.assignee) ?? latestRunMachine(snapshot.runs, task.id);
}
