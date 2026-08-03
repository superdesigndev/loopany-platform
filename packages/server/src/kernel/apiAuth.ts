import { authEnabled, currentUser, requestScope } from "../auth.js";
import type { KernelObject } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import type { Machine, Run } from "../db/schema.js";
import { authenticateDevice } from "./runQueue.js";
import { machineRouteLimit } from "../gateway/rateLimit.js";
import { refusal, type ApiRefusal } from "./refusals.js";
import type { Actor } from "./types.js";

export interface ApiContext {
  teamId: string;
  actor: Actor;
  mode: "agent" | "human";
  machine?: Machine;
  run?: Run;
  loop?: KernelObject;
}

export async function resolveApiContext(
  request: Request,
  requirement: "dual" | "agent" | "human",
  mutation = false,
): Promise<{ ok: true; context: ApiContext } | { ok: false; error: ApiRefusal }> {
  const runHeader = request.headers.get("x-loopany-run")?.trim();
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (machineRouteLimit(request, token || undefined)) {
    return { ok: false, error: refusal("RATE_LIMITED", "rate limited — slow down", [], "retry after one second") };
  }

  if (runHeader || token) {
    if (requirement === "human") return { ok: false, error: refusal("NOT_HUMAN", "this operation is waiting for a human", [], "use the web UI or the human CLI outside a run") };
    const machine = await authenticateDevice(token);
    if (!machine) return { ok: false, error: refusal("UNAUTHORIZED", "unknown device credential", [], "connect this machine with `loopany up`") };
    if (!runHeader) return { ok: false, error: refusal("NO_RUN_CONTEXT", "this endpoint needs a run context and the request carried none", [], "the daemon sets LOOPANY_RUN_ID and the CLI attaches it") };
    const run = await store.getRunRow(undefined, runHeader);
    if (!run || run.machineId !== machine.id) {
      return { ok: false, error: refusal("RUN_CONTEXT_UNKNOWN", `${runHeader} is not a run this machine is currently holding`, [{ path: "X-Loopany-Run", message: "unknown or not claimed by this machine", got: runHeader }], "the run may have finished or been reclaimed; stop and let the daemon claim a fresh one") };
    }
    const terminalRead = !mutation && run.leaseState === "terminal-grace";
    if (!terminalRead && (run.queueState !== "claimed" || run.leaseState !== "active" || Date.parse(run.leaseExpiresAt ?? "") <= Date.now())) {
      return { ok: false, error: refusal("LEASE_LOST", `${run.id} no longer holds its lease`, [], "stop work on it — the lease is the authority") };
    }
    const loop = await store.getObject(undefined, run.loopId);
    if (!loop || loop.kind !== "loop") return { ok: false, error: refusal("RUN_CONTEXT_UNKNOWN", `${runHeader} has no live loop context`) };
    return { ok: true, context: { teamId: loop.teamId, actor: { entrance: "agent", actorId: run.id }, mode: "agent", machine, run, loop } };
  }

  if (requirement === "agent") return { ok: false, error: refusal("NO_RUN_CONTEXT", "this endpoint needs a run context and the request carried none", [], "run this command from an active Loopany run") };
  const user = await currentUser();
  if (authEnabled && !user) return { ok: false, error: refusal("UNAUTHORIZED", "a signed-in human session is required", [], "sign in, then retry") };
  const scope = await requestScope();
  return { ok: true, context: { teamId: scope.teamId, actor: { entrance: "human", actorId: user?.id ?? "human:open-mode" }, mode: "human" } };
}
