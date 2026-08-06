import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { inbox } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted } from "../kernel/routeSupport.js";
export const Route = createFileRoute("/api/inbox")({ server: { handlers: { GET: async ({ request }: { request: Request }) => { await ensureBooted(); const auth = await resolveApiContext(request, "owner"); if (!auth.ok) return authFailure(auth.error); return apiResponse(await inbox(auth.context)); } } } });

