import { Link } from "@tanstack/react-router";
import { NotificationSettings } from "../NotificationsModal";
import { AccountMachines } from "./AccountMachines";
import type { Obj, Select, SettingsSection } from "./model";
import { Empty, Section } from "./primitives";
import { SETTINGS_SECTIONS } from "./routing";
import { MUTED, railButton } from "./styles";
import { TeamDirectory } from "./TeamDirectory";

const SETTINGS_TO = "/t/$teamSlug/kernel/settings/$section";

/** Team, Machines and personal preferences behind one section rail. The section
 *  is a real place (`/kernel/settings/machines`), so it survives a reload and
 *  can be linked to from setup docs. */
export function SettingsView({ data, teamId, teamSlug, section, agents, select }: { data: Obj; teamId?: string; teamSlug: string; section: SettingsSection; agents: string[]; select: Select }) {
  return <Section title="Settings" sub="Manage this Team, your Machines, and personal preferences" flush>
    <div className="grid min-h-[360px] grid-cols-[150px_minmax(0,1fr)] border border-[#bbb] max-[900px]:grid-cols-[1fr]">
      <nav aria-label="Settings sections" className="border-r border-[#bbb] p-2.5 max-[900px]:border-r-0 max-[900px]:border-b">
        {SETTINGS_SECTIONS.map((item) => <Link
          key={item}
          to={SETTINGS_TO}
          params={{ teamSlug, section: item }}
          search={{}}
          className={railButton(section === item)}
        >{item[0]!.toUpperCase() + item.slice(1)}</Link>)}
      </nav>
      <section className="p-3">
        {section === "team" ? <TeamDirectory data={data} agents={agents} select={select} />
          : section === "machines" ? (teamId ? <AccountMachines teamId={teamId} /> : <Empty text="Team unavailable." />)
          : <>
            <div>
              <h2 className="mb-1.5 text-[16px]">Notifications</h2>
              <p className={MUTED}>Your personal destinations across every Team. The newest one receives new Task assignments.</p>
            </div>
            <NotificationSettings />
          </>}
      </section>
    </div>
  </Section>;
}
