import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { apiResponse, authFailure, ensureBooted } from "../kernel/routeSupport.js";
import { loopView } from "../kernel/views.js";

/** The loop page (API spec §8.2): charter, evolve diffs, its open tasks, health. */
export const Route = createFileRoute("/api/views/loop/$loopId")({ server: { handlers: { GET: async ({ request, params }: { request: Request; params: { loopId: string } }) => {
  await ensureBooted(); const auth = await resolveApiContext(request, "owner"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await loopView(params.loopId, auth.context));
} } } });
