/**
 * Run-lease lifecycle (Batch 6). Exercises the pure lease state machine in
 * `tokens.ts` directly — mint (`rk_` prefix), lazy expiry, the active→terminal-grace
 * terminalize transition, single-shot retire, the prune, and bare-UUID back-compat
 * resolution over a deploy. The gateway-level 409 fencing + reconcile are covered
 * end-to-end by `sleep-reclaim.test.ts` / `index.test.ts`; this pins the primitives.
 */
import { expect, test } from "vitest";

import {
  registerRunLease,
  resolveLease,
  terminalizeLease,
  retireLease,
  pruneExpiredLeases,
  TERMINAL_GRACE_MS,
  type RunLeaseCaps,
} from "./tokens.js";

let seq = 0;
/** A distinct run each call so leases never collide across tests (shared module map). */
function caps(over: Partial<RunLeaseCaps> = {}): RunLeaseCaps {
  seq += 1;
  return { runId: `run-${seq}`, loopId: `loop-${seq}`, machineId: `m-${seq}`, role: "exec", allowControl: true, ...over };
}

test("registerRunLease mints an rk_-prefixed token and an active, non-expiring lease", () => {
  const c = caps();
  const token = registerRunLease(c);
  expect(token.startsWith("rk_")).toBe(true);
  const lease = resolveLease(token);
  expect(lease?.state).toBe("active");
  expect(lease?.expiresAt).toBe(Number.POSITIVE_INFINITY);
  expect(lease?.runId).toBe(c.runId);
  // An active lease never lazily expires, no matter how far the clock advances.
  expect(resolveLease(token, Date.now() + 10 * TERMINAL_GRACE_MS)?.state).toBe("active");
});

test("resolveLease returns undefined for an unknown token", () => {
  expect(resolveLease("rk_does-not-exist")).toBeUndefined();
});

test("terminalizeLease flips active → terminal-grace with a bounded expiry", () => {
  const token = registerRunLease(caps());
  const at = 1_000_000;
  terminalizeLease(resolveLease(token)!.runId, at);
  const lease = resolveLease(token, at)!;
  expect(lease.state).toBe("terminal-grace");
  expect(lease.expiresAt).toBe(at + TERMINAL_GRACE_MS);
});

test("a terminal-grace lease is dropped lazily once past its grace window", () => {
  const token = registerRunLease(caps());
  const at = 2_000_000;
  terminalizeLease(resolveLease(token)!.runId, at);
  // Still resolvable within the window…
  expect(resolveLease(token, at + TERMINAL_GRACE_MS)).toBeTruthy();
  // …gone one ms past it (and the miss deletes it, so a later resolve is undefined too).
  expect(resolveLease(token, at + TERMINAL_GRACE_MS + 1)).toBeUndefined();
  expect(resolveLease(token)).toBeUndefined();
});

test("terminalizeLease is idempotent — a second call keeps the FIRST grace window", () => {
  const token = registerRunLease(caps());
  const runId = resolveLease(token)!.runId;
  terminalizeLease(runId, 5_000_000);
  terminalizeLease(runId, 9_000_000); // must NOT extend the window
  expect(resolveLease(token, 5_000_000)!.expiresAt).toBe(5_000_000 + TERMINAL_GRACE_MS);
});

test("terminalizeLease is a no-op for a runId with no lease (still-pending run)", () => {
  expect(() => terminalizeLease("run-with-no-lease")).not.toThrow();
});

test("retireLease deletes the lease single-shot (a second resolve is undefined)", () => {
  const token = registerRunLease(caps());
  expect(resolveLease(token)).toBeTruthy();
  retireLease(token);
  expect(resolveLease(token)).toBeUndefined();
});

test("pruneExpiredLeases drops only expired leases, keeping active + in-window ones", () => {
  const active = registerRunLease(caps());
  const inWindow = registerRunLease(caps());
  const expired = registerRunLease(caps());
  const now = 3_000_000;
  terminalizeLease(resolveLease(inWindow)!.runId, now);
  terminalizeLease(resolveLease(expired)!.runId, now - 2 * TERMINAL_GRACE_MS);

  pruneExpiredLeases(now);

  expect(resolveLease(active, now)?.state).toBe("active");
  expect(resolveLease(inWindow, now)?.state).toBe("terminal-grace");
  expect(resolveLease(expired, now)).toBeUndefined();
});

test("bare-UUID back-compat: resolveLease keys on the FULL token, doing no prefix parsing", () => {
  // The lease table is keyed by the whole wire token, so resolution needs no `rk_`
  // prefix stripping — the mechanism that lets a PRE-Batch-6 bare-UUID token (minted
  // before the deploy) resolve identically to an `rk_` one. Proof: the token round-
  // trips verbatim (no slicing), and a lookup for a raw non-rk_ string is a plain map
  // miss (undefined), never a throw on an unparseable prefix.
  const token = registerRunLease(caps());
  expect(resolveLease(token)?.runId).toBe(resolveLease(token)?.runId); // verbatim key round-trips
  expect(resolveLease("00000000-0000-0000-0000-000000000000")).toBeUndefined();
});
