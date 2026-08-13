import type { Command } from "@loopany/kernel";
import * as store from "../db/store.js";

export const personAddress = (userId: string): string => `person:${userId}`;

/** Resolve human-friendly input only inside the selected team. */
export async function resolvePerson(teamId: string, input: string): Promise<string | null> {
  if (input.startsWith("person:")) {
    const id = input.slice(7);
    return (await store.isTeamMember(teamId, id)) ? input : null;
  }
  if (!input.includes("@") && input.includes("/")) return input;
  const wanted = input.trim().toLowerCase();
  const matches = (await store.listTeamMembers(teamId)).filter((member) =>
    member.email?.trim().toLowerCase() === wanted || member.displayName?.trim().toLowerCase() === wanted
  );
  return matches.length === 1 ? personAddress(matches[0]!.userId) : null;
}

export async function normalizePersonFields(teamId: string, raw: unknown): Promise<Command | { error: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw as Command;
  const command = { ...(raw as Record<string, unknown>) };
  const target = command.op === "create"
    ? command
    : command.op === "update" && command.patch && typeof command.patch === "object" && !Array.isArray(command.patch)
      ? { ...(command.patch as Record<string, unknown>) }
      : null;
  if (!target) return command as unknown as Command;
  for (const field of ["assignee", "owner"] as const) {
    const value = target[field];
    if (typeof value !== "string") continue;
    const resolved = await resolvePerson(teamId, value);
    if (!resolved) return { error: `${field} does not resolve uniquely to a current member of this team` };
    target[field] = resolved;
  }
  if (command.op === "update") command.patch = target;
  return command as unknown as Command;
}
