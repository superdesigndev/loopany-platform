import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { detachMirror } from "../kernel/mirrorApi.js";
import { apiResponse, authFailure, ensureBooted, jsonBody } from "../kernel/routeSupport.js";

/** `from` is REQUIRED: a mirror can hang on several objects, so a bare detach
 *  would have to guess which dependency the caller meant, and guessing wrong
 *  silently removes somebody else's pointer. */
export const Route = createFileRoute("/api/mirrors/$mirrorId/detach")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { mirrorId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual", true); if (!auth.ok) return authFailure(auth.error); const body = await jsonBody(request); if (!body.ok) return body.response; return apiResponse(await detachMirror(params.mirrorId, (body.value as { from?: unknown })?.from, auth.context)); } } } });
