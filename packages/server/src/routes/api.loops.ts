import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { createFromArtifact, listLoops } from "../kernel/objectApi.js";
import { apiResponse, authFailure, ensureBooted, rawArtifact } from "../kernel/routeSupport.js";

/**
 * The loop collection. GET is DUAL (a team-scoped read an agent legitimately
 * needs to resolve a `--watcher` id); POST is HUMAN ONLY — creating a loop mints
 * a standing cadence and a new actor, which is governance (API spec §1.16).
 */
export const Route = createFileRoute("/api/loops")({ server: { handlers: {
  GET: async ({ request }: { request: Request }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual"); if (!auth.ok) return authFailure(auth.error); return apiResponse(await listLoops(auth.context, new URL(request.url).searchParams)); },
  POST: async ({ request }: { request: Request }) => { await ensureBooted(); const auth = await resolveApiContext(request, { human: "loop-governance" }, true); if (!auth.ok) return authFailure(auth.error); const raw = await rawArtifact(request); if (!raw.ok) return raw.response; return apiResponse(await createFromArtifact("loop", raw.text, auth.context)); },
} } });
