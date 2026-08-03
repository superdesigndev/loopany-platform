import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { createFromArtifact, listTasks } from "../kernel/objectApi.js";
import { apiResponse, authFailure, rawArtifact } from "../kernel/routeSupport.js";

export const Route = createFileRoute("/api/tasks")({ server: { handlers: {
  GET: async ({ request }: { request: Request }) => { const auth = await resolveApiContext(request, "dual"); if (!auth.ok) return authFailure(auth.error); return apiResponse(await listTasks(auth.context, new URL(request.url).searchParams)); },
  POST: async ({ request }: { request: Request }) => { const auth = await resolveApiContext(request, "dual", true); if (!auth.ok) return authFailure(auth.error); const raw = await rawArtifact(request); if (!raw.ok) return raw.response; return apiResponse(await createFromArtifact("task", raw.text, auth.context)); },
} } });

