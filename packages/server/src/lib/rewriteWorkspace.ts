/**
 * Does the rewrite workspace exist on this server, and must its visitor be
 * signed in?
 *
 * A LEAF module (no auth, no db imports) for the same reason `lib/loginGate.ts`
 * is one: the condition must be readable from a route loader and a server fn
 * without dragging Better Auth onto either path, and there must be exactly ONE
 * definition of it.
 *
 * The policy is deliberately narrow. This surface renders REAL team content
 * (tasks carrying whatever payload facts agents noted), and it is landing unit 5
 * of a rewrite whose kernel runs ALONGSIDE the shipping product — so a normal
 * deploy of this branch must add no new reachable surface until an operator
 * opts in:
 *
 *   LOOPANY_REWRITE_UI=on     the route exists at all on a deployed build
 *
 * Local dev (not a production build, no login gate) is open, so the screens can
 * be driven against a seeded fixture with no configuration.
 *
 * This is NOT the security boundary. Every `/api/views/*` handler gates itself
 * through `resolveApiContext(request, "human")`, so a page that somehow rendered
 * would still have no data. Two independent checks, neither relying on the other.
 */

/** `1|true|on|yes` (case-insensitive) counts as on; anything else is off. */
function truthy(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/** True only in a plain local run: not a production build, and no login gate. */
export function rewriteWorkspaceLocalDev(env: NodeJS.ProcessEnv = process.env): boolean {
  const gated = !!(env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim());
  return env.NODE_ENV !== "production" && !gated;
}

/** Does the route exist? Local dev always; a deployed build only on opt-in. */
export function rewriteWorkspaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return rewriteWorkspaceLocalDev(env) || truthy(env.LOOPANY_REWRITE_UI);
}

/** Must the visitor be a signed-in human? Everywhere except local dev. */
export function rewriteWorkspaceRequiresLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  return !rewriteWorkspaceLocalDev(env);
}
