import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { apiResponse, authFailure, ensureBooted } from "../kernel/routeSupport.js";
import { docView } from "../kernel/views.js";

/** One doc, body included. `format` decides the client's render path: markdown
 *  through client-side components (raw HTML not rendered), html into a sandboxed
 *  iframe with no `allow-same-origin` (design §7). */
export const Route = createFileRoute("/api/views/doc/$docId")({ server: { handlers: { GET: async ({ request, params }: { request: Request; params: { docId: string } }) => {
  await ensureBooted(); const auth = await resolveApiContext(request, "owner"); if (!auth.ok) return authFailure(auth.error);
  return apiResponse(await docView(params.docId, auth.context));
} } } });
