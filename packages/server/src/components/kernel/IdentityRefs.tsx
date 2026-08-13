import type { Obj, Select } from "./model";
import { MUTED } from "./styles";

function memberFor(value: string, data: Obj) {
  const id = value.startsWith("person:") ? value.slice(7) : null;
  const email = value.toLowerCase();
  return (data.members ?? []).find((member: Obj) => member.id === id || member.email?.toLowerCase() === email);
}

/** The single visual representation of a person address in Kernel Web. */
export function PersonRef({ value, data, select }: { value: string; data: Obj; select: Select }) {
  const member = memberFor(value, data);
  const label = member?.name || member?.email || value;
  if (!member) return <span>{value === "—" ? "Unassigned" : value}</span>;
  const open = (data.tasks ?? []).filter((task: Obj) => task.assignee === `person:${member.id}` && !["done", "archived"].includes(task.status)).length;
  return <button
    type="button"
    className="group/person relative cursor-pointer border-0 bg-transparent p-0 text-[#174f78] underline decoration-[#aaa] underline-offset-2"
    onClick={(event) => { event.stopPropagation(); select("member", member.id); }}
  >
    {label}
    <span className="pointer-events-none absolute bottom-[calc(100%+6px)] left-0 z-20 hidden min-w-52 border border-[#999] bg-[#fafafa] p-2 text-left text-[11px] leading-[1.5] text-[#171717] no-underline shadow-[3px_3px_0_#ddd] group-hover/person:block group-focus/person:block">
      <strong className="block">{member.name || member.email || "Team member"}</strong>
      {member.email && <span className="block text-[#666]">{member.email}</span>}
      <span className="block text-[#666]">{member.role} · {open} open task{open === 1 ? "" : "s"}</span>
    </span>
  </button>;
}

export function AgentRef({ value }: { value: string }) {
  const slash = value.lastIndexOf("/");
  if (slash < 0) return <span>{value}</span>;
  return <span className="text-[#59457c]">{value.slice(slash + 1)} <span className={MUTED}>on {value.slice(0, slash)}</span></span>;
}

export function AssigneeRef({ value, data, select }: { value?: string | null; data: Obj; select: Select }) {
  if (!value) return <span>Unassigned</span>;
  return value.startsWith("person:") || memberFor(value, data)
    ? <PersonRef value={value} data={data} select={select} />
    : value.includes("/") ? <AgentRef value={value} />
    : <span>{value}</span>;
}
