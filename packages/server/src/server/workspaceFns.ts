import { createServerFn } from "@tanstack/react-start";

import { rewriteWorkspaceEnabled, rewriteWorkspaceRequiresLogin } from "../lib/rewriteWorkspace.js";

/**
 * Whether the current caller may open `/dev/workspace`.
 *
 * The loader calls this so the route can render the app's ordinary sign-in
 * screen instead of a shell with no data. It is NOT the security boundary — the
 * `/api/views/*` handlers gate themselves — which is why it resolves a session
 * only when the gate is actually on.
 */
export type WorkspaceAccess = { state: "disabled" } | { state: "signin" } | { state: "ok" };

export const workspaceAccess = createServerFn({ method: "GET" }).handler(async (): Promise<WorkspaceAccess> => {
  if (!rewriteWorkspaceEnabled()) return { state: "disabled" };
  if (!rewriteWorkspaceRequiresLogin()) return { state: "ok" };
  const { currentUser } = await import("../auth.js");
  return (await currentUser()) ? { state: "ok" } : { state: "signin" };
});
