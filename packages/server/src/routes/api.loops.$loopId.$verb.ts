import { createFileRoute } from "@tanstack/react-router";

import * as store from "../db/store.js";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { prodLoopRecord } from "../kernel/loopRefs.js";
import { refusal } from "../kernel/refusals.js";
import { apiResponse, authFailure } from "../kernel/routeSupport.js";
import { ensureServer } from "../server/boot.js";
import { applyOwnerLoopPatch } from "../server/loopMutations.js";

/** Pause/resume the production loop. Pausing returns u16's warning, never a block. */
export const Route = createFileRoute("/api/loops/$loopId/$verb")({ server: { handlers: { POST: async ({ request, params }: { request: Request; params: { loopId: string; verb: string } }) => {
  const booted = await ensureServer();
  const auth = await resolveApiContext(request, { owner: "loop-governance" }, true);
  if (!auth.ok) return authFailure(auth.error);
  if (params.verb !== "pause" && params.verb !== "resume") {
    return apiResponse({ ok: false, error: refusal("UNKNOWN_KEY", `${params.verb} is not a loop lifecycle action here`, [], "use pause or resume") });
  }
  const loop = await store.getLoop(params.loopId);
  if (!loop || loop.teamId !== auth.context.teamId) return apiResponse({ ok: false, error: refusal("NOT_FOUND", `${params.loopId} was not found`) });
  const result = await applyOwnerLoopPatch(loop, { enabled: params.verb === "resume" }, booted.scheduler);
  if (!result.loop) return apiResponse({ ok: false, error: refusal("INVALID_BODY", result.error ?? `${params.verb} was refused`) });
  return apiResponse({ ok: true, value: {
    changed: Boolean(result.changed),
    loop: { id: result.loop.id, status: prodLoopRecord(result.loop).status },
    ...(result.warning ? { warning: result.warning } : {}),
  } });
} } } });
