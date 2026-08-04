import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { loopLifecycle } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted, optionalJsonBody } from "../kernel/routeSupport.js";

/** Operational lifecycle, human only (API spec §1.16). Body is optional `{note?}`. */
export const Route = createFileRoute("/api/loops/$loopId/pause")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { loopId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, { human: "loop-governance" }, true); if (!auth.ok) return authFailure(auth.error); const body = await optionalJsonBody(request); return body.ok ? apiResponse(await loopLifecycle(params.loopId, "pause", body.value, auth.context)) : body.response; } } } });
