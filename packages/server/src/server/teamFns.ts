/**
 * Team management server functions — the thin RPC surface over `teamAdmin`
 * (which holds all the rules + authorization). Every mutating fn takes an
 * EXPLICIT teamId and authorizes by membership + role inside teamAdmin, never the
 * active-team cookie (the URL report's hard lesson: managing team B while browsing
 * team A must work). Team management is a GATED feature — it needs a real
 * signed-in user, so open mode (single shared workspace, no identities) returns a
 * uniform "sign-in required" error.
 */
import { createServerFn } from "@tanstack/react-start";

import { authEnabled, currentUserId } from "../auth.js";
import { ensureServer } from "./boot.js";
import * as team from "./teamAdmin.js";
import type { Result, Role, TeamAdminDetail, TeamAdminSummary } from "./teamAdmin.js";

const SIGNIN_REQUIRED: { ok: false; error: string } = {
  ok: false,
  error: "Team management requires signing in.",
};

/** Resolve the signed-in user id, or null when the gate is off / no session. */
async function actor(): Promise<string | null> {
  if (!authEnabled) return null;
  return currentUserId();
}

/** GET — every team the caller manages/belongs to (role + member count). Open
 *  mode / signed-out ⇒ empty (the settings surface is gated). */
export const listManagedTeams = createServerFn({ method: "GET" }).handler(async (): Promise<TeamAdminSummary[]> => {
  await ensureServer();
  const userId = await actor();
  if (!userId) return [];
  return team.listManagedTeams(userId);
});

/** GET — one team's full settings detail (roster + invites), authorized by
 *  membership. Missing/non-member ⇒ the generic not-found error (no leak). */
export const getTeamDetail = createServerFn({ method: "GET" })
  .validator((teamId: string) => teamId)
  .handler(async ({ data: teamId }): Promise<TeamAdminDetail | { error: string }> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return { error: SIGNIN_REQUIRED.error };
    const detail = await team.getTeamDetail(userId, teamId);
    return detail ?? { error: "This team does not exist, or you do not have access to it." };
  });

export const createTeam = createServerFn({ method: "POST" })
  .validator((name: string) => name)
  .handler(async ({ data: name }): Promise<Result<{ id: string }>> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.createTeam(userId, name);
  });

export const renameTeam = createServerFn({ method: "POST" })
  .validator((d: { teamId: string; name: string }) => d)
  .handler(async ({ data }): Promise<Result> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.renameTeam(userId, data.teamId, data.name);
  });

export const deleteTeam = createServerFn({ method: "POST" })
  .validator((teamId: string) => teamId)
  .handler(async ({ data: teamId }): Promise<Result> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.deleteTeam(userId, teamId);
  });

export const addTeamMember = createServerFn({ method: "POST" })
  .validator((d: { teamId: string; email: string; role: Role }) => d)
  .handler(async ({ data }): Promise<Result<{ added: string }>> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.addMemberByEmail(userId, data.teamId, data.email, data.role);
  });

export const setTeamMemberRole = createServerFn({ method: "POST" })
  .validator((d: { teamId: string; userId: string; role: Role }) => d)
  .handler(async ({ data }): Promise<Result> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.setMemberRole(userId, data.teamId, data.userId, data.role);
  });

export const removeTeamMember = createServerFn({ method: "POST" })
  .validator((d: { teamId: string; userId: string }) => d)
  .handler(async ({ data }): Promise<Result> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.removeMember(userId, data.teamId, data.userId);
  });

export const leaveTeam = createServerFn({ method: "POST" })
  .validator((teamId: string) => teamId)
  .handler(async ({ data: teamId }): Promise<Result> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.leaveTeam(userId, teamId);
  });

export const createTeamInvite = createServerFn({ method: "POST" })
  .validator((d: { teamId: string; role: Role }) => d)
  .handler(async ({ data }): Promise<Result<{ token: string; expiresAt: string; role: Role }>> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.createInvite(userId, data.teamId, data.role, Date.now());
  });

export const revokeTeamInvite = createServerFn({ method: "POST" })
  .validator((d: { teamId: string; token: string }) => d)
  .handler(async ({ data }): Promise<Result> => {
    await ensureServer();
    const userId = await actor();
    if (!userId) return SIGNIN_REQUIRED;
    return team.revokeInvite(userId, data.teamId, data.token);
  });

/** POST — redeem an invite link as the signed-in caller. Any signed-in user may
 *  redeem (the token is the authority); open mode / signed-out is refused. */
export const redeemTeamInvite = createServerFn({ method: "POST" })
  .validator((token: string) => token)
  .handler(
    async ({ data: token }): Promise<Result<{ teamId: string; teamName: string; teamSlug: string; alreadyMember: boolean }>> => {
      await ensureServer();
      const userId = await actor();
      if (!userId) return SIGNIN_REQUIRED;
      return team.redeemInvite(userId, token, Date.now());
    },
  );
