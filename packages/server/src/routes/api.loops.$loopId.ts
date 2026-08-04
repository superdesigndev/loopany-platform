import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { governLoop, objectArtifact, showObject } from "../kernel/objectApi.js";
import * as store from "../db/kernelStore.js";
import { apiResponse, authFailure, jsonBody } from "../kernel/routeSupport.js";
import { refusal, refusalResponse } from "../kernel/refusals.js";

/**
 * GET is DUAL and reads the loop with its seq-ordered event tail, or — under
 * `Accept: text/markdown` — the canonical charter artifact, which is exactly the
 * file `loop evolve --file` takes back. POST is the KEYED zone: an agent's
 * cadence change, and it still needs a human approval event.
 */
export const Route = createFileRoute("/api/loops/$loopId")({ server: { handlers: {
  GET: async ({ request, params }: { request: Request; params: { loopId: string } }) => {
    const auth = await resolveApiContext(request, "dual"); if (!auth.ok) return authFailure(auth.error);
    const accept = request.headers.get("accept") ?? "application/json";
    if (accept.includes("text/markdown")) {
      const row = await store.getObject(undefined, params.loopId);
      if (!row || row.teamId !== auth.context.teamId) return refusalResponse(refusal("NOT_FOUND", `${params.loopId} was not found`));
      if (row.kind !== "loop") return refusalResponse(refusal("WRONG_KIND", `${params.loopId} is a ${row.kind}, not a loop`));
      return new Response(objectArtifact(row), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }
    if (!accept.includes("application/json") && accept !== "*/*") return refusalResponse(refusal("INVALID_BODY", "Accept must allow application/json or text/markdown"), { status: 406 });
    const eventLimit = Number(new URL(request.url).searchParams.get("events") ?? 20);
    if (!Number.isInteger(eventLimit) || eventLimit < 0 || eventLimit > 200) return refusalResponse(refusal("UNKNOWN_FILTER", "events must be an integer from 0 to 200"));
    return apiResponse(await showObject("loop", params.loopId, auth.context, eventLimit));
  },
  POST: async ({ request, params }: { request: Request; params: { loopId: string } }) => { const auth = await resolveApiContext(request, "agent", true); if (!auth.ok) return authFailure(auth.error); const body = await jsonBody(request); return body.ok ? apiResponse(await governLoop(params.loopId, body.value, auth.context)) : body.response; },
} } });
