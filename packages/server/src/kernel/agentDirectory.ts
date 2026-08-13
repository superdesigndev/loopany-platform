import type { RunRecord } from "@loopany/kernel";
import type { Machine } from "../db/schema.js";

export type AgentAvailability = "available" | "offline" | "last-known";

export interface AgentAddress {
  address: string;
  machineId: string;
  machine: string;
  profile: string;
  availability: AgentAvailability;
  lastSucceededAt: string | null;
}

export function machineSupportsAgent(machine: Pick<Machine, "agentProfiles">, agent: string): boolean | null {
  if (machine.agentProfiles === null || machine.agentProfiles === undefined) return null;
  const profile = agent === "claude-code" ? "claude" : agent;
  return machine.agentProfiles.includes(profile);
}

/** Derive the Team's execution addresses from current Machine capabilities and
 * successful Run evidence. Task assignments are intentionally not evidence. */
export function agentDirectory(
  machines: readonly Machine[],
  aliases: readonly { machineId: string; alias: string }[],
  runs: readonly RunRecord[],
): AgentAddress[] {
  const lastSuccess = new Map<string, string>();
  for (const run of runs) {
    if (run.state !== "done" || !run.assignee?.includes("/")) continue;
    const previous = lastSuccess.get(run.assignee);
    if (!previous || run.createdAt > previous) lastSuccess.set(run.assignee, run.createdAt);
  }

  const result: AgentAddress[] = [];
  for (const machine of machines) {
    const alias = aliases.find((item) => item.machineId === machine.id)?.alias;
    if (!alias) continue;
    if (machine.agentProfiles !== null && machine.agentProfiles !== undefined) {
      for (const profile of machine.agentProfiles) {
        const address = `${alias}/${profile}`;
        result.push({
          address,
          machineId: machine.id,
          machine: alias,
          profile,
          availability: machine.online ? "available" : "offline",
          lastSucceededAt: lastSuccess.get(address) ?? null,
        });
      }
      continue;
    }
    for (const [address, at] of lastSuccess) {
      if (!address.startsWith(`${alias}/`)) continue;
      result.push({
        address,
        machineId: machine.id,
        machine: alias,
        profile: address.slice(alias.length + 1),
        availability: "last-known",
        lastSucceededAt: at,
      });
    }
  }
  return result.sort((a, b) => a.machine.localeCompare(b.machine) || a.profile.localeCompare(b.profile));
}
