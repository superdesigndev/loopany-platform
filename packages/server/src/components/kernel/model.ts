import type { AssigneeOption } from "./AssigneePicker";

/** The Kernel web API returns already-shaped view payloads; the client treats
 *  them as opaque records rather than re-declaring the server's row types. */
export type Obj = Record<string, any>;
export type View = "inbox" | "tasks" | "documents" | "timeline" | "settings";
export type SettingsSection = "team" | "machines" | "notifications";
export type TaskLayout = "tree" | "board";
export type SelectionKind = "task" | "doc" | "run" | "member";
export type Selection = { kind: SelectionKind; id: string; eventKey?: string };
export type LoadedDetail = Selection & { value: Obj };
/** Open an object in the detail pane. One signature for every list surface. */
export type Select = (kind: SelectionKind, id: string, eventKey?: string) => void;

/** Is this row the object currently open in the detail pane? Kind matters: a
 *  Run and its Task can carry the same row position in the Timeline. */
export const isSelected = (selection: Selection | null, kind: SelectionKind, id: string) => selection?.kind === kind && selection.id === id;

export const fmt = (iso?: string) => iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "-";
export const agentProfile = (assignee?: string | null) => (assignee?.includes("/") ? assignee.split("/").pop() : null) ?? null;

export function knownAgents(data: Obj | null): string[] {
  if (!data) return [];
  if (Array.isArray(data.agentAddresses)) return data.agentAddresses.map((item: Obj) => item.address);
  // Compatibility with a server that predates Machine capability reporting.
  const addresses = [
    ...data.tasks.map((task: Obj) => task.assignee),
    ...data.activeRuns.map((run: Obj) => run.assignee),
    ...data.recentRuns.map((run: Obj) => run.assignee),
  ];
  return [...new Set(addresses.filter((value): value is string => typeof value === "string" && value.includes("/")))].sort();
}

export function assigneeOptions(data: Obj | null): AssigneeOption[] {
  if (!data) return [];
  const people = (data.members ?? []).map((person: Obj) => ({
    value: `person:${person.id}`,
    label: person.name || person.email,
    detail: [person.email, person.role].filter(Boolean).join(" · "),
    kind: "person" as const,
  }));
  const agents = (data.agentAddresses ?? []).map((entry: Obj) => ({
    value: entry.address,
    label: entry.address,
    detail: entry.availability,
    kind: "agent" as const,
  }));
  return [...people, ...agents];
}

export function assigneeLabel(value: string | null, options: readonly AssigneeOption[]): string {
  if (!value) return "-";
  const option = options.find((item) => item.value === value);
  return option ? `${option.label} (${value})` : value;
}

/** A Task is a "loop" when a cron Trigger points at it. */
export function isLoop(data: Obj, id: string): boolean {
  return data.triggers.some((trigger: Obj) => trigger.taskId === id && trigger.kind === "cron");
}
