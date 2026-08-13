import { useCallback, useEffect, useState } from "react";
import type { Obj } from "./model";
import { Empty, Section } from "./primitives";
import { cx, ERROR, EYEBROW, FOCUS_RING, statusDot } from "./styles";

const CARD_BUTTON = cx("w-full cursor-pointer px-[9px] py-[7px]", FOCUS_RING);

/** The signed-in user's own computers. Team access is an explicit, revocable
 *  binding - never implied by enrollment. */
export function AccountMachines({ teamId }: { teamId: string }) {
  const [value, setValue] = useState<Obj | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/machines");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(body.error ?? `HTTP ${response.status}`); return; }
    setValue(body); setError("");
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function binding(machineId: string, enabled: boolean) {
    const response = await fetch(`/api/machines/${encodeURIComponent(machineId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: enabled ? "enable-binding" : "disable-binding", teamId }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(body.error ?? `HTTP ${response.status}`); return; }
    await load();
  }

  return <Section title="My Machines" sub="Physical computers you own. Team access is an explicit, revocable binding.">
    {error && <p className={ERROR}>{error}</p>}
    {!value ? <Empty text="Loading machines..." />
      : value.machines.length
        ? <div className="grid grid-cols-[repeat(auto-fit,minmax(270px,1fr))] gap-3 pt-[18px] max-[900px]:grid-cols-[1fr]">
          {value.machines.map((machine: Obj) => <MachineCard
            key={machine.id}
            machine={machine}
            personal={value.personalTeamId === teamId}
            active={machine.bindings.find((item: Obj) => item.teamId === teamId)?.enabled === true}
            onToggle={(next) => void binding(machine.id, next)}
          />)}
        </div>
        : <Empty text={`No Machine yet. Run lk setup ${value.teams.find((team: Obj) => team.id === teamId)?.path ?? "/<workspace>"}.`} />}
  </Section>;
}

function MachineCard({ machine, personal, active, onToggle }: { machine: Obj; personal: boolean; active: boolean; onToggle: (next: boolean) => void }) {
  return <article className="min-w-0 border border-[#aaa] bg-white">
    <header className="flex items-center gap-[13px] border-b border-[#d2d2d2] bg-[#f3f3f1] p-4">
      <span className={statusDot(machine.online)} aria-hidden="true" />
      <div>
        <span className={EYEBROW}>{machine.online ? "ONLINE" : "OFFLINE"}</span>
        <h2 className="mt-1 text-[15px] wrap-anywhere">{machine.name}</h2>
      </div>
    </header>
    <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-[9px] p-[15px]">
      <dt className="text-[#777]">Platform</dt>
      <dd className="wrap-anywhere">{machine.platform ?? "Unknown"}</dd>
      <dt className="text-[#777]">Agents</dt>
      <dd className="wrap-anywhere">{machine.agentProfiles === null ? "Not reported by this daemon" : machine.agentProfiles.length ? machine.agentProfiles.join(", ") : "None detected"}</dd>
      <dt className="text-[#777]">Machine ID</dt>
      <dd className="wrap-anywhere"><code className="text-[10px]">{machine.id}</code></dd>
      <dt className="text-[#777]">This Team</dt>
      <dd className="wrap-anywhere">{personal ? "Personal Team" : active ? "Authorized" : "Not authorized"}</dd>
    </dl>
    <footer className="flex min-h-12 items-center border-t border-[#ddd] px-[15px] py-2.5">
      {personal
        ? <span className="text-[11px] text-[#666]">Always available to your Personal Team</span>
        : <button
          className={cx(CARD_BUTTON, active ? "border border-[#9b3a32] bg-white text-[#8a2922]" : "border border-[#171717] bg-[#171717] text-white")}
          onClick={() => onToggle(!active)}
        >{active ? "Remove Team access" : "Authorize for this Team"}</button>}
    </footer>
  </article>;
}
