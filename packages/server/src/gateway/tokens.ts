/**
 * Machine + run credential helpers. Device tokens (`dk_…`) identify a machine
 * (its id is derived from the token: `m-sha256(token)[:16]`, BYOA §2). A RUN
 * LEASE (`rk_…`) is minted per delivery, bound to one run, held in-process, and
 * carries the run's least-privilege caps — the CLI dispatch authorizes the
 * `loopany` shim against it. Its lifecycle is a small state machine (`active` →
 * `terminal-grace` → expired), not a mint→revoke pair; see `RunLease` below.
 */
import { createHash, randomBytes } from "node:crypto";

import type { CodingAgent, RunRole } from "../db/schema.js";

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

// ---- device-token ownership (for the self-register path) ----
// When the gate is on, a freshly-minted device token belongs to the user who
// minted it. createMachine persists that on the row directly; the AI-First
// claim path mints a bare token (no row), so we remember the owner here until
// the daemon's first poll self-registers the machine under it. In-memory: a
// restart before that first poll just falls back to a shared (unowned) machine.
const deviceOwners = new Map<string, string>();

/** Record the owner of a device token (keyed by its derived machine id). */
export function setDeviceOwner(machineId: string, userId: string): void {
  deviceOwners.set(machineId, userId);
}

/** The remembered owner of a self-registering machine, if any. */
export function getDeviceOwner(machineId: string): string | undefined {
  return deviceOwners.get(machineId);
}

// ---- claim intent (per-team connect-key → the team it was minted under) ----
// A connect-key/claim is minted from a SPECIFIC team's dashboard session; we bind
// the VALIDATED active team (+ minter) to the key here so `createLoop` can land the
// loop in that team — this is what lets ONE machine/daemon serve MANY teams. The
// teamId is captured server-side from the authenticated session (never from client
// input); the gateway re-validates membership at create time (report §4).
//
// In-memory (Phase 1 / decision Option A) — matches `deviceOwners`/`claimResults`.
// A server restart drops pending intents (a snippet pasted afterward falls back to
// the machine's home team, exactly like a timed-out claim today). The intended
// Phase-3 upgrade is a durable `connect_keys` table (Option C). Not single-read:
// one paste may create several loops, and the self-register seed reads it too.

export interface ClaimIntent {
  /** The user who minted the key (the authenticated dashboard session). */
  userId: string;
  /** The validated active team the key was minted under. */
  teamId: string;
  /** Mint time (ms) — drives the TTL prune so the map stays bounded. */
  at: number;
}

const claimIntents = new Map<string, ClaimIntent>();
/** Keep intents long enough for a leisurely paste, then drop (bounded memory). */
const CLAIM_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

function pruneClaimIntents(now: number): void {
  for (const [key, intent] of claimIntents) {
    if (now - intent.at > CLAIM_INTENT_TTL_MS) claimIntents.delete(key);
  }
}

/** Bind a freshly-minted connect-key to the team (+ minter) it was minted under. */
export function rememberClaimIntent(connectKey: string, intent: { userId: string; teamId: string }): void {
  const now = Date.now();
  pruneClaimIntents(now);
  claimIntents.set(connectKey, { userId: intent.userId, teamId: intent.teamId, at: now });
}

/** Peek (NON-evicting) the team/minter a connect-key was minted under, if still live. */
export function readClaimIntent(connectKey: string | null | undefined): ClaimIntent | undefined {
  if (!connectKey) return undefined;
  const intent = claimIntents.get(connectKey);
  if (!intent) return undefined;
  if (Date.now() - intent.at > CLAIM_INTENT_TTL_MS) {
    claimIntents.delete(connectKey);
    return undefined;
  }
  return intent;
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
  /** May THIS run declare the loop's goal met via `loopany finish`? Minted true
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

/** In-process lease table, keyed by the FULL wire token. Keying on the full string
 *  means a bare-UUID run token minted by a PRE-Batch-6 server resolves identically
 *  to an `rk_`-prefixed one — no prefix parsing, so back-compat over a deploy is
 *  free (`resolveLease` just misses the `rk_` shape and reads the raw key). */
const leases = new Map<string, RunLease>();

/** Mint a fresh run lease and return its wire token (`rk_…`, so the unified CLI
 *  dispatch can tell a run credential from a device `dk_…` in O(1) before any map
 *  lookup). Starts `active` with no expiry. */
export function registerRunLease(caps: RunLeaseCaps): string {
  const token = `rk_${randomBytes(16).toString("hex")}`;
  leases.set(token, { ...caps, state: "active", expiresAt: Number.POSITIVE_INFINITY });
  return token;
}

/** Resolve a run lease by its wire token, lazily dropping it once past expiry.
 *  Accepts both `rk_`-prefixed leases and bare-UUID tokens from a pre-Batch-6
 *  mint (the map is keyed by the full token, so no prefix stripping is needed). */
export function resolveLease(token: string, now: number = Date.now()): RunLease | undefined {
  const lease = leases.get(token);
  if (!lease) return undefined;
  if (now > lease.expiresAt) {
    leases.delete(token);
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
export function terminalizeLease(runId: string, now: number = Date.now()): void {
  for (const lease of leases.values()) {
    if (lease.runId === runId && lease.state === "active") {
      lease.state = "terminal-grace";
      lease.expiresAt = now + TERMINAL_GRACE_MS;
    }
  }
}

/** Retire a lease immediately (single-shot): the run's server-side lifecycle is
 *  fully consumed — a normal final report, the enriching report after `finish`, the
 *  one reconciling wake-report for a terminal-grace lease, or a canceled-run report.
 *  Deleting is what keeps each of those single-shot (a second report 401s). */
export function retireLease(token: string): void {
  leases.delete(token);
}

/** Drop leases whose window has elapsed — bounded memory, so a terminal-grace lease
 *  that never gets its wake-report doesn't linger forever. Called from the sweep.
 *  (`active` leases have `Infinity` expiry and are never pruned here; a vanished
 *  machine's run is reclaimed by the inactivity sweep, which terminalizes it.) */
export function pruneExpiredLeases(now: number = Date.now()): void {
  for (const [token, lease] of leases) {
    if (now > lease.expiresAt) leases.delete(token);
  }
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
  // the agent that actually ran `loopany new`, not a stale dialog pre-selection.
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
