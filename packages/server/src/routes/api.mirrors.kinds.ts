import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { mirrorKinds } from "../kernel/mirrorApi.js";
import { apiResponse, authFailure, ensureBooted } from "../kernel/routeSupport.js";

/** THE VOCABULARY, SELF-EXPOSING. Kinds are free-form, so the only honest answer
 *  to "what kinds are there?" is the ones actually in use, with counts — the
 *  canonical spellings ride along flagged `known`. */
export const Route = createFileRoute("/api/mirrors/kinds")({ server: { handlers: { GET: async ({ request }: { request: Request }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual"); if (!auth.ok) return authFailure(auth.error); return apiResponse(await mirrorKinds(auth.context)); } } } });
