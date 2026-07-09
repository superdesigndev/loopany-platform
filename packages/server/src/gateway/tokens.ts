/**
 * Machine + run credential helpers. Device tokens (`dk_…`) identify a machine
 * (its id is derived from the token: `m-sha256(token)[:16]`, BYOA §2). A RUN
 * LEASE (`rk_…`) is minted per delivery, bound to one run, and carries the
 * run's least-privilege caps — the CLI dispatch authorizes the `adscaile` shim
 * against it. Its lifecycle is a small state machine (`active` →
 * `terminal-grace` → expired), not a mint→revoke pair; see `RunLease` below.
 *
 * Leases and connect-key bindings are DURABLE (run_leases / connect_keys
 * tables): they must survive a deploy, or every restart 401s the in-flight
 * runs' callbacks/finalize and silently mis-files a post-restart paste into the
 * machine's home team. The short-lived UI correlations (`claimResults`) and the
 * 15-min `new` idempotency window stay in-process (accepted restart gaps —
 * losing one only degrades a dialog wait / a retry dedupe, never data).
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNotNull, lt } from "drizzle-orm";

import { db } from "../db/index.js";
import { connectKeys, runLeases, type CodingAgent, type RunRole } from "../db/schema.js";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Mint a fresh device token (`dk_…`) — the one wire format `machineIdFromToken` consumes. */
export function mintDeviceToken(): string {
  return `dk_${randomBytes(15).toString("hex")}`;
}

/** Derive the stable machine id from its device token. */
export function machineIdFromToken(token: string): string {
  return `m-${sha256(token).slice(0, 16)}`;
}

// ---- connect keys (minted device token → owner + team binding, durable) ----
// A connect-key/claim is minted from a SPECIFIC team's dashboard session; we bind
// the minter and the VALIDATED active team to the key so (a) the daemon's first
// poll self-registers the machine under the minting user, and (b) `createLoop`
// lands the loop in that team — this is what lets ONE machine/daemon serve MANY
// teams. The teamId is captured server-side from the authenticated session (never
// from client input); the gateway re-validates membership at create time (§4).
//
// Durable rows (the Phase-3 Option C upgrade): the old in-memory maps meant a
// deploy between mint and paste silently mis-filed the loop into the machine's
// home team. Keyed by the DERIVED machine id, so the key itself is never stored.
// Not single-read: one paste may create several loops, and the self-register
// seed reads it too.

export interface ClaimIntent {
  /** The user who minted the key (the authenticated dashboard session). */
  userId: string;
  /** The validated active team the key was minted under. */
  teamId: string;
}

/** Keep bindings long enough for a leisurely paste, then drop (bounded table).
 *  Also bounds the self-register owner lookup: a key unused for >24h registers
 *  as shared — strictly better than the old map, which lost it on any restart. */
export const CONNECT_KEY_TTL_MS = 24 * 60 * 60 * 1000;

function connectKeyFresh(mintedAt: string, now: number): boolean {
  return now - Date.parse(mintedAt) <= CONNECT_KEY_TTL_MS;
}

/** Bind a freshly-minted connect-key to its minter (+ team, when the mint came
 *  from a team dashboard session). Prunes expired rows on write. */
export async function rememberConnectKey(connectKey: string, intent: { userId: string; teamId?: string | null }): Promise<void> {
  const now = new Date();
  await db.delete(connectKeys).where(lt(connectKeys.mintedAt, new Date(now.getTime() - CONNECT_KEY_TTL_MS).toISOString()));
  const row = {
    machineId: machineIdFromToken(connectKey),
    userId: intent.userId,
    teamId: intent.teamId ?? null,
    mintedAt: now.toISOString(),
  };
  await db.insert(connectKeys).values(row).onConflictDoUpdate({ target: connectKeys.machineId, set: row });
}

/** Peek (NON-evicting) the team/minter a connect-key was minted under, if still live. */
export async function readClaimIntent(connectKey: string | null | undefined, now: number = Date.now()): Promise<ClaimIntent | undefined> {
  if (!connectKey) return undefined;
  const row = (await db.select().from(connectKeys).where(eq(connectKeys.machineId, machineIdFromToken(connectKey))))[0];
  if (!row || row.teamId == null || !connectKeyFresh(row.mintedAt, now)) return undefined;
  return { userId: row.userId, teamId: row.teamId };
}

/** The remembered owner of a self-registering machine, if any (still-live key). */
export async function getDeviceOwner(machineId: string, now: number = Date.now()): Promise<string | undefined> {
  const row = (await db.select().from(connectKeys).where(eq(connectKeys.machineId, machineId)))[0];
  if (!row || !connectKeyFresh(row.mintedAt, now)) return undefined;
  return row.userId;
}

/** The least-privilege capability set a run lease carries, minted at poll time
 *  from the run's role + the loop's config (see gateway `poll`). Identical to the
 *  fields the old `RunSlot` held — a lease is these caps PLUS a lifecycle state. */
export interface RunLeaseCaps {
  runId: string;
  loopId: string;
  machineId: string;
  role: RunRole;
  allowControl: boolean;
  canSetUi?: boolean;
  canSetSchema?: boolean;
  canSetWorkflow?: boolean;
  /** May THIS run declare the loop's goal met via `adscaile finish`? Minted true
   *  only for an EXEC run on a CLOSED loop (loop.goal != null) — independent of
   *  allowControl (like the structural caps). Evolve/edit runs never get it. */
  canFinish?: boolean;
}

/**
 * A run lease: the per-run credential's caps plus a tiny lifecycle state machine
 * that replaces the old mint→revoke scatter (`revokeRunToken` /
 * `revokeRunTokensForRun` / `markRunTokensReclaimed` / `pruneReclaimedRunTokens`).
 *
 *   active  ──[normal report / finish→enrich / canceled]──▶ retired (deleted)
 *      │
 *      └────[sweep reclaim]──▶ terminal-grace ──[one reconciling report]──▶ retired
 *
 * `terminal-grace` uniquely marks a SWEPT run (the machine went unreachable
 * mid-run, so the sweep finalized a false failure but kept the lease alive). While
 * terminal-grace, agent-api mutations are refused (409); ONLY the single
 * reconciling wake-report is honored, and it retires the lease single-shot. A
 * lease past `expiresAt` is dead — dropped lazily on the next `resolveLease` (so a
 * lease that never gets its wake-report can't be reused) and swept by
 * `pruneExpiredLeases`. `finish` deliberately leaves the lease ACTIVE for one
 * enriching report (the run may still want `show`/a second finish → 400), so it is
 * NOT a terminal-grace transition.
 */
export interface RunLease extends RunLeaseCaps {
  state: "active" | "terminal-grace";
  /** Absolute expiry (ms epoch). `Infinity` while active (a live run never times
   *  out here — the server's inactivity sweep is the vanished-machine guard);
   *  `now + TERMINAL_GRACE_MS` once terminalized. */
  expiresAt: number;
}

/** How long a terminal-grace lease stays alive to accept one late wake-report.
 *  Generous on purpose: a laptop can sleep overnight or across a weekend before the
 *  daemon resumes and delivers the run's real result. (Subsumes the former
 *  `RECLAIM_GRACE_MS`.) */
export const TERMINAL_GRACE_MS = 24 * 60 * 60 * 1000;

/** Leases live in the `run_leases` table, keyed by sha256(full wire token) — so a
 *  deploy is invisible to an in-flight run, a bare-UUID run token minted by a
 *  PRE-Batch-6 server resolves identically to an `rk_`-prefixed one (no prefix
 *  parsing), and a DB leak never hands out live run credentials (hash only). In
 *  rows, `expiresAt` null encodes the active lease's `Infinity`. */
function leaseFromRow(row: typeof runLeases.$inferSelect): RunLease {
  return {
    runId: row.runId,
    loopId: row.loopId,
    machineId: row.machineId,
    role: row.role,
    allowControl: row.allowControl,
    canSetUi: row.canSetUi,
    canSetSchema: row.canSetSchema,
    canSetWorkflow: row.canSetWorkflow,
    canFinish: row.canFinish,
    state: row.state,
    expiresAt: row.expiresAt == null ? Number.POSITIVE_INFINITY : Date.parse(row.expiresAt),
  };
}

/** Mint a fresh run lease and return its wire token (`rk_…`, so the unified CLI
 *  dispatch can tell a run credential from a device `dk_…` in O(1) before any
 *  lookup). Starts `active` with no expiry. */
export async function registerRunLease(caps: RunLeaseCaps): Promise<string> {
  const token = `rk_${randomBytes(16).toString("hex")}`;
  await db.insert(runLeases).values({
    tokenHash: sha256(token),
    runId: caps.runId,
    loopId: caps.loopId,
    machineId: caps.machineId,
    role: caps.role,
    allowControl: caps.allowControl,
    canSetUi: caps.canSetUi ?? false,
    canSetSchema: caps.canSetSchema ?? false,
    canSetWorkflow: caps.canSetWorkflow ?? false,
    canFinish: caps.canFinish ?? false,
    createdAt: new Date().toISOString(),
  });
  return token;
}

/** Resolve a run lease by its wire token, lazily dropping it once past expiry. */
export async function resolveLease(token: string, now: number = Date.now()): Promise<RunLease | undefined> {
  const row = (await db.select().from(runLeases).where(eq(runLeases.tokenHash, sha256(token))))[0];
  if (!row) return undefined;
  const lease = leaseFromRow(row);
  if (now > lease.expiresAt) {
    await db.delete(runLeases).where(eq(runLeases.tokenHash, row.tokenHash));
    return undefined;
  }
  return lease;
}

/** Terminalize the lease(s) for `runId`: flip `active` → `terminal-grace`, opening
 *  the reconcile grace window (`TERMINAL_GRACE_MS`). This is the ONE transition the
 *  sweep uses when it reclaims a stuck run as a false failure — the lease survives
 *  so exactly ONE late wake-report can reconcile the run if the machine was merely
 *  asleep (see gateway `report()`). Idempotent: only an `active` lease flips (a
 *  re-terminalize keeps the first window), and it's a no-op for a run with no lease
 *  (e.g. a still-pending run). */
export async function terminalizeLease(runId: string, now: number = Date.now()): Promise<void> {
  await db
    .update(runLeases)
    .set({ state: "terminal-grace", expiresAt: new Date(now + TERMINAL_GRACE_MS).toISOString() })
    .where(and(eq(runLeases.runId, runId), eq(runLeases.state, "active")));
}

/** Retire a lease immediately (single-shot): the run's server-side lifecycle is
 *  fully consumed — a normal final report, the enriching report after `finish`, the
 *  one reconciling wake-report for a terminal-grace lease, or a canceled-run report.
 *  Deleting is what keeps each of those single-shot (a second report 401s). */
export async function retireLease(token: string): Promise<void> {
  await db.delete(runLeases).where(eq(runLeases.tokenHash, sha256(token)));
}

/** Drop leases whose window has elapsed — bounded table, so a terminal-grace lease
 *  that never gets its wake-report doesn't linger forever. Called from the sweep.
 *  (`active` leases have null expiry and are never pruned here; a vanished
 *  machine's run is reclaimed by the inactivity sweep, which terminalizes it.) */
export async function pruneExpiredLeases(now: number = Date.now()): Promise<void> {
  await db.delete(runLeases).where(and(isNotNull(runLeases.expiresAt), lt(runLeases.expiresAt, new Date(now).toISOString())));
}

// ---- `new` idempotency (content-hash → the loop it created) ----
// `new` is the LONE non-idempotent mutation: every other write overwrites-to-value,
// but a create with no dedupe makes a fresh loop every call, so a timed-out
// `adscaile new` retry silently makes a twin (F8). The daemon derives a stable
// content key (sha256 over the machine id + the canonical config) and sends it; we
// remember which loop that key created for a short window, so a retry with the SAME
// key returns the existing loop instead of a second one. In-memory + TTL-pruned,
// matching the claim-intent/lease posture (a server restart inside the window is an
// accepted gap — the same tradeoff the lease/claim maps already accept). An absent
// key ⇒ no dedupe, so an old daemon (which sends none) keeps the pre-batch-3 behavior.

export interface NewIdempotencyRecord {
  loopId: string;
  /** The machine the key created the loop on — the read guard rechecks it so a
   *  (hypothetical) cross-machine key can never replay another machine's loop. */
  machineId: string;
  /** Record time (ms) — drives the TTL prune so the map stays bounded. */
  at: number;
}

const newIdempotency = new Map<string, NewIdempotencyRecord>();
/** Long enough to swallow a timed-out retry (§8.1 owner decision OQ3), short enough
 *  that two genuinely-different creates of the same config later don't collapse. */
export const NEW_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

function pruneNewIdempotency(now: number): void {
  for (const [key, rec] of newIdempotency) {
    if (now - rec.at > NEW_IDEMPOTENCY_TTL_MS) newIdempotency.delete(key);
  }
}

/** Remember that `key` (from THIS machine) created `loopId`. Pruned on write. */
export function recordNewIdempotency(key: string, machineId: string, loopId: string, now: number = Date.now()): void {
  pruneNewIdempotency(now);
  newIdempotency.set(key, { loopId, machineId, at: now });
}

/** The loop a still-live key already created for THIS machine, or undefined (a miss,
 *  an expired key — dropped here — or a cross-machine record). NON-evicting on a hit:
 *  a genuine retry may arrive more than once within the window. */
export function readNewIdempotency(key: string, machineId: string, now: number = Date.now()): string | undefined {
  const rec = newIdempotency.get(key);
  if (!rec) return undefined;
  if (now - rec.at > NEW_IDEMPOTENCY_TTL_MS) {
    newIdempotency.delete(key);
    return undefined;
  }
  if (rec.machineId !== machineId) return undefined;
  return rec.loopId;
}

// ---- claim tokens (New-loop correlation) ----
// The web mints a claim token and waits on it; Claude Code passes it as `claim`
// when it POSTs the loop, so the web learns which loop was created without
// knowing (or picking) the machine. In-memory: a server restart mid-wait just
// times the dialog out (the loop is still created + visible on the dashboard).

export interface ClaimResult {
  loopId: string;
  name: string;
  machineId: string;
  // The coding agent the daemon MEASURED on the host (env fingerprint) and the
  // server recorded on the loop — surfaced so the New-loop confirmation shows
  // the agent that actually ran `adscaile new`, not a stale dialog pre-selection.
  agent: CodingAgent;
}

const claimResults = new Map<string, ClaimResult>();

export function fulfillClaim(token: string, result: ClaimResult): void {
  claimResults.set(token, result);
}

/** Read-and-consume: the dialog polls until it sees the result once, then closes —
 *  so we evict on first read to keep the map from growing one dead entry per loop. */
export function readClaim(token: string): ClaimResult | undefined {
  const r = claimResults.get(token);
  if (r) claimResults.delete(token);
  return r;
}
