import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { closeTask } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted, jsonBody } from "../kernel/routeSupport.js";
export const Route = createFileRoute("/api/tasks/$taskId/close")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { taskId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual", true); if (!auth.ok) return authFailure(auth.error); const body = await jsonBody(request); if (!body.ok) return body.response; return apiResponse(await closeTask(params.taskId, (body.value as { note?: unknown })?.note, auth.context)); } } } });

