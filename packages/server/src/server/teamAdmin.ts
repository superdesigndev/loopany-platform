/**
 * Team lifecycle + membership logic (design report §2/§4/§5, all six §7 decisions
 * approved as recommended). This module is the ONE authorization + rules
 * chokepoint; the `teamFns` server fns are thin wrappers that resolve the caller's
 * user id and delegate here. Keeping the logic framework-free (plain async
 * functions over the store, `(actorUserId, ...)` in) makes every rule directly
 * testable against a real pglite store without mocking the Start runtime.
 *
 * The non-negotiable invariants, enforced here + transactionally in the store:
 *  - every fn takes an EXPLICIT teamId and authorizes by MEMBERSHIP + ROLE, never
 *    the active-team cookie (the URL report's hard lesson — managing team B while
 *    browsing team A must work);
 *  - team MANAGEMENT (rename/delete/members/invites) is owner-only; any member may
 *    still create loops (decision 4, unchanged elsewhere);
 *  - the personal team is undeletable + un-leavable but renamable (decision 5);
 *  - a team always keeps ≥1 owner (decision 6, the last-owner guard);
 *  - deleting a team that still owns loops is BLOCKED, never cascaded (decision 1);
 *  - an invite grants membership within the app but never bypasses the login
 *    allowlist (decision 3 — the redeemer already signed in through the gate).
 */
import { randomUUID } from "node:crypto";

import * as store from "../db/store.js";
import type { TeamInvite } from "../db/schema.js";

/** Invite link lifetime (design §4 "short TTL, e.g. 7 days"). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const NAME_MAX = 80;

export type Role = "owner" | "member";
/** A success carrying `T`'s extra fields, or a failure with a message. The base
 *  case (no extra payload) uses `Record<never, never>` so a bare `{ ok: true }`
 *  satisfies it (an empty intersection, not the stricter `Record<string, never>`). */
export type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string };

function cleanName(raw: string): string | null {
  const s = (raw || "").trim().slice(0, NAME_MAX);
  return s || null;
}

function isRole(v: unknown): v is Role {
  return v === "owner" || v === "member";
}

/** Resolve the actor's role in a team (null ⇒ not a member). */
export async function roleOf(teamId: string, userId: string): Promise<Role | null> {
  return (await store.getTeamMember(teamId, userId))?.role ?? null;
}

// ---- team summaries / detail (read surfaces the settings UI renders) ----

export interface TeamAdminSummary {
  id: string;
  name: string;
  role: Role;
  memberCount: number;
  personal: boolean;
}

/** Every team the actor belongs to, with their role + member count (the settings
 *  master list; doubles as a richer switcher). */
export async function listManagedTeams(userId: string): Promise<TeamAdminSummary[]> {
  const teams = await store.listTeamsForUser(userId);
  return Promise.all(
    teams.map(async (t) => {
      const members = await store.listTeamMembers(t.id);
      const me = members.find((m) => m.userId === userId);
      return {
        id: t.id,
        name: t.name,
        role: (me?.role ?? "member") as Role,
        memberCount: members.length,
        personal: store.isPersonalTeam(t),
      };
    }),
  );
}

export interface TeamMemberView {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  isSelf: boolean;
}

export interface TeamInviteView {
  token: string;
  role: Role;
  expiresAt: string;
}

export interface TeamAdminDetail {
  id: string;
  name: string;
  role: Role;
  personal: boolean;
  /** Loops the team owns — non-zero blocks deletion (decision 1). */
  loopCount: number;
  members: TeamMemberView[];
  /** Pending invite links — owner-only (empty for a plain member). */
  invites: TeamInviteView[];
}

/** Full settings detail for one team, authorized by membership (any member may
 *  view the roster; only an owner sees the pending invite links). Null ⇒ the
 *  actor is not a member (caller renders the generic not-found, no leak). */
export async function getTeamDetail(userId: string, teamId: string): Promise<TeamAdminDetail | null> {
  const team = await store.getTeam(teamId);
  if (!team) return null;
  const myRole = await roleOf(teamId, userId);
  if (!myRole) return null;
  const members = await store.listTeamMembers(teamId);
  const loopCount = await store.countLoopsForTeam(teamId);
  const invites = myRole === "owner" ? await store.listPendingInvites(teamId) : [];
  return {
    id: team.id,
    name: team.name,
    role: myRole,
    personal: store.isPersonalTeam(team),
    loopCount,
    members: members.map((m) => ({
      userId: m.userId,
      email: m.email,
      displayName: m.displayName,
      role: m.role,
      isSelf: m.userId === userId,
    })),
    invites: invites.map(inviteView),
  };
}

function inviteView(i: TeamInvite): TeamInviteView {
  return { token: i.token, role: i.role, expiresAt: i.expiresAt };
}

/** Owner-gate helper: the actor must be an OWNER of the team. Returns the FAILURE
 *  result to bubble up (assignable to any `Result<T>`), or null when authorized. */
async function assertOwner(teamId: string, userId: string): Promise<{ ok: false; error: string } | null> {
  const role = await roleOf(teamId, userId);
  if (!role) return { ok: false, error: "This team does not exist, or you do not have access to it." };
  if (role !== "owner") return { ok: false, error: "Only a team owner can manage this team." };
  return null; // authorized
}

// ---- lifecycle mutations ----

export async function createTeam(userId: string, name: string): Promise<Result<{ id: string }>> {
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: "Team name is required." };
  const team = await store.createTeam(clean, userId);
  return { ok: true, id: team.id };
}

export async function renameTeam(userId: string, teamId: string, name: string): Promise<Result> {
  const gate = await assertOwner(teamId, userId);
  if (gate) return gate;
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: "Team name is required." };
  await store.renameTeam(teamId, clean);
  return { ok: true };
}

function blockedByLoops(loopCount: number): { ok: false; error: string } {
  const one = loopCount === 1;
  return {
    ok: false,
    error: `This team still owns ${loopCount} loop${one ? "" : "s"} — move or delete ${one ? "it" : "them"} first.`,
  };
}

export async function deleteTeam(userId: string, teamId: string): Promise<Result> {
  const gate = await assertOwner(teamId, userId);
  if (gate) return gate;
  const team = await store.getTeam(teamId);
  if (!team) return { ok: false, error: "This team no longer exists." };
  if (store.isPersonalTeam(team)) return { ok: false, error: "Your personal team can't be deleted." };
  // Decision 1: block while the team still owns loops — never silently cascade
  // a loop's run/artifact history away. Checked here for the accurate count in
  // the message AND re-checked inside deleteTeamCascade's transaction, so a loop
  // created in the check-then-cascade gap can't be orphaned at a deleted team.
  const loopCount = await store.countLoopsForTeam(teamId);
  if (loopCount > 0) return blockedByLoops(loopCount);
  if ((await store.deleteTeamCascade(teamId)) === "has-loops") {
    return blockedByLoops(await store.countLoopsForTeam(teamId));
  }
  return { ok: true };
}

// ---- members ----

/** Direct-add-by-email fast path (design §4 option A): add an EXISTING account to
 *  the team immediately. No account yet ⇒ steer the owner to an invite link. */
export async function addMemberByEmail(
  userId: string,
  teamId: string,
  email: string,
  role: Role,
): Promise<Result<{ added: string }>> {
  const gate = await assertOwner(teamId, userId);
  if (gate) return gate;
  if (!isRole(role)) return { ok: false, error: "Invalid role." };
  const addr = (email || "").trim();
  if (!addr) return { ok: false, error: "An email address is required." };
  const target = await store.userByEmail(addr);
  if (!target) {
    return {
      ok: false,
      error: "No adScaile account uses that email yet. Generate an invite link they can redeem after signing in.",
    };
  }
  if (await store.getTeamMember(teamId, target.id)) {
    return { ok: false, error: `${target.email} is already a member of this team.` };
  }
  await store.addTeamMember(teamId, target.id, role);
  return { ok: true, added: target.email };
}

export async function setMemberRole(
  userId: string,
  teamId: string,
  targetUserId: string,
  role: Role,
): Promise<Result> {
  const gate = await assertOwner(teamId, userId);
  if (gate) return gate;
  if (!isRole(role)) return { ok: false, error: "Invalid role." };
  const outcome = await store.setTeamMemberRoleGuarded(teamId, targetUserId, role);
  if (outcome === "not-member") return { ok: false, error: "That person is not a member of this team." };
  if (outcome === "last-owner")
    return { ok: false, error: "This is the team's only owner — promote another owner first." };
  return { ok: true };
}

export async function removeMember(userId: string, teamId: string, targetUserId: string): Promise<Result> {
  const gate = await assertOwner(teamId, userId);
  if (gate) return gate;
  if (targetUserId === userId)
    return { ok: false, error: "Use “Leave team” to remove yourself." };
  const outcome = await store.removeTeamMemberGuarded(teamId, targetUserId);
  if (outcome === "not-member") return { ok: false, error: "That person is not a member of this team." };
  if (outcome === "last-owner")
    return { ok: false, error: "This is the team's only owner — promote another owner first." };
  return { ok: true };
}

/** Leave a team (any member). The personal team can't be left; the last owner
 *  can't leave (transfer ownership or delete the team first). */
export async function leaveTeam(userId: string, teamId: string): Promise<Result> {
  const team = await store.getTeam(teamId);
  if (!team) return { ok: false, error: "This team no longer exists." };
  if (!(await roleOf(teamId, userId)))
    return { ok: false, error: "You are not a member of this team." };
  if (store.isPersonalTeam(team)) return { ok: false, error: "You can't leave your personal team." };
  const outcome = await store.removeTeamMemberGuarded(teamId, userId);
  if (outcome === "last-owner")
    return {
      ok: false,
      error: "You are the team's only owner — promote another owner or delete the team first.",
    };
  if (outcome === "not-member") return { ok: false, error: "You are not a member of this team." };
  return { ok: true };
}

// ---- invites (invite-link mint / redeem / revoke) ----

/** Mint a single-use, short-lived invite link (owner-only). `role` is capped at
 *  the inviter's role — an owner may mint member or owner links (decision 6). */
export async function createInvite(
  userId: string,
  teamId: string,
  role: Role,
  nowMs: number,
): Promise<Result<{ token: string; expiresAt: string; role: Role }>> {
  const gate = await assertOwner(teamId, userId);
  if (gate) return gate;
  if (!isRole(role)) return { ok: false, error: "Invalid role." };
  const token = `inv_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const expiresAt = new Date(nowMs + INVITE_TTL_MS).toISOString();
  const invite = await store.createInvite({ token, teamId, role, invitedByUserId: userId, expiresAt });
  return { ok: true, token: invite.token, expiresAt: invite.expiresAt, role: invite.role };
}

export async function revokeInvite(userId: string, teamId: string, token: string): Promise<Result> {
  const gate = await assertOwner(teamId, userId);
  if (gate) return gate;
  const invite = await store.getInvite(token);
  if (!invite || invite.teamId !== teamId) return { ok: false, error: "That invite no longer exists." };
  await store.deleteInvite(token);
  return { ok: true };
}

/**
 * Redeem an invite as the signed-in actor. Any signed-in user may redeem (the
 * link is the authority, not team membership); the login allowlist already gated
 * their sign-in, so this never widens who can sign in (decision 3). Outcomes:
 *  - invalid token / wrong shape → error;
 *  - already redeemed (single-use) → error;
 *  - expired → error;
 *  - already a member → success, no double-add (`alreadyMember`);
 *  - otherwise → membership granted at the invite's role.
 */
export async function redeemInvite(
  userId: string,
  token: string,
  nowMs: number,
): Promise<Result<{ teamId: string; teamName: string; alreadyMember: boolean }>> {
  const invite = await store.getInvite(token);
  if (!invite) return { ok: false, error: "This invite link is invalid." };
  if (invite.redeemedAt) return { ok: false, error: "This invite link has already been used." };
  if (new Date(invite.expiresAt).getTime() <= nowMs) return { ok: false, error: "This invite link has expired." };
  const team = await store.getTeam(invite.teamId);
  if (!team) return { ok: false, error: "The team for this invite no longer exists." };
  const already = !!(await store.getTeamMember(invite.teamId, userId));
  // Claim the single-use link and grant membership in ONE transaction: the
  // conditional stamp (`redeemed_at IS NULL`) is the chokepoint, so two
  // concurrent redeems can't both add a member off one link, and the stamp +
  // membership add commit together (a crash between them can't burn the link
  // without granting membership). Only the winner adds membership; a loser sees
  // the invite already spent. An already-member redeem still burns the link (so
  // it can't later add someone else) with no double-add / no role change.
  const won = await store.redeemInviteAtomic(
    token,
    userId,
    already ? null : { teamId: invite.teamId, role: invite.role },
  );
  if (!won) return { ok: false, error: "This invite link has already been used." };
  return { ok: true, teamId: invite.teamId, teamName: team.name, alreadyMember: already };
}
