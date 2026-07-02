/**
 * Machine + run token helpers. Device tokens identify a machine (its id is
 * derived from the token: `m-sha256(token)[:16]`, BYOA §2). Run tokens are
 * minted per delivery, bound to one run, held in-process, and revoked when the
 * run finishes — the agent-api authorizes the `loopany` shim against them.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

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

export interface RunSlot {
  runId: string;
  loopId: string;
  machineId: string;
  role: RunRole;
  allowControl: boolean;
  canSetUi?: boolean;
  canSetSchema?: boolean;
  canSetWorkflow?: boolean;
}

const slots = new Map<string, RunSlot>();

export function registerRunToken(slot: RunSlot): string {
  const token = randomUUID();
  slots.set(token, slot);
  return token;
}

export function resolveRunToken(token: string): RunSlot | undefined {
  return slots.get(token);
}

export function revokeRunToken(token: string): void {
  slots.delete(token);
}

/** Revoke every run token minted for `runId`. The sweep finalizes stuck runs by
 *  id (it never held the token string), and a swept run's token must die with it
 *  or the orphaned agent keeps a valid agent-api credential indefinitely. The
 *  slots map holds one entry per in-flight run, so a scan is fine. */
export function revokeRunTokensForRun(runId: string): void {
  for (const [token, slot] of slots) {
    if (slot.runId === runId) slots.delete(token);
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
