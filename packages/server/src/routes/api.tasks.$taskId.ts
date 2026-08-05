import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { objectArtifact, patchTask, replaceFromArtifact, showObject } from "../kernel/objectApi.js";
import { resolveObjectRef } from "../kernel/objectRefs.js";
import * as store from "../db/kernelStore.js";
import { apiResponse, authFailure, ensureBooted, jsonBody, rawArtifact } from "../kernel/routeSupport.js";
import { refusal, refusalResponse } from "../kernel/refusals.js";

export const Route = createFileRoute("/api/tasks/$taskId")({ server: { handlers: {
  GET: async ({ request, params }: { request: Request; params: { taskId: string } }) => {
    await ensureBooted(); const auth = await resolveApiContext(request, "dual"); if (!auth.ok) return authFailure(auth.error);
    const taskId = await resolveObjectRef(params.taskId, auth.context.teamId);
    const accept = request.headers.get("accept") ?? "application/json";
    if (accept.includes("text/markdown")) { const row = await store.getObject(undefined, taskId); if (!row || row.teamId !== auth.context.teamId) return refusalResponse(refusal("NOT_FOUND", `${taskId} was not found`)); if (row.kind !== "task") return refusalResponse(refusal("WRONG_KIND", `${taskId} is a ${row.kind}, not a task`)); return new Response(objectArtifact(row), { headers: { "Content-Type": "text/markdown; charset=utf-8" } }); }
    if (!accept.includes("application/json") && accept !== "*/*") return refusalResponse(refusal("INVALID_BODY", "Accept must allow application/json or text/markdown"), { status: 406 });
    const eventLimit = Number(new URL(request.url).searchParams.get("events") ?? 20);
    if (!Number.isInteger(eventLimit) || eventLimit < 0 || eventLimit > 200) return refusalResponse(refusal("UNKNOWN_FILTER", "events must be an integer from 0 to 200"));
    return apiResponse(await showObject("task", taskId, auth.context, eventLimit));
  },
  PATCH: async ({ request, params }: { request: Request; params: { taskId: string } }) => { await ensureBooted(); const auth = await resolveApiContext(request, "dual", true); if (!auth.ok) return authFailure(auth.error); const taskId = await resolveObjectRef(params.taskId, auth.context.teamId); const type = request.headers.get("content-type")?.split(";", 1)[0]; if (type === "text/markdown") { const raw = await rawArtifact(request); return raw.ok ? apiResponse(await replaceFromArtifact("task", taskId, raw.text, auth.context)) : raw.response; } const body = await jsonBody(request); return body.ok ? apiResponse(await patchTask(taskId, body.value, auth.context)) : body.response; },
} } });
