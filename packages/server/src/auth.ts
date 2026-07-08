/**
 * Better Auth — GitHub social login, gated by a login allowlist
 * (LOOPANY_ALLOWED_LOGINS = comma-separated emails). Shared workspace: any
 * allowed user sees all loops/machines; `userId` is attribution only.
 *
 * OFF by default: with no GITHUB_CLIENT_ID/SECRET the app stays open (no gate),
 * so local dev + the verified Cookie/dashboard flow are unaffected. Set the
 * GitHub OAuth creds + LOOPANY_ALLOWED_LOGINS to turn the gate on.
 */
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "./db/index.js";
import * as store from "./db/store.js";
import { isSuperAdmin } from "./superadmin.js";

// Re-export so callers keep importing the superadmin check from `auth` while the
// pure predicate lives in a standalone module the gateway can use too.
export { isSuperAdmin };

const clientId = process.env.GITHUB_CLIENT_ID?.trim();
const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();

/** Auth is enforced only when a GitHub OAuth app is configured. */
export const authEnabled = !!(clientId && clientSecret);

// The session-signing secret. With the gate ON a real secret is REQUIRED —
// falling back to the public dev constant would let anyone forge sessions, so
// refuse to boot instead of running insecurely. Open mode (no gate ⇒ no
// sessions worth forging) keeps the dev fallback for zero-config local runs.
const authSecret = process.env.LOOPANY_AUTH_SECRET?.trim();
if (authEnabled && !authSecret) {
  throw new Error(
    "LOOPANY_AUTH_SECRET must be set when the GitHub login gate is enabled (GITHUB_CLIENT_ID/SECRET present) — refusing to fall back to the public dev secret.",
  );
}

const allowlist = (process.env.LOOPANY_ALLOWED_LOGINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Whether an email may sign in. An empty allowlist means "allow anyone" (open
 * mode). Each allowlist entry is either a full email (exact match) or a DOMAIN
 * WILDCARD — `@example.com` or `*@example.com` — matching any address at that
 * domain (so `*@superdesign.dev` admits the whole team without listing each one).
 */
export function emailAllowed(email: string | null | undefined): boolean {
  if (!allowlist.length) return true;
  const e = (email || "").toLowerCase();
  const at = e.indexOf("@");
  if (at < 0) return false;
  const domain = e.slice(at); // includes the leading "@"
  return allowlist.some(
    (entry) => entry === e || entry === domain || (entry.startsWith("*@") && entry.slice(1) === domain),
  );
}

/**
 * Superadmins see every team and every team's loops — the predicate lives in
 * `./superadmin.js` (env-driven, LOOPANY_SUPERADMINS) and is re-exported above so
 * the gateway can reuse it without importing this Better-Auth-initializing module.
 */

/** A user's personal-team display name from their email's local part:
 *  "you@example.com" → "you's Team". Falls back when no email. */
export function teamNameForEmail(email: string | null | undefined): string {
  const local = (email || "").split("@")[0]?.trim();
  return local ? `${local}'s Team` : "Personal Team";
}

/** Cookie (client-set, server-validated) carrying the active team selection. */
const TEAM_COOKIE = "loopany.team";
/** Sentinel selection: the admin "All teams" aggregate read view. */
export const ALL_TEAMS = "__all__";

/**
 * The signed-in user (id + email) for the current server-fn request, or null when
 * no session. Reads the request via TanStack's async-local context, so it only
 * works inside a server fn / server route handler.
 */
export async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const session = await auth.api.getSession({ headers: getRequest().headers });
  const u = session?.user;
  return u ? { id: u.id, email: u.email ?? null } : null;
}

export async function currentUserId(): Promise<string | null> {
  return (await currentUser())?.id ?? null;
}

/** Read the active-team cookie off the current request (raw; unvalidated). */
async function selectedTeam(): Promise<string | null> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const raw = getRequest().headers.get("cookie") || "";
  const v = new RegExp(`(?:^|;\\s*)${TEAM_COOKIE}=([^;]+)`).exec(raw)?.[1];
  return v ? decodeURIComponent(v) : null;
}

export interface RequestScope {
  /** True only when the GitHub gate is on. */
  enforce: boolean;
  /** Signed-in user (creator-attribution column on writes); null ⇒ no access. */
  userId: string | null;
  /** The active team — what reads filter and writes authorize against. */
  teamId: string;
  /** This user is a superadmin (cross-team visibility). */
  isAdmin: boolean;
  /** Admin "All teams" aggregate read mode (the cookie sentinel was selected). */
  allTeams: boolean;
}

/**
 * Per-request data scope. Machines / loops / channels are scoped by `teamId`.
 * The active team is resolved from (in precedence order) an EXPLICIT team — the
 * `/t/<teamId>` route param, so a tab/bookmark pins its own team independent of
 * any cookie (Phase 2) — else the `loopany.team` cookie (now only a last-used
 * default hint). Either source is VALIDATED here against membership (or admin),
 * never trusted blind, and falls back to the user's personal team. Admins may
 * select any team, or the `ALL_TEAMS` aggregate view.
 *
 * `explicitTeam` (when a non-empty string) wins over the cookie. An unauthorized
 * value falls through to the personal team exactly like a stale cookie, so the
 * caller can detect rejection by comparing the returned `teamId` to what it asked
 * for (see `canViewTeam` in loopApi) without this ever leaking another team's data.
 */
export async function requestScope(explicitTeam?: string | null): Promise<RequestScope> {
  const enforce = authEnabled;
  if (!enforce) {
    // Open mode ⇒ the single shared workspace; no sign-in, no admin, no switching.
    // An explicit team from a /t/<id> URL is cosmetic here (nothing to scope to).
    const teamId = store.teamIdForUser(null);
    await store.ensureTeam(teamId, "Shared Workspace", null);
    return { enforce, userId: null, teamId, isAdmin: false, allTeams: false };
  }

  const user = await currentUser();
  const userId = user?.id ?? null;
  const personalTeam = store.teamIdForUser(userId);
  // Ensure the personal/placeholder team exists (covers pre-hook users etc.) and
  // keep its name in sync with the email — also renames pre-existing teams.
  await store.ensureTeam(personalTeam, userId ? teamNameForEmail(user?.email) : "Shared Workspace", userId);

  const isAdmin = isSuperAdmin(user?.email);
  // Explicit team (route param) takes precedence over the cookie; both are
  // membership/admin-validated below, so an explicit choice is no more trusted.
  const sel = explicitTeam != null && explicitTeam !== "" ? explicitTeam : await selectedTeam();
  if (sel === ALL_TEAMS && isAdmin) {
    return { enforce, userId, teamId: personalTeam, isAdmin, allTeams: true };
  }
  // A specific team: admins may pick any existing team; others only their own.
  if (sel && sel !== personalTeam && userId) {
    const ok = isAdmin ? !!(await store.getTeam(sel)) : await store.isTeamMember(sel, userId);
    if (ok) return { enforce, userId, teamId: sel, isAdmin, allTeams: false };
  }
  return { enforce, userId, teamId: personalTeam, isAdmin, allTeams: false };
}

/**
 * Whether the request may view/act on a loop, by its owning team. The single
 * source for loop authorization, shared by the server fns (`ownedLoop`) and the
 * artifact download route so the gate can't drift between them.
 *
 * Authorization is by MEMBERSHIP in the loop's own team — NOT by the loop merely
 * matching the caller's active team. A user who belongs to team B can open a
 * direct link to a team-B loop while their active team is A, instead of getting a
 * spurious "not found" (the cross-team-link bug). Rules:
 *  - open mode ⇒ the single shared workspace, everything visible;
 *  - a superadmin ⇒ cross-team visibility (any team's loop);
 *  - the active team is a no-DB fast path (requestScope already membership-
 *    validated the active-team cookie);
 *  - otherwise the user must be a MEMBER of the loop's team.
 * Async because the membership fall-through is a store lookup. A non-member (and a
 * signed-out request) is denied, indistinguishable from a nonexistent loop.
 */
export async function canAccessLoop(loopTeamId: string | null, scope: RequestScope): Promise<boolean> {
  const { enforce, teamId, userId, isAdmin } = scope;
  if (!enforce) return true; // open mode: no gate
  if (isAdmin) return true; // superadmin sees every team
  if (loopTeamId === teamId) return true; // active team (already validated by requestScope)
  if (!loopTeamId || !userId) return false;
  return store.isTeamMember(loopTeamId, userId); // membership in the loop's own team
}

export const auth = betterAuth({
  baseURL: process.env.LOOPANY_BASE_URL || "http://127.0.0.1:3000",
  secret: authSecret || "dev-insecure-secret-change-in-prod",
  database: drizzleAdapter(db, { provider: "pg" }),
  socialProviders: authEnabled
    ? { github: { clientId: clientId!, clientSecret: clientSecret! } }
    : {},
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Login allowlist (empty ⇒ allow anyone). Closes the shared-workspace
          // RCE hole: only listed people can sign in and thus reach machines.
          // Entries may be full emails or domain wildcards (see `emailAllowed`).
          if (!emailAllowed(user.email)) {
            const email = (user.email || "").toLowerCase();
            throw new APIError("FORBIDDEN", { message: `${email} is not on the Loopany allowlist` });
          }
          return { data: user };
        },
        // Give every new user their own team (machines/notifications bind to it).
        after: async (user) => {
          try {
            const teamId = store.teamIdForUser(user.id);
            await store.ensureTeam(teamId, teamNameForEmail(user.email), user.id);
          } catch {
            /* non-fatal: requestScope's lazy ensureTeam backstops this */
          }
        },
      },
    },
  },
});
