/**
 * THE AUTH SEAM for the rewrite's object endpoints.
 *
 * Two credentials, two caller modes: an enrolled device credential acts with
 * its owner's authority, while a request with run context is an AGENT and is
 * constrained by that run's lease.
 *
 * THE LOAD-BEARING RULE: **what separates an agent from a human is the presence
 * of RUN CONTEXT, not the presence of a credential.** It is a positive test for
 * `X-Loopany-Run`, never a negative test for a token (CLI spec §2.2). This
 * matters because the ordinary human runs the CLI on the SAME machine the daemon
 * is registered on, so a stored device credential is present on every connected
 * machine — keying the guard on the token would make `loopany inbox`/`answer`
 * refuse `NOT_HUMAN` for exactly the person the endpoint exists to serve, and the
 * refusal's teaching ("use the human CLI outside a run") would be wrong: they ARE
 * outside a run.
 *
 * With no run context, a valid device credential is the enrolled owner's
 * terminal authority. It resolves only to the machine's own team. A foreign or
 * stale token resolves to no machine and remains unauthorized; anonymous
 * requests are still refused when the login gate is enabled.
 *
 * WHICH CREDENTIAL AUTHENTICATES AN AGENT: either the machine's device token OR
 * **the run's own lease token** — and the lease is the one a delivery is
 * guaranteed to carry. The device token is a FILE on the machine's disk under
 * `LOOPANY_HOME`, and the daemon does not put `LOOPANY_HOME` (or the token) into
 * the coding agent's allowlisted child env, so a stack whose home is relocated —
 * which every dev/demo stack's is — had the in-run CLI read `~/.loopany`, send
 * some OTHER server's token, and get `UNAUTHORIZED` on every kernel verb. A run
 * could not file its own products. The lease is env-carried (`LOOPANY_RUN_TOKEN`),
 * per-run, already the authority this seam checks two lines further down, and
 * narrower than the machine-wide device token, so accepting it is the fix at the
 * authoritative spot. It authenticates ONLY the run it was minted for: a lease
 * naming another run is refused, and a lease with NO run context is not an agent
 * at all (it falls through to the human branch like any unknown token).
 */
import { authEnabled, currentUser, requestScope } from "../auth.js";
import * as store from "../db/kernelStore.js";
import * as legacyStore from "../db/store.js";
import type { Loop, Machine, Run } from "../db/schema.js";
import { authenticateDevice } from "./runQueue.js";
import { machineRouteLimit } from "../gateway/rateLimit.js";
import { resolveLease, resolveRunContextLease } from "../gateway/tokens.js";
import { refusal, type ApiRefusal } from "./refusals.js";
import type { Actor } from "./types.js";

export interface ApiContext {
  teamId: string;
  actor: Actor;
  mode: "agent" | "human";
  machine?: Machine;
  run?: Run;
  loop?: Loop;
}

export type ApiAuthResult = { ok: true; context: ApiContext } | { ok: false; error: ApiRefusal };

/**
 * WHICH human surface a human-only endpoint is, so the run-context refusal
 * teaches the path that run actually has.
 *
 * The route guard answers FIRST — before any kernel function runs — so a hint
 * that only exists in the kernel (`createFromArtifact`/`loopLifecycle` both
 * write one) is unreachable at the wire. Rather than let the inbox voice speak
 * for every human-only endpoint, each route names its surface and the two
 * altitudes teach the same thing.
 */
export type HumanSurface = "inbox" | "loop-governance";

/** `"human"` keeps the default inbox voice; the object form names the surface. */
export type ApiRequirement = "dual" | "agent" | "human" | { human: HumanSurface };

const NOT_HUMAN_TEACHING: Record<HumanSurface, { message: string; hint: string }> = {
  inbox: {
    message: "this operation is waiting for a human",
    hint: "a run cannot answer or read the human inbox — its worklist is `task list --watcher <your-loop-id> --due`",
  },
  "loop-governance": {
    message: "creating a loop and moving its lifecycle are governance and are the owner's act",
    hint: "a run proposes it instead: `loopany task create --file <path> --needs-human \"<the ask>\" --watcher <your-loop-id>`",
  },
};

/** The session half, injected so the seam is testable without the framework's
 *  request-scoped context. Production always uses the real pair. */
export interface SessionSeam {
  currentUser: typeof currentUser;
  requestScope: typeof requestScope;
  authEnabled: boolean;
}

const REAL_SESSION: SessionSeam = { currentUser, requestScope, authEnabled };

/**
 * Authenticate the MACHINE behind a request that carries run context, from
 * either of the two credentials a delivery can hold.
 *
 * The device token is tried first (unchanged, and the only shape an older daemon
 * sends). A token that is not a device token is tried as the run's LEASE, which
 * is what the daemon exports as `LOOPANY_RUN_TOKEN` into every run. The lease is
 * accepted only for the run it names: a lease for a DIFFERENT run is a wrong
 * credential, not an unknown one, and says so — silently ignoring it would leave
 * the caller re-reading a generic "unknown credential" with nothing to fix.
 *
 * A lease whose machine row is gone is UNAUTHORIZED rather than a crash: the
 * machine was deleted under a live run, and the answer is the same one an
 * unenrolled machine gets.
 */
async function authenticateRunCaller(
  token: string,
  runHeader: string,
): Promise<{ ok: true; machine: Machine } | { ok: false; error: ApiRefusal }> {
  const device = await authenticateDevice(token);
  if (device) return { ok: true, machine: device };
  const lease = token ? await resolveLease(token) : undefined;
  if (!lease) {
    return { ok: false, error: refusal("UNAUTHORIZED", "unknown credential", [{ path: "Authorization", message: "neither this machine's device token nor this run's lease" }], "connect this machine with `loopany up`; inside a run the CLI sends the run's own credential") };
  }
  if (lease.runId !== runHeader) {
    return { ok: false, error: refusal("UNAUTHORIZED", "this run credential belongs to another run", [{ path: "Authorization", message: "the lease names a different run", got: lease.runId, expected: runHeader }], "a run authenticates with its own credential only — do not carry one between runs") };
  }
  const machine = await legacyStore.getMachine(lease.machineId);
  if (!machine) return { ok: false, error: refusal("UNAUTHORIZED", "unknown credential", [{ path: "Authorization", message: "the lease's machine is no longer enrolled" }], "connect this machine with `loopany up`") };
  return { ok: true, machine };
}

export async function resolveApiContext(
  request: Request,
  need: ApiRequirement,
  mutation = false,
  session: SessionSeam = REAL_SESSION,
): Promise<ApiAuthResult> {
  const requirement = typeof need === "string" ? need : "human";
  const humanSurface: HumanSurface = typeof need === "string" ? "inbox" : need.human;
  const runHeader = request.headers.get("x-loopany-run")?.trim();
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (machineRouteLimit(request, token || undefined)) {
    return { ok: false, error: refusal("RATE_LIMITED", "rate limited — slow down", [], "retry after one second") };
  }

  // ---- the agent class: run context present ----
  if (runHeader) {
    if (requirement === "human") {
      const teaching = NOT_HUMAN_TEACHING[humanSurface];
      return { ok: false, error: refusal(
        "NOT_HUMAN",
        teaching.message,
        [{ path: "X-Loopany-Run", message: "a request carrying run context is an agent's", got: runHeader }],
        teaching.hint,
      ) };
    }
    const caller = await authenticateRunCaller(token, runHeader);
    if (!caller.ok) return { ok: false, error: caller.error };
    const machine = caller.machine;
    const run = await store.getRunRow(undefined, runHeader);
    // "No such run" and "not yours" are one answer on purpose: the endpoint must
    // not be usable to enumerate another machine's runs.
    if (!run || run.machineId !== machine.id) {
      return { ok: false, error: refusal("RUN_CONTEXT_UNKNOWN", `${runHeader} is not a run this machine is currently holding`, [{ path: "X-Loopany-Run", message: "unknown or not claimed by this machine", got: runHeader }], "the run may have finished or been reclaimed; stop and let the daemon claim a fresh one") };
    }
    // Authority lives in the durable `run_leases` row — the ONE run credential
    // (the rewrite's parallel queue/lease columns retired in convergence S5). A
    // terminal-grace lease serves reads only, so a woken machine can still read
    // what it was working on while only its final report reconciles.
    const lease = await resolveRunContextLease(run.id, machine.id);
    if (!lease || (mutation && lease.state !== "active")) {
      return { ok: false, error: refusal("LEASE_LOST", `${run.id} no longer holds its lease`, [], "stop work on it — the lease is the authority") };
    }
    const loop = await legacyStore.getLoop(run.loopId);
    if (!loop) return { ok: false, error: refusal("RUN_CONTEXT_UNKNOWN", `${runHeader} has no live loop context`) };
    return { ok: true, context: { teamId: loop.teamId ?? machine.teamId ?? `team-${loop.userId}`, actor: { entrance: "agent", actorId: run.id }, mode: "agent", machine, run, loop } };
  }

  // ---- no run context ----
  if (requirement === "agent") {
    return { ok: false, error: refusal("NO_RUN_CONTEXT", "this endpoint needs a run context and the request carried none", [], "ownership is resolved from the calling run; a human session has no run to resolve — edit the charter on the loop page instead") };
  }

  const user = await session.currentUser();
  if (user) {
    const scope = await session.requestScope();
    return { ok: true, context: { teamId: scope.teamId, actor: { entrance: "human", actorId: user.id }, mode: "human" } };
  }

  // The enrolled device is the owner at the terminal. Authenticate the WHOLE
  // credential (derived id + full hash) and bind it to only the machine's home
  // team; no active-team cookie or caller-supplied scope participates here.
  const machine = token ? await authenticateDevice(token) : undefined;
  if (machine) {
    return {
      ok: true,
      context: {
        teamId: machine.teamId ?? legacyStore.teamIdForUser(machine.userId),
        actor: { entrance: "human", actorId: machine.userId },
        mode: "human",
        machine,
      },
    };
  }
  if (session.authEnabled) {
    return { ok: false, error: refusal("UNAUTHORIZED", "an enrolled device credential or signed-in session is required", [], "connect this machine with `loopany up`, or sign in and retry") };
  }

  const scope = await session.requestScope();
  return { ok: true, context: { teamId: scope.teamId, actor: { entrance: "human", actorId: "human:open-mode" }, mode: "human" } };
}
