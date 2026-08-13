import type { Obj, Select } from "./model";
import { AgentRef, PersonRef } from "./IdentityRefs";
import { LocalTime } from "./DisplayPrimitives";
import { pill, statusDot } from "./styles";

const LINK = "cursor-pointer border-0 bg-transparent p-0 text-left text-[#174f78] underline decoration-[#aaa] underline-offset-2";

export function TaskRef({ task, select, showStatus = false }: { task: Obj; select: Select; showStatus?: boolean }) {
  return <button className={LINK} onClick={() => select("task", task.id)}>
    {task.title ?? task.id}{showStatus && <span className="ml-2 text-[#666] no-underline">· {task.status}</span>}
  </button>;
}

export function RunRef({ run, select, compact = false }: { run: Obj; select: Select; compact?: boolean }) {
  const profile = run.assignee?.includes("/") ? run.assignee.slice(run.assignee.lastIndexOf("/") + 1) : "agent";
  return <button className={LINK} onClick={() => select("run", run.id)} title={run.id}>
    {profile} Run · {run.state}{!compact && <> · <LocalTime value={run.createdAt} /></>}
  </button>;
}

export function ArtifactRef({ entry, select, actions }: { entry: Obj; select: Select; actions?: string[] }) {
  const artifact = entry.artifact ?? entry;
  const label = artifact.title ?? artifact.key ?? artifact.coords ?? artifact.id;
  const suffix = actions?.length ? ` · ${actions.join(" + ")}` : "";
  if (artifact.archetype === "doc") return <button className={LINK} onClick={() => select("doc", artifact.id)}>doc · {label}{suffix}</button>;
  return <span>mirror · {label}{suffix}</span>;
}

export function MachineRef({ machine, data, select, detailed = false }: { machine: Obj; data: Obj; select: Select; detailed?: boolean }) {
  return <span className="flex min-w-0 flex-1 items-center gap-[11px]">
    <span className={statusDot(machine.online)} aria-hidden="true" />
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <strong className="overflow-hidden text-ellipsis">{machine.alias ?? machine.name}</strong>
      <small className="text-[#6a6a6a] wrap-anywhere">{machine.name} · {machine.platform ?? "unknown platform"}</small>
      {detailed && <small className="text-[#6a6a6a] wrap-anywhere">{machine.agentProfiles === null ? "Agent capabilities not reported" : machine.agentProfiles?.length ? <>Agents: {machine.agentProfiles.map((profile: string, index: number) => <span key={profile}>{index > 0 && ", "}<AgentRef value={`${machine.alias ?? machine.name}/${profile}`} /></span>)}</> : "No executable agents detected"}</small>}
      {machine.enrolledBy && <small className="text-[#6a6a6a] wrap-anywhere">Owned by <PersonRef value={`person:${machine.enrolledBy}`} data={data} select={select} /></small>}
    </span>
    <span className="flex items-center gap-[5px] max-[600px]:flex-col max-[600px]:items-end">
      <code className={pill(machine.online)}>{machine.online ? "ONLINE" : "OFFLINE"}</code>
      {machine.mine && <code className={pill()}>YOURS</code>}
    </span>
  </span>;
}
