import type { Obj, Select } from "./model";
import { AgentRef, PersonRef } from "./IdentityRefs";
import { LocalTime } from "./DisplayPrimitives";
import { pill, statusDot } from "./styles";

const LINK = "cursor-pointer border-0 bg-transparent p-0 text-left text-[#174f78] underline decoration-[#aaa] underline-offset-2";
const ROW = "group/ref flex w-full cursor-pointer items-start gap-3 border-0 border-b border-[#ddd] bg-transparent px-2 py-3 text-left hover:bg-[#f0f0ed]";
const TAG = "mt-px w-12 shrink-0 border border-[#aaa] px-1.5 py-0.5 text-center text-[9px] uppercase text-[#666]";

function RefRow({ tag, title, meta, onClick }: { tag: string; title: React.ReactNode; meta?: React.ReactNode; onClick: () => void }) {
  return <button className={ROW} onClick={onClick}>
    <code className={TAG}>{tag}</code>
    <span className="min-w-0 flex-1">
      <strong className="block leading-[1.4] text-[#171717] group-hover/ref:text-[#174f78]">{title}</strong>
      {meta && <small className="mt-1.5 block leading-[1.4] text-[#777]">{meta}</small>}
    </span>
  </button>;
}

export function TaskRef({ task, select, compact = false }: { task: Obj; select: Select; compact?: boolean }) {
  if (compact) return <button className={LINK} onClick={() => select("task", task.id)}>{task.title ?? task.id}</button>;
  return <RefRow tag="TASK" title={task.title ?? task.id} meta={`${task.status}${task.priority ? ` · ${task.priority}` : ""}`} onClick={() => select("task", task.id)} />;
}

export function RunRef({ run, select, compact = false }: { run: Obj; select: Select; compact?: boolean }) {
  const profile = run.assignee?.includes("/") ? run.assignee.slice(run.assignee.lastIndexOf("/") + 1) : "agent";
  if (compact) return <button className={LINK} onClick={() => select("run", run.id)} title={run.id}>{profile} Run · {run.state}</button>;
  return <RefRow
    tag="RUN"
    title={<>{profile} · {run.state}</>}
    meta={<><LocalTime value={run.createdAt} />{run.agentSessionId ? <> · session {run.agentSessionId.length > 12 ? `${run.agentSessionId.slice(0, 8)}…` : run.agentSessionId}</> : null}</>}
    onClick={() => select("run", run.id)}
  />;
}

export function ArtifactRef({ entry, select, actions }: { entry: Obj; select: Select; actions?: string[] }) {
  const artifact = entry.artifact ?? entry;
  const label = artifact.title ?? artifact.key ?? artifact.coords ?? artifact.id;
  const suffix = actions?.length ? ` · ${actions.join(" + ")}` : "";
  const meta = <>{artifact.key && artifact.key !== label ? artifact.key : artifact.id}{suffix}</>;
  if (artifact.archetype === "doc") return <RefRow tag="DOC" title={label} meta={meta} onClick={() => select("doc", artifact.id)} />;
  return <div className={ROW}><code className={TAG}>MIRROR</code><span className="min-w-0 flex-1"><strong className="block leading-[1.45]">{label}</strong><small className="mt-1 block text-[#777]">{meta}</small></span></div>;
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
