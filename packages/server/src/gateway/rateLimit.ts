/**
 * In-process rate limiting for the machine routes (`/api/machine/*` + the legacy
 * `/agent-api/loop`, `/machine/report` aliases). There is deliberately no heavy
 * framework: a single-scheduler Loopany deployment runs one process, so an
 * in-memory token bucket per key is the right-sized backstop. It bounds the
 * unauthenticated self-registration / resource-creation surface (audit H-01 / M2)
 * WITHOUT starving a legitimately connected daemon, which short-polls ~every 3s,
 * long-polls ~20s, and bursts a handful of concurrent blob PUTs per sync flush.
 *
 * Two tiers, both fail-closed with a 429 when empty:
 *  - PER-IP (always applied): the primary flood guard. An attacker POSTing a stream
 *    of forged tokens from one address trips this — per-token buckets are useless
 *    against fresh-random tokens, so the IP tier is the real boundary. Sized
 *    generously so many daemons behind one NAT still poll freely.
 *  - PER-TOKEN (applied when a credential is present): per-machine fairness so one
 *    compromised/looping daemon can't monopolize the process; an unknown token in
 *    gated mode never reaches a generous per-credential allowance (enrollment fails
 *    closed under the IP tier).
 *
 * The blob-PUT and sync-POST routes DISABLE the per-token tier (`perToken:false`):
 * a large first sync bursts many concurrent blob PUTs on ONE device token, which
 * would exhaust the modest per-token bucket and 429 legitimate uploads. Those two
 * routes are already bounded by the sync hash-handshake (the server only accepts
 * hashes it asked THIS machine for) plus the per-loop 500MB byte cap, so the
 * per-token tier adds throttle risk with little security gain there. They stay on
 * the PER-IP tier (the real flood boundary); every other machine route keeps both.
 *
 * Keyed maps are bounded (LRU-ish oldest-eviction) so a flood of distinct
 * IPs/tokens can't grow memory without limit. Pure/injectable clock for tests.
 */

/** A refilling token bucket: `capacity` burst, `refillPerSec` sustained rate. */
interface Bucket {
  tokens: number;
  /** Last refill timestamp (ms). Doubles as the LRU recency key for eviction. */
  last: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    /** Cap on distinct keys held — a flood of unique keys evicts the stalest. */
    private readonly maxKeys = 20_000,
  ) {}

  /** Consume one token for `key`. Returns true if allowed, false if the bucket is dry. */
  allow(key: string, now: number = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    }
    // Refill by elapsed time, then spend one.
    const elapsedSec = Math.max(0, (now - b.last) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Drop the least-recently-touched key (bounded memory under a distinct-key flood). */
  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [k, b] of this.buckets) {
      if (b.last < oldest) {
        oldest = b.last;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }

  /** Test seam — forget all state. */
  reset(): void {
    this.buckets.clear();
  }
}

/** Parse a positive-number env override, falling back to `dflt` on absent/invalid. */
function envNum(name: string, dflt: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Per-IP: default 240 burst + 8/sec sustained (≈480 req/min). One daemon does
 * ~20 polls/min plus sync bursts; this comfortably covers a dozen daemons behind a
 * shared NAT while still capping a single-IP flood.
 */
const ipLimiter = new TokenBucketLimiter(
  envNum("LOOPANY_RL_IP_BURST", 240),
  envNum("LOOPANY_RL_IP_PER_SEC", 8),
);

/**
 * Per-token (per-machine): default 120 burst + 4/sec sustained. A single daemon
 * never approaches this; it bounds one credential's share of the process.
 */
const tokenLimiter = new TokenBucketLimiter(
  envNum("LOOPANY_RL_TOKEN_BURST", 120),
  envNum("LOOPANY_RL_TOKEN_PER_SEC", 4),
);

/** Whether rate limiting is active. Off by default in tests unless opted in, so the
 *  large existing suites don't trip it; ON in a real server process. */
function rateLimitEnabled(): boolean {
  // Explicit override wins (either direction).
  const flag = process.env.LOOPANY_RATE_LIMIT?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  // Default: enabled outside the test runner.
  return process.env.NODE_ENV !== "test" && process.env.VITEST !== "true";
}

/**
 * Best-effort client IP from the request, honoring the usual proxy headers (Fly
 * sets `Fly-Client-IP`; a generic proxy sets `X-Forwarded-For`). Falls back to a
 * single shared key so a missing IP still shares ONE bucket (fail-closed: unknown
 * origins can't each get a private allowance). Only the FIRST `X-Forwarded-For` hop
 * is trusted (the client-facing edge appends left-to-right).
 */
export function clientIp(request: Request): string {
  const h = request.headers;
  const fly = h.get("fly-client-ip");
  if (fly) return fly.trim();
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

/** A 429 response with a Retry-After hint, or null when the request is allowed. */
function tooMany(): Response {
  return Response.json(
    { error: "rate limited — slow down" },
    { status: 429, headers: { "retry-after": "1" } },
  );
}

/**
 * Enforce the machine-route rate limits for one request. Call it at the top of a
 * machine route handler, right after reading the Bearer token (pass it so a valid
 * daemon keys off its own per-machine bucket). Returns a 429 `Response` to return
 * verbatim, or null to proceed.
 *
 * `opts.perToken` (default true) gates the per-token tier: the blob-PUT / sync-POST
 * routes pass `false` so a large first sync's burst of concurrent PUTs isn't
 * throttled by the modest per-token bucket (still bounded by the per-IP tier + the
 * sync handshake + the per-loop byte cap). The per-IP tier always applies.
 */
export function machineRouteLimit(
  request: Request,
  token?: string,
  opts: { perToken?: boolean; now?: number } = {},
): Response | null {
  if (!rateLimitEnabled()) return null;
  const now = opts.now ?? Date.now();
  const perToken = opts.perToken ?? true;
  if (!ipLimiter.allow(clientIp(request), now)) return tooMany();
  if (perToken && token && !tokenLimiter.allow(token, now)) return tooMany();
  return null;
}

/** Test seam — reset both limiters between cases. */
export function __resetMachineRateLimiters(): void {
  ipLimiter.reset();
  tokenLimiter.reset();
}
