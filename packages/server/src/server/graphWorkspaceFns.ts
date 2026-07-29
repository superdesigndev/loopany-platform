import { createServerFn } from "@tanstack/react-start";

import {
  graphWorkspaceAllowlistConfigured,
  graphWorkspaceDenialReason,
  graphWorkspaceEnabled,
  graphWorkspaceRequiresLogin,
  mayViewGraphWorkspace,
} from "../lib/graphWorkspace.js";

/**
 * Whether the CURRENT caller may open the graph workspace page.
 *
 * The page loader calls this so the route can render the app's normal sign-in
 * screen instead of a broken shell. It is NOT the security boundary — the
 * `/api/graph/*` handlers gate themselves independently, so a page that somehow
 * rendered would still have no data. Two checks, neither relying on the other.
 */
export type GraphWorkspaceAccess =
  | { state: "disabled" }
  | { state: "signin" }
  | { state: "denied"; reason: string }
  | { state: "ok" };

export const graphWorkspaceAccess = createServerFn({ method: "GET" }).handler(
  async (): Promise<GraphWorkspaceAccess> => {
    if (!graphWorkspaceEnabled()) return { state: "disabled" };
    if (!graphWorkspaceRequiresLogin()) return { state: "ok" };
    // Same short-circuit as the API guard: nobody is admitted, so do not even
    // resolve a session.
    if (!graphWorkspaceAllowlistConfigured()) return { state: "denied", reason: graphWorkspaceDenialReason() };

    const { currentUser } = await import("../auth.js");
    const user = await currentUser();
    // Not signed in ⇒ the ordinary sign-in screen. Signed in but not allow-listed
    // ⇒ say so plainly; the reason never names who IS on the list.
    if (!user) return { state: "signin" };
    return mayViewGraphWorkspace(user.email) ? { state: "ok" } : { state: "denied", reason: graphWorkspaceDenialReason() };
  },
);
