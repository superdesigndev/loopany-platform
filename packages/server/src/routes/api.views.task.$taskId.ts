import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { apiResponse, authFailure } from "../kernel/routeSupport.js";
import { taskView } from "../kernel/views.js";

/** The task page: the artifact, its verbatim execution payload, the event
 *  timeline ordered by seq, and the runs that touched it. */
export const Route = createFileRoute("/api/views/task/$taskId")({ server: { handlers: { GET: async ({ request, params }: { request: Request; params: { taskId: string } }) => {
  const auth = await resolveApiContext(request, "human"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await taskView(params.taskId, auth.context));
} } } });
