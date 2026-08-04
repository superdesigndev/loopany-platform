import { createFileRoute } from "@tanstack/react-router";

import { MACHINE_BODY_CAP, readJsonBody } from "../gateway/http.js";
import { machineRouteLimit } from "../gateway/rateLimit.js";
import { authenticateDevice, finishRun, type FinishBody } from "../kernel/runQueue.js";
import { refusal, refusalResponse } from "../kernel/refusals.js";
import { ensureBooted } from "../kernel/routeSupport.js";

/** Device credential + invisible run context closes exactly that run's lease. */
export const Route = createFileRoute("/api/agent/runs/$runId/finish")({
  server: {
    handlers: {
      POST: async ({ request, params }: { request: Request; params: { runId: string } }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const limited = machineRouteLimit(request, token || undefined);
        if (limited) return limited;
        await ensureBooted();
        const machine = await authenticateDevice(token);
        if (!machine) return refusalResponse(refusal("UNAUTHORIZED", "unknown device credential"));
        const runContext = request.headers.get("x-loopany-run")?.trim();
        if (!runContext) return refusalResponse(refusal("NO_RUN_CONTEXT", "missing run context"));
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP);
        if (parsed.kind === "too-large") return refusalResponse(refusal("TOO_LARGE", "body too large"));
        if (parsed.kind !== "ok") return refusalResponse(refusal("INVALID_BODY", "invalid JSON"));
        const result = await finishRun(machine, runContext, params.runId, parsed.body as FinishBody);
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
