import { createFileRoute } from "@tanstack/react-router";

import { resolveApiContext } from "../kernel/apiAuth.js";
import { CHARTER_MAX_BYTES, readCharterForContext, replaceCharterForContext, type CharterSnapshot } from "../kernel/charters.js";
import { refusal, refusalResponse } from "../kernel/refusals.js";
import { authFailure, ensureBooted } from "../kernel/routeSupport.js";

export function charterResponse(charter: CharterSnapshot, accept: string): Response {
  const headers = { ETag: `"${charter.version}"` };
  if (accept.includes("text/markdown")) {
    return new Response(charter.body, { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" } });
  }
  if (!accept.includes("application/json") && accept !== "*/*") {
    return refusalResponse(refusal("INVALID_BODY", "Accept must allow application/json or text/markdown"), { status: 406 });
  }
  return Response.json({ charter }, { headers });
}

export function expectedCharterVersion(request: Request): number | undefined {
  const raw = request.headers.get("if-match")?.trim();
  const match = raw && /^(?:W\/)?"(\d+)"$/.exec(raw);
  if (!match) return undefined;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : undefined;
}

export const Route = createFileRoute("/api/loops/$loopId/charter")({ server: { handlers: {
  GET: async ({ request, params }: { request: Request; params: { loopId: string } }) => {
    await ensureBooted();
    const auth = await resolveApiContext(request, "dual");
    if (!auth.ok) return authFailure(auth.error);
    const found = await readCharterForContext(params.loopId, auth.context);
    if (!found.ok) return refusalResponse(found.error);
    if (!found.value) return refusalResponse(refusal("NOT_FOUND", `${params.loopId} has no charter yet`));
    return charterResponse(found.value, request.headers.get("accept") ?? "application/json");
  },
  PATCH: async ({ request, params }: { request: Request; params: { loopId: string } }) => {
    await ensureBooted();
    const auth = await resolveApiContext(request, "dual", true);
    if (!auth.ok) return authFailure(auth.error);
    const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (type !== "text/markdown") {
      return refusalResponse(refusal("INVALID_BODY", "charter replacement requires Content-Type: text/markdown"), { status: 415 });
    }
    const expected = expectedCharterVersion(request);
    if (expected === undefined) return refusalResponse(refusal("EXPECTED_VERSION_REQUIRED", "charter replacement requires If-Match: \"<version>\""));
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > CHARTER_MAX_BYTES) {
      return refusalResponse(refusal("TOO_LARGE", `charter body exceeds the ${CHARTER_MAX_BYTES}-byte complete-body limit`));
    }
    const changed = await replaceCharterForContext(params.loopId, body, expected, auth.context);
    return changed.ok ? charterResponse(changed.value.charter, request.headers.get("accept") ?? "application/json") : refusalResponse(changed.error);
  },
} } });
