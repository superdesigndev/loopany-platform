import type { AssigneeOption } from "./AssigneePicker";
import { useEffect, useState } from "react";
import { agentProfile, type Obj, type Select, type Selection } from "./model";
import { Empty, Field, Fields } from "./primitives";
import { MUTED, PRE_BODY } from "./styles";
import { TaskActions } from "./TaskActions";
import { AssigneeRef, PersonRef } from "./IdentityRefs";
import { TimelineList } from "./TimelineView";
import { AgentSessionRef } from "./AgentSessionRef";
import { ArtifactRef, MachineRef, RunRef, TaskRef } from "./ObjectRefs";
import { LocalTime } from "./DisplayPrimitives";
import { MarkdownDocument } from "./MarkdownDocument";
import { RunTranscript } from "./RunTranscript";
import { useRunTranscript } from "./useWorkspace";

const TITLE = "mb-1.5 text-[18px]";
const HEADING = "mt-7 mb-3 text-[12px] uppercase tracking-[0.02em]";
const EVENT = "border-b border-[#ddd] py-[7px]";

/** The right-hand inspector. One pane, three object shapes. */
export function DetailPanel({ selection, detail, data, select, teamSlug, reload, assignees }: { selection: Selection; detail: Obj | null; data: Obj; select: Select; teamSlug: string; reload: () => Promise<void>; assignees: AssigneeOption[] }) {
  if (!detail) return <Empty text="Loading detail..." />;
  if (selection.kind === "doc") return <DocumentDetail detail={detail} select={select} />;
  if (selection.kind === "run") return <RunDetail detail={detail} data={data} select={select} teamSlug={teamSlug} />;
  if (selection.kind === "member") return <MemberDetail detail={detail} data={data} select={select} />;
  return <TaskDetail detail={detail} data={data} selection={selection} select={select} teamSlug={teamSlug} reload={reload} assignees={assignees} />;
}

function MemberDetail({ detail, data, select }: { detail: Obj; data: Obj; select: Select }) {
  const member = detail.member;
  return <div>
    <h2 className={TITLE}>{member.name || member.email || "Team member"}</h2>
    <div className={MUTED}>PERSON · {member.role}</div>
    <Fields>
      <Field label="Email">{member.email ?? "-"}</Field>
      <Field label="Open Tasks">{detail.tasks.length}</Field>
      <Field label="Machines">{detail.machines.length}</Field>
    </Fields>
    <h3 className={HEADING}>Assigned Tasks</h3>
    {detail.tasks.length ? detail.tasks.map((task: Obj) => <TaskRef key={task.id} task={task} select={select} />) : <Empty text="No open Tasks" />}
    <h3 className={HEADING}>Machines</h3>
    {detail.machines.length ? detail.machines.map((machine: Obj) => <div className={EVENT} key={machine.id}><MachineRef machine={machine} data={data} select={select} /></div>) : <Empty text="No Machines" />}
  </div>;
}

function DocumentDetail({ detail, select }: { detail: Obj; select: Select }) {
  const doc = detail.doc;
  return <div>
    <h2 className={TITLE}>{doc.title ?? doc.key}</h2>
    <div className={MUTED}>DOC · v{doc.version} · <LocalTime value={doc.updatedAt} /></div>
    <MarkdownDocument body={doc.body} />
    {detail.linkedTasks.map((task: Obj) => <TaskRef key={task.id} task={task} select={select} />)}
  </div>;
}

function RunDetail({ detail, data, select, teamSlug }: { detail: Obj; data: Obj; select: Select; teamSlug: string }) {
  const run = detail.run;
  const transcript = useRunTranscript(run.id, teamSlug, ["pending", "claimed", "running"].includes(run.state));
  const profile = agentProfile(run.assignee);
  const workflowOnly = Boolean(run.workflow && !run.agentSessionId);
  const executor = workflowOnly ? "workflow" : (profile ?? "agent unknown");
  const eventResult = [...(detail.events ?? [])].reverse().find((event: Obj) => event.kind === "note" && event.note?.trim())?.note;
  const result = eventResult ?? run.workflow?.message?.trim() ?? null;
  return <div>
    <h2 className={TITLE}>{run.id}</h2>
    <div className={MUTED}>RUN · {run.state} · {executor}</div>
    <Fields>
      <Field label="Task">{detail.task ? <TaskRef task={detail.task} select={select} compact /> : run.taskId}</Field>
      <Field label="Cause">{run.cause}</Field>
      <Field label="Assignee"><AssigneeRef value={run.assignee} data={data} select={select} /></Field>
      <Field label="Workdir">{detail.task?.workdir ?? "-"}</Field>
      <Field label="Started"><LocalTime value={run.createdAt} /></Field>
      <Field label="Workflow">{run.workflow ? `${run.workflow.format} · ${run.workflow.outcome}` : "not configured"}</Field>
      <Field label="Agent session">{workflowOnly ? "Not started - workflow completed directly" : <AgentSessionRef sessionId={run.agentSessionId} assignee={run.assignee} workdir={detail.task?.workdir} />}</Field>
    </Fields>
    <h3 className={HEADING}>Result</h3>
    <div className="border-y border-[#ccc] py-3 leading-[1.55] whitespace-pre-wrap">{result ?? "No substantive result note recorded"}</div>
    <h3 className={HEADING}>Runtime</h3>
    <div className="border-y border-[#ccc] py-3 leading-[1.55]">{run.note ?? "No runtime outcome recorded"}</div>
    <h3 className={HEADING}>Transcript</h3>
    <RunTranscript value={transcript} />
    <h3 className={HEADING}>Task changes</h3>
    <RunActivity events={detail.events ?? []} />
    <h3 className={HEADING}>Artifacts touched</h3>
    {detail.artifacts.length
      ? detail.artifacts.map((item: Obj) => <ArtifactRef key={item.artifact.id} entry={item} actions={item.actions} select={select} />)
      : <Empty text="No artifacts recorded for this run" />}
  </div>;
}

function RunActivity({ events }: { events: Obj[] }) {
  if (!events.length) return <Empty text="No Run activity recorded" />;
  return <div className="relative">
    {events.map((event, index) => <div key={event.id} className="grid grid-cols-[76px_18px_minmax(0,1fr)] text-[11px] leading-[1.5]">
      <div className="py-3 pr-2 text-right text-[#777]"><LocalTime value={event.at} variant="timeline" /></div>
      <span className="relative flex justify-center" aria-hidden="true">
        <span className={`absolute left-1/2 w-px -translate-x-1/2 bg-[#bbb] ${index === 0 ? "top-1/2" : "top-0"} ${index === events.length - 1 ? "bottom-1/2" : "bottom-0"}`} />
        <span className="relative mt-[18px] size-[7px] bg-[#555]" />
      </span>
      <div className="min-w-0 border-b border-[#ddd] py-3 pr-2 pl-3">
        <code className="inline-block border border-[#aaa] px-1.5 py-0.5 text-[9px] uppercase text-[#666]">{event.kind}</code>
        <div className="mt-2 wrap-anywhere whitespace-pre-wrap">{event.note ?? describeEventDiff(event.diff) ?? "Recorded"}</div>
      </div>
    </div>)}
  </div>;
}

function describeEventDiff(diff: Obj | null | undefined): string | null {
  if (!diff) return null;
  const fields = Object.entries(diff).map(([field, value]) => {
    const change = value as { old?: unknown; new?: unknown };
    return `${field}: ${String(change?.old ?? "-")} → ${String(change?.new ?? "-")}`;
  });
  return fields.length ? fields.join(" · ") : null;
}

function TaskDetail({ detail, data, selection, select, teamSlug, reload, assignees }: { detail: Obj; data: Obj; selection: Selection; select: Select; teamSlug: string; reload: () => Promise<void>; assignees: AssigneeOption[] }) {
  const task = detail.task;
  const [recentLimit, setRecentLimit] = useState(8);
  useEffect(() => setRecentLimit(8), [task.id]);
  return <div>
    <div className="flex justify-between">
      <h2 className={TITLE}>{task.title}</h2>
      {detail.activeRun && <RunRef run={detail.activeRun} select={select} compact />}
    </div>
    <div className={MUTED}>{task.id} · v{task.version}</div>
    <Fields>
      <Field label="Status">{task.status}</Field>
      <Field label="Owner">{task.owner ? <PersonRef value={task.owner} data={data} select={select} /> : "-"}</Field>
      <Field label="Assignee"><AssigneeRef value={task.assignee} data={data} select={select} /></Field>
      <Field label="Workdir">{task.workdir ?? "-"}</Field>
      <Field label="Goal">{task.goal ?? "-"}</Field>
      <Field label="Workflow">{task.workflow?.format ?? "-"}</Field>
    </Fields>
    <TaskActions key={task.id} task={task} teamSlug={teamSlug} reload={reload} assignees={assignees} />
    <h3 className={HEADING}>Spec</h3>
    <MarkdownDocument body={task.body || "_No spec_"} />
    <h3 className={HEADING}>Children</h3>
    {detail.children.length ? detail.children.map((child: Obj) => <TaskRef key={child.id} task={child} select={select} />) : <Empty text="No child Tasks" />}
    <h3 className={HEADING}>Artifacts</h3>
    {detail.artifacts.length ? detail.artifacts.map((entry: Obj) => <ArtifactRef key={entry.artifact.id} entry={entry} select={select} />) : <Empty text="No artifacts" />}
    <h3 className={HEADING}>Recent</h3>
    <TimelineList items={detail.recent.slice(0, recentLimit)} data={data} selection={selection} select={select} compact />
    {recentLimit < detail.recent.length && <button className="mx-auto my-3 block cursor-pointer border-0 bg-transparent p-1 text-center text-[#174f78] underline decoration-[#aaa] underline-offset-2" onClick={() => setRecentLimit((value) => value + 8)}>Load more</button>}
    {recentLimit >= detail.recent.length && detail.recentHasMore && <div className="py-2 text-center text-[11px] text-[#777]">More activity exists outside this recent window</div>}
    <h3 className={HEADING}>Runs</h3>
    {detail.runs.length ? detail.runs.slice(0, 10).map((run: Obj) => <RunRef key={run.id} run={run} select={select} />) : <Empty text="No Runs" />}
  </div>;
}
