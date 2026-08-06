import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { apiResponse, authFailure, ensureBooted } from "../kernel/routeSupport.js";
import { docsView } from "../kernel/views.js";

/** The doc library index. Bodies are not inlined — one 4 MB report would
 *  otherwise dominate the payload. */
export const Route = createFileRoute("/api/views/docs")({ server: { handlers: { GET: async ({ request }: { request: Request }) => {
  await ensureBooted(); const auth = await resolveApiContext(request, "owner"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await docsView(auth.context));
} } } });
