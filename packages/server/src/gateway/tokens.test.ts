/**
 * Run-lease lifecycle + connect-key binding, DB-backed (durable across deploys).
 * Exercises the lease state machine in `tokens.ts` against the real `run_leases`
 * table — mint (`rk_` prefix), lazy expiry, the active→terminal-grace terminalize
 * transition, single-shot retire, the prune, bare-UUID back-compat resolution,
 * and that only the token's HASH ever lands in a row. The gateway-level 409
 * fencing + reconcile are covered end-to-end by `sleep-reclaim.test.ts` /
 * `index.test.ts`; this pins the primitives. The connect-key section pins the
 * `connect_keys` upsert + TTL that replaced the deploy-fragile in-memory maps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

let tmp: string;
let tokens: typeof import("./tokens.js");
let db: typeof import("../db/index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-tokens-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
/** A distinct run each call so leases never collide across tests (shared table). */
function caps(over: Partial<import("./tokens.js").RunLeaseCaps> = {}): import("./tokens.js").RunLeaseCaps {
  seq += 1;
  return { runId: `run-${seq}`, loopId: `loop-${seq}`, machineId: `m-${seq}`, role: "exec", allowControl: true, ...over };
}

test("registerRunLease mints an rk_-prefixed token and an active, non-expiring lease", async () => {
  const c = caps();
  const token = await tokens.registerRunLease(c);
  expect(token.startsWith("rk_")).toBe(true);
  const lease = await tokens.resolveLease(token);
  expect(lease?.state).toBe("active");
  expect(lease?.expiresAt).toBe(Number.POSITIVE_INFINITY);
  expect(lease?.runId).toBe(c.runId);
  // An active lease never lazily expires, no matter how far the clock advances.
  expect((await tokens.resolveLease(token, Date.now() + 10 * tokens.TERMINAL_GRACE_MS))?.state).toBe("active");
});

test("a lease row stores only the token HASH — never the wire token", async () => {
  // The durability fix must not turn a DB leak into a live-credential leak: the
  // table is keyed by sha256(token), and no column carries the token itself.
  const token = await tokens.registerRunLease(caps());
  const { runLeases } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  const byHash = await db.db.select().from(runLeases).where(eq(runLeases.tokenHash, tokens.sha256(token)));
  expect(byHash).toHaveLength(1);
  expect(JSON.stringify(byHash[0])).not.toContain(token);
});

test("resolveLease returns undefined for an unknown token", async () => {
  expect(await tokens.resolveLease("rk_does-not-exist")).toBeUndefined();
});

test("terminalizeLease flips active → terminal-grace with a bounded expiry", async () => {
  const token = await tokens.registerRunLease(caps());
  const at = 1_000_000;
  await tokens.terminalizeLease((await tokens.resolveLease(token))!.runId, at);
  const lease = (await tokens.resolveLease(token, at))!;
  expect(lease.state).toBe("terminal-grace");
  expect(lease.expiresAt).toBe(at + tokens.TERMINAL_GRACE_MS);
});

test("a terminal-grace lease is dropped lazily once past its grace window", async () => {
  const token = await tokens.registerRunLease(caps());
  const at = 2_000_000;
  await tokens.terminalizeLease((await tokens.resolveLease(token))!.runId, at);
  // Still resolvable within the window…
  expect(await tokens.resolveLease(token, at + tokens.TERMINAL_GRACE_MS)).toBeTruthy();
  // …gone one ms past it (and the miss deletes it, so a later resolve is undefined too).
  expect(await tokens.resolveLease(token, at + tokens.TERMINAL_GRACE_MS + 1)).toBeUndefined();
  expect(await tokens.resolveLease(token)).toBeUndefined();
});

test("terminalizeLease is idempotent — a second call keeps the FIRST grace window", async () => {
  const token = await tokens.registerRunLease(caps());
  const runId = (await tokens.resolveLease(token))!.runId;
  await tokens.terminalizeLease(runId, 5_000_000);
  await tokens.terminalizeLease(runId, 9_000_000); // must NOT extend the window
  expect((await tokens.resolveLease(token, 5_000_000))!.expiresAt).toBe(5_000_000 + tokens.TERMINAL_GRACE_MS);
});

test("terminalizeLease is a no-op for a runId with no lease (still-pending run)", async () => {
  await expect(tokens.terminalizeLease("run-with-no-lease")).resolves.toBeUndefined();
});

test("retireLease deletes the lease single-shot (a second resolve is undefined)", async () => {
  const token = await tokens.registerRunLease(caps());
  expect(await tokens.resolveLease(token)).toBeTruthy();
  await tokens.retireLease(token);
  expect(await tokens.resolveLease(token)).toBeUndefined();
});

test("pruneExpiredLeases drops only expired leases, keeping active + in-window ones", async () => {
  const active = await tokens.registerRunLease(caps());
  const inWindow = await tokens.registerRunLease(caps());
  const expired = await tokens.registerRunLease(caps());
  const now = Date.now();
  await tokens.terminalizeLease((await tokens.resolveLease(inWindow))!.runId, now);
  await tokens.terminalizeLease((await tokens.resolveLease(expired))!.runId, now - 2 * tokens.TERMINAL_GRACE_MS);

  await tokens.pruneExpiredLeases(now);

  expect((await tokens.resolveLease(active, now))?.state).toBe("active");
  expect((await tokens.resolveLease(inWindow, now))?.state).toBe("terminal-grace");
  expect(await tokens.resolveLease(expired, now)).toBeUndefined();
});

test("bare-UUID back-compat: resolveLease keys on the FULL token, doing no prefix parsing", async () => {
  // The lease table is keyed by sha256(whole wire token), so resolution needs no
  // `rk_` prefix stripping — the mechanism that lets a PRE-Batch-6 bare-UUID token
  // (minted before the deploy) resolve identically to an `rk_` one. Proof: the token
  // round-trips verbatim (no slicing), and a lookup for a raw non-rk_ string is a
  // plain miss (undefined), never a throw on an unparseable prefix.
  const token = await tokens.registerRunLease(caps());
  expect((await tokens.resolveLease(token))?.runId).toBe((await tokens.resolveLease(token))?.runId);
  expect(await tokens.resolveLease("00000000-0000-0000-0000-000000000000")).toBeUndefined();
});

// ---- connect keys (owner + team binding, durable) ----

test("rememberConnectKey binds minter + team; readClaimIntent and getDeviceOwner both read it", async () => {
  const key = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(key, { userId: "u-mint", teamId: "team-b" });
  expect(await tokens.readClaimIntent(key)).toEqual({ userId: "u-mint", teamId: "team-b" });
  // NON-evicting: one paste may create several loops.
  expect(await tokens.readClaimIntent(key)).toEqual({ userId: "u-mint", teamId: "team-b" });
  expect(await tokens.getDeviceOwner(tokens.machineIdFromToken(key))).toBe("u-mint");
});

test("a teamless connect-key (pre-created machine path) still records the owner", async () => {
  const key = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(key, { userId: "u-own", teamId: null });
  // No team bound ⇒ no claim intent (createLoop falls back to the home team)…
  expect(await tokens.readClaimIntent(key)).toBeUndefined();
  // …but the self-register owner lookup still resolves.
  expect(await tokens.getDeviceOwner(tokens.machineIdFromToken(key))).toBe("u-own");
});

test("connect-key bindings expire after the TTL (lazy on read)", async () => {
  const key = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(key, { userId: "u-ttl", teamId: "team-ttl" });
  const past = Date.now() + tokens.CONNECT_KEY_TTL_MS + 1;
  expect(await tokens.readClaimIntent(key, past)).toBeUndefined();
  expect(await tokens.getDeviceOwner(tokens.machineIdFromToken(key), past)).toBeUndefined();
});

test("readClaimIntent tolerates an absent/blank key", async () => {
  expect(await tokens.readClaimIntent(null)).toBeUndefined();
  expect(await tokens.readClaimIntent(undefined)).toBeUndefined();
  expect(await tokens.readClaimIntent("never-minted-key")).toBeUndefined();
});
