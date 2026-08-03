import { createFileRoute } from "@tanstack/react-router";

import { MACHINE_BODY_CAP, readJsonBody } from "../gateway/http.js";
import { machineRouteLimit } from "../gateway/rateLimit.js";
import { authenticateDevice, claimRun, type ClaimBody } from "../kernel/runQueue.js";
import { refusal, refusalResponse } from "../kernel/refusals.js";

/** Device-authenticated long poll for one rewrite queue run. */
export const Route = createFileRoute("/api/agent/runs/claim")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const limited = machineRouteLimit(request, token || undefined);
        if (limited) return limited;
        const machine = await authenticateDevice(token);
        if (!machine) return refusalResponse(refusal("UNAUTHORIZED", "unknown device credential"));
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP);
        if (parsed.kind === "too-large") return refusalResponse(refusal("TOO_LARGE", "body too large"));
        if (parsed.kind !== "ok") return refusalResponse(refusal("INVALID_BODY", "invalid JSON"));
        const result = await claimRun(machine, parsed.body as ClaimBody);
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
