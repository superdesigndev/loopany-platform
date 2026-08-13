import type { Obj, Select } from "./model";
import { Empty, Section } from "./primitives";
import { cx, EYEBROW, pill } from "./styles";
import { AgentRef, PersonRef } from "./IdentityRefs";
import { MachineRef } from "./ObjectRefs";
import { CopyAction, LocalTime } from "./DisplayPrimitives";

const ROW = "flex min-w-0 items-center gap-[11px] border-b border-[#e2e2e2] px-[14px] py-[13px] last:border-b-0 max-[600px]:items-start";
const COPY = "flex min-w-0 flex-1 flex-col gap-1";
const COPY_SUB = "text-[#6a6a6a] wrap-anywhere";
const MARK = "grid size-8 flex-none place-items-center border border-[#aaa] bg-[#f7f7f5] font-bold";

/** Who and what may act inside this Team: people, enrolled machines, and the
 *  agent execution addresses those machines report. */
export function TeamDirectory({ data, agents, select }: { data: Obj; agents: string[]; select: Select }) {
  const people = data.members ?? [];
  const machines = data.machines ?? [];
  const setupCommand = `lk setup /${data.team.slug} --server ${typeof window === "undefined" ? "https://your-loopany-server" : window.location.origin}`;
  return <Section title={data.team.name} sub="Canonical people, enrolled machines, and agent execution addresses">
    <div className="grid gap-[18px]">
      <DirectoryGroup title="People" count={people.length} description="Members who can work inside this Team.">
        {people.length
          ? people.map((person: Obj) => <div className={ROW} key={person.id}>
            <span className={MARK} aria-hidden="true">{(person.name || person.email || "?")[0]?.toUpperCase()}</span>
            <span className={COPY}>
              <strong className="overflow-hidden text-ellipsis"><PersonRef value={`person:${person.id}`} data={data} select={select} /></strong>
              {person.email && <small className={COPY_SUB}>{person.email}</small>}
            </span>
            <code className={pill()}>{person.role}</code>
          </div>)
          : <Empty text="No members" />}
      </DirectoryGroup>
      <DirectoryGroup title="Machines" count={machines.length} description="Computers currently authorized to execute work for this Team.">
        {machines.length ? machines.map((machine: Obj) => <div className={ROW} key={machine.id}><MachineRef machine={machine} data={data} select={select} detailed /></div>) : <Empty text="No machines enrolled" />}
      </DirectoryGroup>
      <DirectoryGroup title="Agents" count={agents.length} description="Execution addresses reported by connected Machines.">
        {agents.length
          ? agents.map((address) => <AgentRow key={address} address={address} entry={data.agentAddresses?.find((item: Obj) => item.address === address)} />)
          : <Empty text="No agent addresses reported yet" />}
      </DirectoryGroup>
      <div className="grid gap-[14px] border border-[#9d9d9d] bg-[#ecece8] p-4">
        <div>
          <span className={EYEBROW}>CONNECT A COMPUTER</span>
          <h2 className="mt-1 mb-[5px] text-[16px]">Set up this Team</h2>
          <p className="leading-[1.5] text-[#5b5b5b]">Sign in, start the Machine runtime, and authorize this Team in one command.</p>
        </div>
        <div className="flex min-w-0 border border-[#171717] bg-[#171717] text-[#f7f7f2] max-[600px]:block">
          <code className="flex-1 overflow-auto px-3 py-[11px] whitespace-nowrap">{setupCommand}</code>
          <CopyAction value={setupCommand} variant="command" ariaLabel="Copy setup command" />
        </div>
      </div>
    </div>
  </Section>;
}

function DirectoryGroup({ title, count, description, children }: { title: string; count: number; description: string; children: React.ReactNode }) {
  return <section className="border border-[#c8c8c8] bg-white">
    <header className="flex items-start justify-between border-b border-[#d5d5d5] bg-[#f3f3f1] px-[14px] py-3">
      <div>
        <h2 className="mb-1 text-[14px]">{title}</h2>
        <p className="text-[11px] leading-[1.45] text-[#666]">{description}</p>
      </div>
      <span className="text-[20px] leading-none text-[#999]">{String(count).padStart(2, "0")}</span>
    </header>
    <div>{children}</div>
  </section>;
}

function AgentRow({ address, entry }: { address: string; entry?: Obj }) {
  return <div className={ROW}>
    <span className={cx(MARK, "text-[11px] text-[#555]")} aria-hidden="true">›_</span>
    <span className={COPY}>
      <strong className="overflow-hidden text-ellipsis"><AgentRef value={address} /></strong>
      <small className={COPY_SUB}>{entry ? <>{entry.availability}{entry.lastSucceededAt ? <> · last succeeded <LocalTime value={entry.lastSucceededAt} /></> : null}</> : "Historical execution address"}</small>
    </span>
    <code className={pill(entry?.availability === "available")}>{entry?.availability?.toUpperCase() ?? "OBSERVED"}</code>
  </div>;
}
