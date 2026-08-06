import { createFileRoute } from "@tanstack/react-router";

import { resolveApiContext } from "../kernel/apiAuth.js";
import { refusal } from "../kernel/refusals.js";
import { apiResponse, authFailure, jsonBody } from "../kernel/routeSupport.js";
import * as store from "../db/store.js";
import { ensureServer } from "../server/boot.js";
import { applyOwnerLoopPatch, type OwnerLoopPatch } from "../server/loopMutations.js";

const KEYS = ["name", "cron", "timezone", "notify", "channelId", "model", "agent", "workdir"] as const;

function configOf(loop: NonNullable<Awaited<ReturnType<typeof store.getLoop>>>) {
  return {
    name: loop.name ?? loop.id,
    cron: loop.cron,
    timezone: loop.timezone,
    notify: loop.notify,
    channelId: loop.channelId,
    model: loop.model,
    agent: loop.agent,
    workdir: loop.workdir,
  };
}

/** Workspace basic settings, through the same mutation seam as `patchJob`. */
export const Route = createFileRoute("/api/loops/$loopId/config")({ server: { handlers: { PATCH: async ({ request, params }: { request: Request; params: { loopId: string } }) => {
  const booted = await ensureServer();
  const auth = await resolveApiContext(request, { owner: "loop-governance" }, true);
  if (!auth.ok) return authFailure(auth.error);
  const parsed = await jsonBody(request); if (!parsed.ok) return parsed.response;
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return apiResponse({ ok: false, error: refusal("INVALID_BODY", "loop config must be a JSON object", [], `accepted fields: ${KEYS.join(", ")}`) });
  }
  const raw = parsed.value as Record<string, unknown>;
  const unknown = Object.keys(raw).find((key) => !(KEYS as readonly string[]).includes(key));
  if (unknown) return apiResponse({ ok: false, error: refusal("UNKNOWN_KEY", `${unknown} is not an editable basic setting`, [], `accepted fields: ${KEYS.join(", ")}`) });
  const loop = await store.getLoop(params.loopId);
  if (!loop || loop.teamId !== auth.context.teamId) return apiResponse({ ok: false, error: refusal("NOT_FOUND", `${params.loopId} was not found`) });
  const result = await applyOwnerLoopPatch(loop, raw as OwnerLoopPatch, booted.scheduler);
  if (!result.loop) return apiResponse({ ok: false, error: refusal("INVALID_BODY", result.error ?? "loop config was refused", [], "correct the named setting and retry") });
  return apiResponse({ ok: true, value: { changed: Boolean(result.changed), config: configOf(result.loop) } });
} } } });
