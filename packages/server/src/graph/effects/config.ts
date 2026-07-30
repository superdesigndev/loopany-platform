/**
 * Graph Engineering v1 - EFFECT DELIVERY: the server's side of the configuration.
 *
 * Deliberately small. The interesting policy - which repos may be touched,
 * whether a default branch may be merged into - lives on the AGENT, because that
 * is where the credentials are and a guard is only worth what it guards. What the
 * server owns is the wire: who may talk to the directive channel, and how long a
 * claim is believed.
 *
 * ── the token ───────────────────────────────────────────────────────────────
 *
 * `LOOPANY_EFFECT_AGENT_TOKEN` is a shared secret between this server and the
 * effect agent, read from the environment and NEVER committed. It is a dev-grade
 * credential on purpose and it is documented as one: it authenticates a process,
 * not a person, and the real ceiling on what that process can do is the R3
 * approval the directive carries plus the agent's own guards. An UNSET token
 * FAILS CLOSED - the channel 401s every request rather than defaulting to open,
 * which is the same inversion `lib/graphWorkspace.ts` makes and for the same
 * reason: this surface hands out work orders that act on the outside world.
 */

/** The shared secret, or undefined when the channel is not configured. */
export function effectAgentToken(): string | undefined {
  const raw = process.env.LOOPANY_EFFECT_AGENT_TOKEN?.trim();
  return raw ? raw : undefined;
}

/** Is the directive channel configured at all? A server with no token serves no
 *  agent - there is nothing to fall back to, because "no token" cannot mean
 *  "anyone" for a surface whose payloads act on GitHub. */
export function effectChannelConfigured(): boolean {
  return effectAgentToken() !== undefined;
}

/**
 * Constant-time-ish bearer comparison. Length is compared first (an unavoidable
 * leak, and not an interesting one), then every byte, so a wrong token does not
 * reveal its correct prefix through timing.
 */
export function effectAgentTokenMatches(header: string | null | undefined): boolean {
  const expected = effectAgentToken();
  if (!expected) return false;
  const raw = (header ?? "").trim();
  const presented = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** How long a claim is believed without a heartbeat. Long enough for a `gh` call
 *  on a slow network, short enough that a dead agent's work is picked up while
 *  somebody is still watching the demo. */
export const DEFAULT_LEASE_MS = 60_000;

export function leaseMs(): number {
  const raw = Number(process.env.LOOPANY_EFFECT_LEASE_MS?.trim());
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : DEFAULT_LEASE_MS;
}

/**
 * How many leases one directive may burn before it FAILS with `LEASE_EXPIRED`.
 * Bounded for the same reason the outbox bounds attempts: an effect that keeps
 * killing its agent must end up in front of a person, not in a loop.
 */
export const DEFAULT_MAX_CLAIMS = 3;

export function maxClaims(): number {
  const raw = Number(process.env.LOOPANY_EFFECT_MAX_CLAIMS?.trim());
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_CLAIMS;
}

/** Directives handed out in one claim call. Small: an agent that takes ten work
 *  orders and then dies holds ten leases for nothing. */
export const CLAIM_BATCH = 5;
