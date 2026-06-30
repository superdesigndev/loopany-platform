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

const allowlist = (process.env.LOOPANY_ALLOWED_LOGINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Superadmins see every team and every team's loops — the predicate lives in
 * `./superadmin.js` (env-driven, LOOPANY_SUPERADMINS) and is re-exported above so
 * the gateway can reuse it without importing this Better-Auth-initializing module.
 */

/** A user's personal-team display name from their email's local part:
 *  "shitianxin@gmail.com" → "shitianxin's Team". Falls back when no email. */
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
 * The active team comes from the `loopany.team` cookie — VALIDATED here against
 * membership (or admin), never trusted blind — and falls back to the user's
 * personal team. Admins may select any team, or the `ALL_TEAMS` aggregate view.
 */
export async function requestScope(): Promise<RequestScope> {
  const enforce = authEnabled;
  if (!enforce) {
    // Open mode ⇒ the single shared workspace; no sign-in, no admin, no switching.
    const teamId = store.teamIdForUser(null);
    store.ensureTeam(teamId, "Shared Workspace", null);
    return { enforce, userId: null, teamId, isAdmin: false, allTeams: false };
  }

  const user = await currentUser();
  const userId = user?.id ?? null;
  const personalTeam = store.teamIdForUser(userId);
  // Ensure the personal/placeholder team exists (covers pre-hook users etc.) and
  // keep its name in sync with the email — also renames pre-existing teams.
  store.ensureTeam(personalTeam, userId ? teamNameForEmail(user?.email) : "Shared Workspace", userId);

  const isAdmin = isSuperAdmin(user?.email);
  const sel = await selectedTeam();
  if (sel === ALL_TEAMS && isAdmin) {
    return { enforce, userId, teamId: personalTeam, isAdmin, allTeams: true };
  }
  // A specific team: admins may pick any existing team; others only their own.
  if (sel && sel !== personalTeam && userId) {
    const ok = isAdmin ? !!store.getTeam(sel) : store.isTeamMember(sel, userId);
    if (ok) return { enforce, userId, teamId: sel, isAdmin, allTeams: false };
  }
  return { enforce, userId, teamId: personalTeam, isAdmin, allTeams: false };
}

/**
 * Whether a loop (by its owning team) is visible/actionable in the given request
 * scope. The single source for loop authorization: open mode sees everything,
 * an admin's "All teams" view sees everything, otherwise the loop must belong to
 * the active team. Shared by the server fns (`ownedLoop`) and the artifact
 * download route so the gate can't drift between them.
 */
export function loopInScope(loopTeamId: string | null, scope: RequestScope): boolean {
  const { enforce, teamId, isAdmin, allTeams } = scope;
  if (!enforce) return true;
  if (isAdmin && allTeams) return true;
  return loopTeamId === teamId;
}

export const auth = betterAuth({
  baseURL: process.env.LOOPANY_BASE_URL || "http://127.0.0.1:3000",
  secret: process.env.LOOPANY_AUTH_SECRET || "dev-insecure-secret-change-in-prod",
  database: drizzleAdapter(db, { provider: "sqlite" }),
  socialProviders: authEnabled
    ? { github: { clientId: clientId!, clientSecret: clientSecret! } }
    : {},
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Login allowlist (empty ⇒ allow anyone). Closes the shared-workspace
          // RCE hole: only listed people can sign in and thus reach machines.
          if (allowlist.length) {
            const email = (user.email || "").toLowerCase();
            if (!allowlist.includes(email)) {
              throw new APIError("FORBIDDEN", { message: `${email} is not on the LoopAny allowlist` });
            }
          }
          return { data: user };
        },
        // Give every new user their own team (machines/notifications bind to it).
        after: async (user) => {
          try {
            const teamId = store.teamIdForUser(user.id);
            store.ensureTeam(teamId, teamNameForEmail(user.email), user.id);
          } catch {
            /* non-fatal: requestScope's lazy ensureTeam backstops this */
          }
        },
      },
    },
  },
});
