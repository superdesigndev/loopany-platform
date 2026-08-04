import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { attachMirror, listMirrors } from "../kernel/mirrorApi.js";
import { apiResponse, authFailure, ensureBooted, jsonBody } from "../kernel/routeSupport.js";

/**
 * MIRRORS — pointers to things outside this system.
 *
 * Both verbs are DUAL: a run attaches the PR it just opened, a person attaches
 * the property they were already tracking, and neither is governance because a
 * pointer changes nothing. There is no `create` separate from `attach`: a mirror
 * attached to nothing points from nowhere.
 */
export const Route = createFileRoute("/api/mirrors")({ server: { handlers: {
  GET: async ({ request }: { request: Request }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual"); if (!auth.ok) return authFailure(auth.error); return apiResponse(await listMirrors(auth.context, new URL(request.url).searchParams)); },
  POST: async ({ request }: { request: Request }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual", true); if (!auth.ok) return authFailure(auth.error); const body = await jsonBody(request); if (!body.ok) return body.response; return apiResponse(await attachMirror((body.value ?? {}) as Record<string, unknown>, auth.context)); },
} } });
