import { createFileRoute } from "@tanstack/react-router";

import { MACHINE_BODY_CAP, readJsonBody } from "../gateway/http.js";
import { machineRouteLimit } from "../gateway/rateLimit.js";
import { claimMachineInfo, claimRun, enrollDeviceForClaim, type ClaimBody } from "../kernel/runQueue.js";
import { refusal, refusalResponse } from "../kernel/refusals.js";
import { ensureBooted } from "../kernel/routeSupport.js";

/**
 * Device-authenticated long poll for one rewrite queue run.
 *
 * This is ALSO the rewrite line's machine-enrollment surface, the exact mirror
 * of legacy `POST /api/machine/poll`: a v2 daemon polls nothing else, so first
 * contact has to land here or a fresh machine can never join. The body is read
 * BEFORE the credential resolves because enrollment names the machine from the
 * reported host — the rate limiter has already run, so an unauthenticated
 * caller still cannot make this a free body read.
 */
export const Route = createFileRoute("/api/agent/runs/claim")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const limited = machineRouteLimit(request, token || undefined);
        if (limited) return limited;
        await ensureBooted();
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP);
        if (parsed.kind === "too-large") return refusalResponse(refusal("TOO_LARGE", "body too large"));
        if (parsed.kind !== "ok") return refusalResponse(refusal("INVALID_BODY", "invalid JSON"));
        const body = parsed.body as ClaimBody;
        const machine = await enrollDeviceForClaim(token, claimMachineInfo(body));
        if (!machine) return refusalResponse(refusal("UNAUTHORIZED", "unknown device credential"));
        const result = await claimRun(machine, body);
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
