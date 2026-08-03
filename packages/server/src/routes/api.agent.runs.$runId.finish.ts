import { createFileRoute } from "@tanstack/react-router";

import { MACHINE_BODY_CAP, readJsonBody } from "../gateway/http.js";
import { machineRouteLimit } from "../gateway/rateLimit.js";
import { authenticateDevice, finishRun, type FinishBody } from "../kernel/runQueue.js";

/** Device credential + invisible run context closes exactly that run's lease. */
export const Route = createFileRoute("/api/agent/runs/$runId/finish")({
  server: {
    handlers: {
      POST: async ({ request, params }: { request: Request; params: { runId: string } }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const limited = machineRouteLimit(request, token || undefined);
        if (limited) return limited;
        const machine = await authenticateDevice(token);
        if (!machine) return Response.json({ error: { code: "UNAUTHORIZED", message: "unknown device credential" } }, { status: 401 });
        const runContext = request.headers.get("x-loopany-run")?.trim();
        if (!runContext) return Response.json({ error: { code: "RUN_CONTEXT_UNKNOWN", message: "missing run context" } }, { status: 403 });
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP);
        if (parsed.kind === "too-large") return Response.json({ error: { code: "TOO_LARGE", message: "body too large" } }, { status: 413 });
        if (parsed.kind !== "ok") return Response.json({ error: { code: "INVALID_BODY", message: "invalid JSON" } }, { status: 400 });
        const result = await finishRun(machine, runContext, params.runId, parsed.body as FinishBody);
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
