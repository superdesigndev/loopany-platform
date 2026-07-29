/**
 * Who may open the Graph v1 workspace, and when it exists at all.
 *
 * This is a LEAF module (no auth, no db imports) for the same reason
 * `lib/loginGate.ts` is: the condition has to be readable from a route handler,
 * a server fn and a page loader without dragging Better Auth onto any of their
 * hot paths, and there must be exactly ONE definition of it.
 *
 * ── the policy, and why it is stricter than the rest of the app ──────────────
 *
 * The workspace renders REAL production content — support tickets carrying
 * customer names and email addresses. The surrounding app's gate is
 * `LOOPANY_ALLOWED_LOGINS`, and an EMPTY allowlist there means "allow anyone
 * with a GitHub account" (see `auth.ts`). That is a fine default for a staging
 * dashboard of synthetic loops; it is not a fine default for someone else's
 * customer correspondence.
 *
 * So this surface FAILS CLOSED. In any deployed build it serves nobody until an
 * operator names who may see it:
 *
 *   LOOPANY_GRAPH_WORKSPACE=on              the surface exists at all
 *   LOOPANY_GRAPH_WORKSPACE_LOGINS=a,b      who may open it (this module)
 *   LOOPANY_ALLOWED_LOGINS=...              fallback, if the app-wide gate is
 *                                           already narrowed to the right people
 *
 * With both allowlists empty, `mayViewGraphWorkspace` returns false for
 * everyone — including a signed-in user. An unset variable can therefore never
 * widen the audience, which is the property that matters.
 *
 * Local dev (no login gate, not a production build) stays open, so `pnpm
 * graph:demo` needs no configuration.
 */

/** `1|true|on|yes` (case-insensitive) counts as on; anything else is off. */
function truthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** True only in a plain local run: not a production build, and no login gate. */
export function graphWorkspaceLocalDev(): boolean {
  const gated = !!(process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim());
  return process.env.NODE_ENV !== "production" && !gated;
}

/**
 * Does the surface exist? Local dev always; a deployed build only with an
 * explicit opt-in, so a normal deploy of this branch adds no new attack surface
 * until someone turns it on.
 */
export function graphWorkspaceEnabled(): boolean {
  return graphWorkspaceLocalDev() || truthy(process.env.LOOPANY_GRAPH_WORKSPACE);
}

/** Must the caller be signed in AND allow-listed? Everywhere except local dev. */
export function graphWorkspaceRequiresLogin(): boolean {
  return !graphWorkspaceLocalDev();
}

function entries(): string[] {
  const raw = process.env.LOOPANY_GRAPH_WORKSPACE_LOGINS?.trim() || process.env.LOOPANY_ALLOWED_LOGINS?.trim() || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * May this email open the workspace?
 *
 * Same entry grammar as the app-wide allowlist — a full address, or a domain
 * wildcard (`@example.com` / `*@example.com`) — but the EMPTY case is inverted:
 * app-wide it means "anyone", here it means "no one".
 */
export function mayViewGraphWorkspace(email: string | null | undefined): boolean {
  if (graphWorkspaceLocalDev()) return true;
  const list = entries();
  if (!list.length) return false; // fail closed: unset never means "everyone"
  const addr = email?.trim().toLowerCase();
  if (!addr) return false;
  const domain = addr.slice(addr.indexOf("@"));
  return list.some((e) => e === addr || e === domain || e === `*${domain}`);
}

/**
 * Has an operator named ANYONE? Checked before the session is resolved, so a
 * server with no allowlist refuses without importing auth or touching the
 * database - it cannot admit anyone, so there is nothing to look up.
 */
export function graphWorkspaceAllowlistConfigured(): boolean {
  return entries().length > 0;
}

/** One-line reason the surface refused, for an honest UI (never leaks the list). */
export function graphWorkspaceDenialReason(): string {
  if (!graphWorkspaceEnabled()) return "The graph workspace is not enabled on this server.";
  if (!entries().length) {
    return "The graph workspace has no viewer allowlist configured, so it is serving no one. Set LOOPANY_GRAPH_WORKSPACE_LOGINS.";
  }
  return "Your account is not on the graph workspace allowlist.";
}

/**
 * OPERATOR SEED AUTHORIZATION.
 *
 * Loading a snapshot into a deployed app is an operator action, not a user
 * action: the app runs the embedded single-writer database, so the seed has to
 * go through the running process even though whoever is doing it already has
 * machine-level access. Rather than mint a session for somebody else's account,
 * the seed accepts a bearer token that only someone who can set the app's
 * secrets could know.
 *
 * Deliberately NARROW:
 *  - it authorizes the SEED action only. No read path accepts it, so it can
 *    never be used to pull customer content out of the workspace.
 *  - unset ⇒ no token is accepted at all (an empty string never matches).
 *  - the comparison is length-checked and constant-time, so it does not leak
 *    the token a byte at a time.
 */
export function graphSeedTokenMatches(header: string | null): boolean {
  const expected = process.env.LOOPANY_GRAPH_SEED_TOKEN?.trim();
  if (!expected) return false;
  const got = header?.trim().replace(/^Bearer\s+/i, "") ?? "";
  if (got.length !== expected.length) return false;
  // Constant-time over equal-length strings.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
