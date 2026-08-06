import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { runLoopNow } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted } from "../kernel/routeSupport.js";

/** The manual fire requires owner authority (API spec §1.16). No body: the loop already says
 *  what it does, so an off-cadence run is a button, not a form. */
export const Route = createFileRoute("/api/loops/$loopId/run-now")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { loopId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, { owner: "loop-governance" }, true); if (!auth.ok) return authFailure(auth.error); return apiResponse(await runLoopNow(params.loopId, auth.context)); } } } });
