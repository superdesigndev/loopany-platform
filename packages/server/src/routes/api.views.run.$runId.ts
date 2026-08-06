import { createFileRoute } from "@tanstack/react-router";

import { resolveApiContext } from "../kernel/apiAuth.js";
import { authFailure, apiResponse, ensureBooted } from "../kernel/routeSupport.js";
import { runView } from "../kernel/views.js";

/** One production run: report, metrics, trace, cost, session and reported files. */
export const Route = createFileRoute("/api/views/run/$runId")({ server: { handlers: { GET: async ({ request, params }: { request: Request; params: { runId: string } }) => {
  await ensureBooted(); const auth = await resolveApiContext(request, "owner"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await runView(params.runId, auth.context));
} } } });
