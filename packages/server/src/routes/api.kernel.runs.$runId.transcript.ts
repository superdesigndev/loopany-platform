import { createFileRoute } from "@tanstack/react-router";
import { readJsonBody } from "../gateway/http.js";
import { machineRouteLimit } from "../gateway/rateLimit.js";
import { appendRunTranscript, TRANSCRIPT_REQUEST_CAP } from "../kernel/transcript.js";

function error(status: number, code: string, message: string) {
  return Response.json({ ok: false, code, message }, { status });
}

/** Run-scoped transcript ingress. It is intentionally separate from Kernel
 * Commands: appending diagnostic bytes must not contend with Task/Run CAS. */
export async function putRunTranscript(request: Request, runId: string): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return error(401, "UNAUTHORIZED", "missing run credential");
  const limited = machineRouteLimit(request, token);
  if (limited) return error(429, "RATE_LIMITED", "rate limited - slow down");
  const parsed = await readJsonBody(request, TRANSCRIPT_REQUEST_CAP + 32 * 1024);
  if (parsed.kind === "too-large") return error(413, "TRANSCRIPT_TOO_LARGE", "transcript chunk is too large");
  if (parsed.kind !== "ok") return error(400, "INVALID_TRANSCRIPT", "request body is not valid JSON");
  const result = await appendRunTranscript(token, runId, parsed.body);
  if (!result.ok) return error(result.status, result.code, result.message);
  return Response.json(result);
}

export const Route = createFileRoute("/api/kernel/runs/$runId/transcript")({
  server: { handlers: { PUT: ({ request, params }) => putRunTranscript(request, params.runId) } },
});
