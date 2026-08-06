import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { resolveObjectRef } from "../kernel/objectRefs.js";
import { leaveDirective } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted, jsonBody } from "../kernel/routeSupport.js";

/**
 * THE HUMAN-INITIATED conversation, alongside the agent-initiated one at
 * `/verdict`. A person tells the watching loop something about an open task and
 * one run is queued for it, carrying their words verbatim.
 *
 * OWNER-SCOPE on the same positive run-context test every owner surface uses
 * — a request naming a run is an agent's, and a loop instructing itself is a
 * loop with no cadence at all. The kernel double-covers it (`leaveDirective`).
 */
export const Route = createFileRoute("/api/tasks/$taskId/directive")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { taskId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, "owner", true); if (!auth.ok) return authFailure(auth.error); const body = await jsonBody(request); if (!body.ok) return body.response; return apiResponse(await leaveDirective(await resolveObjectRef(params.taskId, auth.context.teamId), (body.value as { directive?: unknown })?.directive, auth.context)); } } } });
