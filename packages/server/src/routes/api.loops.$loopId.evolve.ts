import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { replaceFromArtifact } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted, rawArtifact } from "../kernel/routeSupport.js";
export const Route = createFileRoute("/api/loops/$loopId/evolve")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { loopId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, "agent", true); if (!auth.ok) return authFailure(auth.error); const raw = await rawArtifact(request); return raw.ok ? apiResponse(await replaceFromArtifact("loop", params.loopId, raw.text, auth.context, new Date(), "charter-evolved")) : raw.response; } } } });

