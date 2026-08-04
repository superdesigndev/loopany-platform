import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { apiResponse, authFailure } from "../kernel/routeSupport.js";
import { tasksView } from "../kernel/views.js";

/** The task BOARD. Every column is a STATE predicate — a time window would leak
 *  work, so none is offered (design §6). */
export const Route = createFileRoute("/api/views/tasks")({ server: { handlers: { GET: async ({ request }: { request: Request }) => {
  const auth = await resolveApiContext(request, "human"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await tasksView(auth.context, new URL(request.url).searchParams));
} } } });
