import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { isSelected, type Obj, type Select, type Selection } from "./model";
import { AgentRef, AssigneeRef, PersonRef } from "./IdentityRefs";
import { AgentSessionRef } from "./AgentSessionRef";
import { LocalTime } from "./DisplayPrimitives";
import { RunRef, TaskRef } from "./ObjectRefs";
import { Empty, Section } from "./primitives";
import { cx, MUTED } from "./styles";

function ActorRef({ value, data, select }: { value: string; data: Obj; select: Select }) {
  if (value.startsWith("human:")) {
    const identity = value.slice("human:".length);
    if (identity === "anonymous") return <>by Human</>;
    return <>by <PersonRef value={identity} data={data} select={select} /></>;
  }
  if (value.startsWith("clock:")) return <>by System</>;
  if (value.startsWith("agent:")) return <>by <AgentRef value={value.slice("agent:".length)} /></>;
  return <>{value}</>;
}

function summary(item: Obj, data: Obj, select: Select): ReactNode {
  if (item.kind === "handoff") {
    const match = String(item.summary).match(/^(.*?) → (.*?)(?:: (.*))?$/);
    if (match) return <><AssigneeRef value={match[1]!} data={data} select={select} /> <span className={MUTED}>handed off to</span> <AssigneeRef value={match[2]!} data={data} select={select} />{match[3] && <span> · {match[3]}</span>}</>;
  }
  const parts = String(item.summary).split(/(person:[A-Za-z0-9_-]+)/g);
  return parts.map((part, index) => part.startsWith("person:")
    ? <PersonRef key={`${part}:${index}`} value={part} data={data} select={select} />
    : <Fragment key={index}>{part}</Fragment>);
}

export function TimelineList({ items, data, selection, select, compact = false }: { items: Obj[]; data: Obj; selection: Selection | null; select: Select; compact?: boolean }) {
  const selectedRow = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!compact || !selection?.eventKey || !selectedRow.current) return;
    selectedRow.current.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [compact, items, selection?.eventKey]);
  if (!items.length) return <Empty text="No recent activity" />;
  return <div className="relative">
    {items.map((item, index) => {
      const kind = item.runId ? "run" as const : (data.documents ?? []).some((entry: Obj) => entry.id === item.objectId) ? "doc" as const : "task" as const;
      const id = item.runId ?? item.objectId;
      const key = item.eventIds.join(":");
      const selected = selection?.eventKey === key && isSelected(selection, kind, id);
      const task = (data.tasks ?? []).find((entry: Obj) => entry.id === item.objectId);
      const run = item.runId ? [...(data.activeRuns ?? []), ...(data.recentRuns ?? [])].find((entry: Obj) => entry.id === item.runId) : null;
      return <div
        key={key}
        ref={selected ? selectedRow : undefined}
        className={cx("group/event grid cursor-pointer", compact ? "grid-cols-[76px_18px_minmax(0,1fr)]" : "grid-cols-[92px_20px_minmax(0,1fr)]")}
        onClick={() => select(kind, id, key)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(kind, id, key); } }}
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
      >
        <div className={cx("py-3 text-right text-[#777]", compact ? "pr-2 text-[11px]" : "pr-3")}><LocalTime value={item.at} variant="timeline" /></div>
        <span className="relative flex justify-center" aria-hidden="true">
          <span className={cx("absolute left-1/2 w-px -translate-x-1/2 bg-[#bbb]", index === 0 ? "top-1/2" : "top-0", index === items.length - 1 ? "bottom-1/2" : "bottom-0")} />
          <span className="relative mt-[18px] size-[7px] bg-[#555]" />
        </span>
        <div className={cx("min-w-0 border-b border-[#ddd] py-3 pr-3 pl-3 group-hover/event:bg-[#f0f0ed]", selected && "bg-[#e9e9e6]") }>
          <div className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1 leading-[1.55]">{summary(item, data, select)}</span>
            <span className="shrink-0 border border-[#aaa] px-1.5 py-0.5 text-[9px] uppercase text-[#666]">{item.kind}</span>
          </div>
          {!compact && task?.title && <div className="mt-1 text-[11px] font-semibold"><TaskRef task={task} select={select} compact /></div>}
          <div className="mt-1 text-[10px] text-[#777]">
            {item.runId ? (run ? <RunRef run={run} select={select} compact /> : <>run:{item.runId}</>) : <ActorRef value={item.actor} data={data} select={select} />}
            {item.agentSessionId ? <> · <AgentSessionRef sessionId={item.agentSessionId} assignee={item.agent} compact /></> : null}
          </div>
        </div>
      </div>;
    })}
  </div>;
}

export function TimelineView({ items, data, selection, select }: { items: Obj[]; data: Obj; selection: Selection | null; select: Select }) {
  return <Section title="Team Timeline" sub="Recent meaningful activity">
    <TimelineList items={items} data={data} selection={selection} select={select} />
  </Section>;
}
