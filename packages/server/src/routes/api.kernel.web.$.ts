import { createFileRoute } from "@tanstack/react-router";
import { readJsonBody, MACHINE_BODY_CAP } from "../gateway/http";

const PREFIX = "/api/kernel/web/";

function jsonError(status: number, message: string) {
  return Response.json({ ok: false, error: message }, { status });
}

async function dispatch(request: Request): Promise<Response> {
  try {
    await (await import("../server/boot.js")).ensureServer();
    const url = new URL(request.url);
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length).split("/").filter(Boolean) : [];
    const teamId = url.searchParams.get("teamId") ?? "";
    if (!teamId) return jsonError(400, "teamId is required");
    const web = await import("../kernel-web/gateway.js");
    if (request.method === "GET" && path[0] === "workspace") return Response.json(await web.workspace(teamId));
    if (request.method === "GET" && path[0] === "tasks" && path[1]) return Response.json(await web.taskDetail(teamId, decodeURIComponent(path[1])));
    if (request.method === "GET" && path[0] === "docs" && path[1]) return Response.json(await web.docDetail(teamId, decodeURIComponent(path[1])));
    if (request.method === "GET" && path[0] === "runs" && path[1]) return Response.json(await web.runDetail(teamId, decodeURIComponent(path[1])));
    if (request.method === "GET" && path[0] === "timeline") return Response.json(await web.timeline(teamId, url.searchParams.get("all") === "true"));
    if (request.method === "POST" && path[0] === "command") {
      const parsed = await readJsonBody(request, MACHINE_BODY_CAP);
      if (parsed.kind !== "ok") return jsonError(parsed.kind === "too-large" ? 413 : 400, "Invalid request body");
      const result = await web.command(teamId, (parsed.body as { command?: unknown } | null)?.command);
      return Response.json(result.body, { status: result.status });
    }
    return jsonError(404, "Not found");
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    return jsonError(status, error instanceof Error ? error.message : "Internal error");
  }
}

export const Route = createFileRoute("/api/kernel/web/$")({
  server: { handlers: { GET: ({ request }) => dispatch(request), POST: ({ request }) => dispatch(request) } },
});
