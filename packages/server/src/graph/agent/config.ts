/**
 * Graph Engineering v1 - THE MACHINE AGENT CHANNEL: the server's side of the
 * configuration.
 *
 * Deliberately small. Every interesting policy - which repos may be touched,
 * whether a default branch may be merged into, which commands a dispatched run
 * may execute, where it may execute them - lives on the AGENT, because that is
 * where the credentials are and a guard is only worth what it guards. What the
 * server owns is the wire: who may talk to the channel, and how long a claim is
 * believed.
 *
 * ── one credential, three directions ────────────────────────────────────────
 *
 * `LOOPANY_AGENT_TOKEN` authenticates the machine agent for ALL of its traffic:
 * outward EFFECTS (claim / heartbeat / report), SENSING (the watch list and the
 * observations it reports), and RUNS (the lifecycle of a dispatched run). It is
 * one credential because it is one process on one machine - captain decision 10's
 * point is precisely that acting and observing are the same trust boundary, so
 * splitting the token would suggest they were two.
 *
 * It is read from the environment and NEVER committed. It is a dev-grade
 * credential on purpose and it is documented as one: it authenticates a process,
 * not a person, and the real ceiling on what that process can do is the R3
 * approval a directive carries plus the agent's own guards. An UNSET token FAILS
 * CLOSED - the channel 401s every request rather than defaulting to open, which is
 * the same inversion `lib/graphWorkspace.ts` makes and for the same reason: this
 * surface hands out work orders that act on the outside world.
 */

/** The shared secret, or undefined when the channel is not configured. */
export function agentToken(): string | undefined {
  const raw = process.env.LOOPANY_AGENT_TOKEN?.trim();
  return raw ? raw : undefined;
}

/** Is the machine-agent channel configured at all? A server with no token serves
 *  no agent - there is nothing to fall back to, because "no token" cannot mean
 *  "anyone" for a surface whose payloads act on GitHub and run commands. */
export function agentChannelConfigured(): boolean {
  return agentToken() !== undefined;
}

/**
 * Constant-time-ish bearer comparison. Length is compared first (an unavoidable
 * leak, and not an interesting one), then every byte, so a wrong token does not
 * reveal its correct prefix through timing.
 */
export function agentTokenMatches(header: string | null | undefined): boolean {
  const expected = agentToken();
  if (!expected) return false;
  const raw = (header ?? "").trim();
  const presented = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * How long a claim is believed without a heartbeat. Long enough for a `gh` call
 * on a slow network or a short sandboxed run, short enough that a dead agent's
 * work is picked up while somebody is still watching the demo.
 *
 * A dispatched run declares its OWN timeout and the agent heartbeats through it,
 * so a legitimately long run is not bounded by this number - only an agent that
 * stopped talking is. That distinction is the whole reason the lease is a lease
 * and not a wall-clock deadline on the work itself.
 */
export const DEFAULT_LEASE_MS = 60_000;

export function leaseMs(): number {
  const raw = Number(process.env.LOOPANY_AGENT_LEASE_MS?.trim());
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : DEFAULT_LEASE_MS;
}

/**
 * How many leases one directive may burn before it FAILS with `LEASE_EXPIRED`.
 * Bounded for the same reason the outbox bounds attempts: an effect that keeps
 * killing its agent must end up in front of a person, not in a loop.
 */
export const DEFAULT_MAX_CLAIMS = 3;

export function maxClaims(): number {
  const raw = Number(process.env.LOOPANY_AGENT_MAX_CLAIMS?.trim());
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_CLAIMS;
}

/** Directives handed out in one claim call. Small: an agent that takes ten work
 *  orders and then dies holds ten leases for nothing. */
export const CLAIM_BATCH = 5;

/** Mirrors offered in one watch-list call. The whole set is normally far below
 *  this; the cap exists so a workspace that grew to thousands of mirrors degrades
 *  into several agent sweeps instead of one very long request burst. */
export const WATCH_LIST_LIMIT = 200;

/**
 * New mirrors ONE reported sweep may create from cross-references. A bound, so a
 * PR body that lists a release train cannot turn one observation into a hundred
 * rows - and, now that the fetch happens off-server, so a compromised or buggy
 * agent cannot inflate the graph by reporting a thousand references either.
 */
export const MAX_DISCOVERED_PER_REPORT = 20;

/**
 * Observations accepted in ONE report. The agent batches by repo and reports a
 * whole sweep at once; this bounds the body it may send (the route caps bytes
 * too - this caps rows, which is the cost that lands in the database).
 */
export const MAX_OBSERVATIONS_PER_REPORT = 500;
