/**
 * Machine + run credential helpers. Machine keys (`mk_…`) authenticate a
 * separately identified machine. A RUN
 * LEASE (`rk_…`) is minted per delivery, bound to one run, and carries the
 * run's least-privilege caps — the CLI dispatch authorizes the `loopany` shim
 * against it. Its lifecycle is a small state machine (`active` →
 * `terminal-grace` → expired), not a mint→revoke pair; see `RunLease` below.
 *
 * Leases are durable in run_leases so a deploy does not break in-flight Runs.
 * The short-lived UI correlations (`claimResults`) and the
 * 15-min `new` idempotency window stay in-process (accepted restart gaps —
 * losing one only degrades a dialog wait / a retry dedupe, never data).
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNotNull, lt } from "drizzle-orm";

import { db } from "../db/index.js";
import { runLeases, type CodingAgent, type RunRole } from "../db/schema.js";
import { isCreationStep } from "../lib/creationSteps.js";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Test/backfill alias. New machine credentials are always `mk_`. */
export function mintDeviceToken(): string {
  return mintMachineKey();
}
export function mintMachineKey(): string { return `mk_${randomBytes(24).toString("hex")}`; }

const PRESENTED = "\n";
export function presentedMachineCredential(machineId: string, token: string): string {
  return `${machineId}${PRESENTED}${token}`;
}
export function credentialSecret(value: string): string {
  const at = value.indexOf(PRESENTED);
  return at < 0 ? value : value.slice(at + 1);
}

/** Read the explicit machine id from the presented wire credential. */
export function machineIdFromToken(token: string): string {
  const at = token.indexOf(PRESENTED);
  return at < 0 ? `m-${sha256(token).slice(0, 16)}` : token.slice(0, at);
}

/**
 * Cheap malformed-input filter. Authentication still requires an explicit
 * machine id, row lookup, and constant-time hash comparison.
 */
export function isDeviceTokenShape(token: string): boolean {
  const secret = credentialSecret(token);
  return /^mk_[A-Za-z0-9_-]{16,160}$/.test(secret);
}

/** Transitional dialog correlation only. These values grant no machine or
 * kernel authority and intentionally do not survive a deploy. */
export const CONNECT_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const claimIntents = new Map<string, { userId: string; teamId?: string | null; mintedAt: number }>();
export async function rememberConnectKey(key: string, intent: { userId: string; teamId?: string | null }): Promise<void> {
  claimIntents.set(key, { ...intent, mintedAt: Date.now() });
}
export async function readClaimIntent(key: string | null | undefined, now = Date.now()): Promise<{ userId: string; teamId: string } | undefined> {
  const row = key ? claimIntents.get(key) : undefined;
  return row?.teamId && now - row.mintedAt <= CONNECT_KEY_TTL_MS ? { userId: row.userId, teamId: row.teamId } : undefined;
}
export async function getDeviceOwner(_machineId?: string, _now?: number): Promise<undefined> { return undefined; }

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
  /** KERNEL lease (P0 stage C): the kernel run's team + task. Presence of
   *  kernelTeamId marks the lease as a KERNEL credential — the /api/kernel/cli
   *  bridge resolves scope from it; the production cli router never sees it. */
  kernelTeamId?: string;
  kernelTaskId?: string;
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
    ...(row.kernelTeamId ? { kernelTeamId: row.kernelTeamId } : {}),
    ...(row.kernelTaskId ? { kernelTaskId: row.kernelTaskId } : {}),
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
    kernelTeamId: caps.kernelTeamId ?? null,
    kernelTaskId: caps.kernelTaskId ?? null,
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

/** Retire every lease for `runId` (kernel recovery + kernel run-finish
 *  consummation: those callers hold a runId, not the wire token — the hash-only
 *  table cannot recover the token from a run). */
export async function retireLeasesForRun(runId: string): Promise<void> {
  await db.delete(runLeases).where(eq(runLeases.runId, runId));
}

/** A KERNEL lease row as the recovery scans see it. The lease table doubles as
 *  the kernel CLAIM REGISTER — minted just before the claim commits, deleted at
 *  run-finish/reclaim — so "active kernel leases for machine X" IS the set of
 *  kernel runs machine X is supposed to be executing right now. */
export interface KernelLeaseRow {
  runId: string;
  machineId: string;
  kernelTeamId: string;
  kernelTaskId: string;
  state: "active" | "terminal-grace";
  createdAt: string;
}

/** Every kernel-marked lease, optionally narrowed to one machine. Bounded by
 *  in-flight kernel runs (leases retire at finish), so a full scan stays cheap. */
export async function kernelLeases(machineId?: string): Promise<KernelLeaseRow[]> {
  const cond = machineId
    ? and(isNotNull(runLeases.kernelTeamId), eq(runLeases.machineId, machineId))
    : isNotNull(runLeases.kernelTeamId);
  const rows = await db.select().from(runLeases).where(cond);
  return rows.map((r) => ({
    runId: r.runId,
    machineId: r.machineId,
    kernelTeamId: r.kernelTeamId as string,
    kernelTaskId: r.kernelTaskId as string,
    state: r.state,
    createdAt: r.createdAt,
  }));
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
// `loopany new` retry silently makes a twin (F8). The daemon derives a stable
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

// ── Best-effort creation progress (onboarding wizard live checklist) ──────────
// The coding agent reports creation milestones (fixed enum keys) as it works,
// keyed by the claim token the wizard polls. BEST-EFFORT + NEVER authoritative:
// the loop-created claim result above is the real completion signal. Untrusted
// input — only known enum keys are stored (validated here AND at the wire boundary).
// In-memory, bounded (LRU by recency) + TTL'd, like the other UI correlations.

interface ClaimProgress {
  steps: string[];
  updatedAt: number;
}
const claimProgress = new Map<string, ClaimProgress>();
const CLAIM_PROGRESS_TTL_MS = 30 * 60_000;
const CLAIM_PROGRESS_MAX = 2000;

/** Record one reported milestone against a claim token. Non-enum steps are dropped
 *  (defense-in-depth over the route's own validation); repeats are de-duped. */
export function recordClaimProgress(token: string, step: string): void {
  if (!isCreationStep(step)) return;
  const now = Date.now();
  const cur = claimProgress.get(token) ?? { steps: [], updatedAt: now };
  if (!cur.steps.includes(step)) cur.steps.push(step);
  cur.updatedAt = now;
  // Re-insert so this token becomes the most-recently-used (Map preserves insertion order).
  claimProgress.delete(token);
  claimProgress.set(token, cur);
  // Bound memory: evict the oldest entries once over the cap.
  while (claimProgress.size > CLAIM_PROGRESS_MAX) {
    const oldest = claimProgress.keys().next().value;
    if (oldest === undefined) break;
    claimProgress.delete(oldest);
  }
}

/** The reported milestone keys for a claim (empty if none / expired). */
export function readClaimProgress(token: string): string[] {
  const p = claimProgress.get(token);
  if (!p) return [];
  if (Date.now() - p.updatedAt > CLAIM_PROGRESS_TTL_MS) {
    claimProgress.delete(token);
    return [];
  }
  return p.steps;
}

export function clearClaimProgress(token: string): void {
  claimProgress.delete(token);
}
