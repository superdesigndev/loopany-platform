import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { patchMirror, showMirror } from "../kernel/mirrorApi.js";
import { apiResponse, authFailure, ensureBooted, jsonBody } from "../kernel/routeSupport.js";

/**
 * One mirror: read it, or relabel it.
 *
 * PATCH takes `note` and NOTHING else. `coords`/`kind` are refused by name
 * (`IMMUTABLE_COORDS`) with the legal move, because that refusal is where an
 * agent learns the model — a different PR is a different mirror. `state`,
 * `status` and friends are refused by name too (`MIRROR_STATELESS`), so the
 * "cache it just this once" reflex meets a sentence rather than an unknown key.
 */
export const Route = createFileRoute("/api/mirrors/$mirrorId")({ server: { handlers: {
  GET: async ({ request, params }: { request: Request; params: { mirrorId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual"); if (!auth.ok) return authFailure(auth.error); return apiResponse(await showMirror(params.mirrorId, auth.context)); },
  PATCH: async ({ request, params }: { request: Request; params: { mirrorId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual", true); if (!auth.ok) return authFailure(auth.error); const body = await jsonBody(request); if (!body.ok) return body.response; return apiResponse(await patchMirror(params.mirrorId, body.value, auth.context)); },
} } });
