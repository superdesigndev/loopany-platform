/**
 * Machine-route rate limiting (audit H-01 / M2 — "no rate limiting anywhere").
 * Unit-covers the token bucket + client-IP extraction, then proves the shared
 * per-IP limiter trips a real machine route (poll) with a 429 once its burst is
 * spent. Rate limiting is OFF by default under vitest, so this file opts in via env
 * BEFORE importing the module (the limiters read their sizing at construction).
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Opt in + shrink the per-IP burst so the wiring test needs only a few requests.
// Must be set before importing the module (singletons size themselves at import).
process.env.LOOPANY_RATE_LIMIT = "on";
process.env.LOOPANY_RL_IP_BURST = "3";
process.env.LOOPANY_RL_IP_PER_SEC = "1";

let rl: typeof import("./rateLimit.js");
let PollRoute: any;

beforeAll(async () => {
  rl = await import("./rateLimit.js");
  PollRoute = (await import("../routes/api.machine.poll.js")).Route;
});

afterAll(() => {
  delete process.env.LOOPANY_RATE_LIMIT;
  delete process.env.LOOPANY_RL_IP_BURST;
  delete process.env.LOOPANY_RL_IP_PER_SEC;
});

describe("TokenBucketLimiter", () => {
  test("allows up to capacity, then denies until refill", async () => {
    const { TokenBucketLimiter } = await import("./rateLimit.js");
    const b = new TokenBucketLimiter(2, 1); // 2 burst, 1 token/sec
    const t0 = 1_000_000;
    expect(b.allow("k", t0)).toBe(true);
    expect(b.allow("k", t0)).toBe(true);
    expect(b.allow("k", t0)).toBe(false); // dry
    // One token refills after ~1s.
    expect(b.allow("k", t0 + 1000)).toBe(true);
    expect(b.allow("k", t0 + 1000)).toBe(false);
  });

  test("keys are independent", async () => {
    const { TokenBucketLimiter } = await import("./rateLimit.js");
    const b = new TokenBucketLimiter(1, 1);
    const t = 5_000;
    expect(b.allow("a", t)).toBe(true);
    expect(b.allow("a", t)).toBe(false);
    expect(b.allow("b", t)).toBe(true); // a different key has its own bucket
  });

  test("bounds memory by evicting the stalest key", async () => {
    const { TokenBucketLimiter } = await import("./rateLimit.js");
    const b = new TokenBucketLimiter(1, 1, 2); // hold at most 2 keys
    b.allow("old", 1);
    b.allow("mid", 2);
    b.allow("new", 3); // over cap ⇒ "old" (stalest) evicted
    // "old" was evicted ⇒ it gets a fresh full bucket again.
    expect(b.allow("old", 4)).toBe(true);
  });
});

describe("clientIp", () => {
  test("prefers Fly-Client-IP, then X-Forwarded-For's first hop, then X-Real-IP", async () => {
    const { clientIp } = await import("./rateLimit.js");
    const mk = (h: Record<string, string>) => new Request("http://x/", { headers: h });
    expect(clientIp(mk({ "fly-client-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(mk({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" }))).toBe("3.3.3.3");
    expect(clientIp(mk({ "x-real-ip": "5.5.5.5" }))).toBe("5.5.5.5");
    expect(clientIp(mk({}))).toBe("unknown"); // fail closed: unknown origins share one bucket
  });
});

describe("machineRouteLimit", () => {
  test("returns a 429 Response once the per-IP burst is spent", () => {
    rl.__resetMachineRateLimiters();
    const req = () => new Request("http://x/api/machine/poll", { method: "POST", headers: { "x-forwarded-for": "7.7.7.7" } });
    const now = 2_000_000;
    // Burst 3 ⇒ three allowed, fourth limited (frozen clock ⇒ no refill).
    expect(rl.machineRouteLimit(req(), undefined, { now })).toBeNull();
    expect(rl.machineRouteLimit(req(), undefined, { now })).toBeNull();
    expect(rl.machineRouteLimit(req(), undefined, { now })).toBeNull();
    const limited = rl.machineRouteLimit(req(), undefined, { now });
    expect(limited?.status).toBe(429);
  });

  test("a different IP is unaffected by another IP's exhaustion", () => {
    rl.__resetMachineRateLimiters();
    const now = 3_000_000;
    const from = (ip: string) => new Request("http://x/api/machine/poll", { method: "POST", headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 5; i++) rl.machineRouteLimit(from("8.8.8.8"), undefined, { now });
    expect(rl.machineRouteLimit(from("8.8.8.8"), undefined, { now })?.status).toBe(429);
    expect(rl.machineRouteLimit(from("9.9.9.9"), undefined, { now })).toBeNull(); // fresh bucket
  });

  test("perToken:false skips the per-token tier (blob/sync path) but keeps per-IP", () => {
    rl.__resetMachineRateLimiters();
    const now = 4_000_000;
    // Distinct IP per call so the per-IP tier never trips; only the per-token tier
    // could throttle a shared device token. With perToken:false it never does.
    const from = (ip: string) => new Request("http://x/api/machine/sync", { method: "POST", headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 200; i++) {
      const res = rl.machineRouteLimit(from(`10.0.0.${i}`), "dk_shared", { perToken: false, now });
      expect(res).toBeNull();
    }
    // The SAME shared token WOULD trip the per-token bucket (default 120 burst) when
    // the tier is on — proving the exemption is what let the burst through above.
    let tripped = false;
    for (let i = 0; i < 200; i++) {
      if (rl.machineRouteLimit(from(`11.0.0.${i}`), "dk_shared_on", { now })) {
        tripped = true;
        break;
      }
    }
    expect(tripped).toBe(true);
  });
});

describe("poll route", () => {
  test("returns 429 once the shared per-IP limiter is exhausted", async () => {
    rl.__resetMachineRateLimiters();
    const handler = (PollRoute as any).options.server.handlers.POST as (ctx: { request: Request }) => Promise<Response>;
    const mk = () =>
      new Request("http://localhost/api/machine/poll", {
        method: "POST",
        headers: { authorization: "Bearer dk_ratelimited", "x-forwarded-for": "6.6.6.6", "content-type": "application/json" },
        body: "{}",
      });
    // Drain the shared per-IP bucket directly (no token ⇒ IP tier only), so the
    // route call below finds it empty and short-circuits to 429 BEFORE any boot/DB
    // work. Real clock, but refill over these fast calls is negligible (<1 token).
    for (let i = 0; i < 6; i++) rl.machineRouteLimit(mk(), undefined);
    const res = await handler({ request: mk() });
    expect(res.status).toBe(429);
  });
});
