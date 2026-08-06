import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { apiResponse, authFailure, ensureBooted } from "../kernel/routeSupport.js";
import { inboxView } from "../kernel/views.js";

/** The inbox screen's composed read (API spec §8.1). Human-session only — a run
 *  carrying run context is refused before any query runs. */
export const Route = createFileRoute("/api/views/inbox")({ server: { handlers: { GET: async ({ request }: { request: Request }) => {
  await ensureBooted(); const auth = await resolveApiContext(request, "owner"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await inboxView(auth.context));
} } } });
