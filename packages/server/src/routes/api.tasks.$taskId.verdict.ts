import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { resolveObjectRef } from "../kernel/objectRefs.js";
import { verdict } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted, jsonBody } from "../kernel/routeSupport.js";
export const Route = createFileRoute("/api/tasks/$taskId/verdict")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { taskId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, "human", true); if (!auth.ok) return authFailure(auth.error); const body = await jsonBody(request); if (!body.ok) return body.response; return apiResponse(await verdict(await resolveObjectRef(params.taskId, auth.context.teamId), (body.value as { answer?: unknown })?.answer, auth.context)); } } } });

