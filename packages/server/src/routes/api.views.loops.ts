import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { apiResponse, authFailure, ensureBooted } from "../kernel/routeSupport.js";
import { loopsView } from "../kernel/views.js";

/** The loop list: identity, cadence, health from runs, current load. */
export const Route = createFileRoute("/api/views/loops")({ server: { handlers: { GET: async ({ request }: { request: Request }) => {
  await ensureBooted(); const auth = await resolveApiContext(request, "owner"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await loopsView(auth.context));
} } } });
