import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { apiResponse, authFailure } from "../kernel/routeSupport.js";
import { systemGraphView } from "../kernel/views.js";

/** A PROJECTION endpoint, never configuration (API spec §8.3): every node, edge
 *  and badge is computed live from `objects` + `runs`. There is no topology
 *  table and no way to wire two loops. */
export const Route = createFileRoute("/api/views/system-graph")({ server: { handlers: { GET: async ({ request }: { request: Request }) => {
  const auth = await resolveApiContext(request, "human"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await systemGraphView(auth.context, new URL(request.url).searchParams));
} } } });
