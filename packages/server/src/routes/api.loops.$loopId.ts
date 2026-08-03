import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { governLoop } from "../kernel/objectApi.js";
import { apiResponse, authFailure, jsonBody } from "../kernel/routeSupport.js";
export const Route = createFileRoute("/api/loops/$loopId")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { loopId: string } }) => { const auth = await resolveApiContext(request, "agent", true); if (!auth.ok) return authFailure(auth.error); const body = await jsonBody(request); return body.ok ? apiResponse(await governLoop(params.loopId, body.value, auth.context)) : body.response; } } } });

