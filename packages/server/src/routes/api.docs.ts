import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { createFromArtifact } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted, rawArtifact } from "../kernel/routeSupport.js";
export const Route = createFileRoute("/api/docs")({ server: { handlers: { POST: async ({ request }: { request: Request }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual", true); if (!auth.ok) return authFailure(auth.error); const raw = await rawArtifact(request); return raw.ok ? apiResponse(await createFromArtifact("doc", raw.text, auth.context)) : raw.response; } } } });

