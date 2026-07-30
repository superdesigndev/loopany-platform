/**
 * RESOLVING A CALLER - the database half of the run credential.
 *
 * A `graph` call arrives with a run id and a derived token (`identity.ts`). This
 * turns that pair into the context the verbs need: which team, which object the
 * run was dispatched from, which role it was given - and, crucially, whether the
 * run is still LIVE.
 *
 * ── the lease is the authority, again ───────────────────────────────────────
 *
 * The token proves "something holding the channel secret issued this for run X".
 * It does not prove the run is still happening, and it must not: a finished run
 * whose token still worked could move tasks days later, and a zombie could
 * contradict its own successor. So every call re-reads the DIRECTIVE and refuses
 * unless it is still `claimed` - the same check `agent/runs.ts` and
 * `effects/channel.ts` make before accepting a report, for the same reason and
 * with the same answer.
 *
 * That also gives the credential its expiry for free: a run token stops working
 * the moment its work order settles, which tracks the actual work rather than a
 * guess about how long it would take.
 */
import * as graph from "../../db/graphStore.js";
import { directiveIdOfRun, instructionOf } from "../effects/instruction.js";
import { agentToken } from "../agent/config.js";
import { runCliTokenMatches } from "./identity.js";
import type { CliRunContext } from "./cli.js";

export type ResolveFail = { ok: false; status: number; code: string; message: string };
export type ResolveOk = { ok: true; ctx: CliRunContext };

/**
 * Resolve `(runId, bearer)` to a live run context, or refuse with a status.
 *
 * Every refusal is distinct on purpose - "the channel is not configured", "that
 * token is not for this run", "there is no such work order" and "that run is over"
 * send an operator to four different places, and collapsing them into one 401
 * would make the first live debugging session much longer than it needs to be.
 */
export async function resolveRunContext(input: {
  runId: string;
  authorization: string | null | undefined;
  now: string;
}): Promise<ResolveOk | ResolveFail> {
  const secret = agentToken();
  if (!secret) {
    return {
      ok: false,
      status: 401,
      code: "UNCONFIGURED",
      message: "the machine agent channel is not configured on this server",
    };
  }
  if (!runCliTokenMatches(input.authorization, secret, input.runId)) {
    return { ok: false, status: 401, code: "UNAUTHORIZED", message: "that credential is not this run's" };
  }

  const directiveId = directiveIdOfRun(input.runId);
  if (!directiveId) {
    return { ok: false, status: 400, code: "NOT_A_RUN", message: `"${input.runId}" is not a run id` };
  }
  const directive = await graph.getDirective(undefined, directiveId);
  if (!directive) {
    return { ok: false, status: 404, code: "UNKNOWN_RUN", message: `no work order behind ${input.runId}` };
  }
  if (directive.state !== "claimed") {
    return {
      ok: false,
      status: 409,
      code: "RUN_OVER",
      message: `this run's work order is "${directive.state}" - a run may only write while it is running`,
    };
  }

  const spec = instructionOf(directive.payload);
  const role = (directive.payload as Record<string, unknown> | null)?.role;

  return {
    ok: true,
    ctx: {
      teamId: directive.teamId,
      // THE RUN IS THE ACTOR (design §12: entrance `agent-run`, actor id = run id).
      // Not the machine, not the directive - the run, so the Timeline names the
      // thing that actually decided.
      actor: { entrance: "agent-run", actorId: input.runId },
      ...(directive.objectId ? { subjectId: directive.objectId } : {}),
      ...(typeof role === "string" && role.trim() ? { role: role.trim() } : {}),
      now: input.now,
      ...(spec ? {} : {}),
    },
  };
}
