/**
 * Data-access layer over Drizzle — replaces c0's file-per-job store. The API is
 * function-style; persistence is relational (loops and runs are separate tables,
 * and `owner: PeerRef` is gone → `userId` + `machineId`).
 *
 * Under Postgres (postgres-js / pglite) the drizzle session is ASYNC, so every
 * DB-touching function returns a Promise. The 5 pure, DB-free helpers stay sync.
 * Using Drizzle (not raw SQL) keeps the dialect swap a swap, not a rewrite.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";

import { db } from "./index.js";
import {
  loops,
  machines,
  runs,
  teams,
  teamMembers,
  notificationChannels,
  blobs,
  artifactFiles,
  runSnapshots,
  runLeases,
  type ArtifactFile,
  type ArtifactMeta,
  type Loop,
  type Machine,
  type NewLoop,
  type NewMachine,
  type NewRun,
  type NotificationChannel,
  type NewNotificationChannel,
  type Run,
  type RunSnapshot,
  type SnapshotManifest,
  type StateField,
  type Team,
} from "./schema.js";

// ---- coercion helpers (carried from c0 store.ts) ----

/** Coerce an untrusted value into clean StateField[]; undefined if empty. */
export function coerceStateSchema(raw: unknown): StateField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StateField[] = [];
  for (const f of raw) {
    if (f && typeof f.key === "string" && f.key.trim()) {
      out.push({
        key: f.key.trim(),
        ...(typeof f.label === "string" && f.label.trim() ? { label: f.label.trim() } : {}),
        ...(typeof f.unit === "string" && f.unit.trim() ? { unit: f.unit.trim() } : {}),
      });
    }
  }
  return out.length ? out : undefined;
}

const UI_MAX_LEN = 20_000;

/** Trim + length-bound a `ui` template (storage guard; render-time sanitizes XSS). */
export function coerceUi(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().slice(0, UI_MAX_LEN);
  return s ? s : undefined;
}

/** Any loop can evolve: the evolve pass bootstraps schema/ui/workflow from run
 *  data, so a plain task loop is a prime candidate (turn repeated work into a
 *  gate, add a dashboard). The "enough data to learn from" throttle lives on the
 *  auto path (`maybeFlagEvolve`'s run-count gate); manual evolve is unrestricted. */
export function canEvolve(_loop: Loop): boolean {
  return true;
}

export function newLoopId(): string {
  return `loop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- loops ----

export async function listLoops(teamId?: string): Promise<Loop[]> {
  const q = db.select().from(loops);
  return teamId ? await q.where(eq(loops.teamId, teamId)) : await q;
}

export async function listEnabledLoops(): Promise<Loop[]> {
  return db.select().from(loops).where(eq(loops.enabled, true));
}

export async function getLoop(id: string): Promise<Loop | undefined> {
  return (await db.select().from(loops).where(eq(loops.id, id)))[0];
}

/** Loops bound to a machine — gates machine deletion (must be empty first). */
export async function loopsForMachine(machineId: string): Promise<Loop[]> {
  return db.select().from(loops).where(eq(loops.machineId, machineId));
}

export async function createLoop(input: Omit<NewLoop, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Loop> {
  const ts = nowIso();
  const row: NewLoop = { ...input, id: input.id ?? newLoopId(), createdAt: ts, updatedAt: ts };
  return (await db.insert(loops).values(row).returning())[0]!;
}

/**
 * Partial update; stamps updatedAt. Returns the fresh row (or undefined if gone).
 *
 * Also enforces the goal / completion lifecycle invariants at the single write
 * chokepoint (so every caller — editLoop, patchJob, the finish verb, reopen —
 * behaves identically):
 *  - clearing the goal (`goal: null`) also clears the completion stamps, keeping
 *    the structural invariant "completedAt != null implies goal != null";
 *  - re-enabling a COMPLETED loop (`enabled: true`) is a REOPEN — drop the terminal
 *    stamps so it resumes as an ordinary active loop. A plain pause (`enabled:
 *    false`) leaves the stamps untouched. An explicit `completedAt` in the same
 *    patch (the finish verb) wins over the reopen clear.
 *
 * Wrapped in a transaction so the completion-state read (does this loop currently
 * carry a `completedAt`?) and the dependent write stay consistent.
 */
export async function updateLoop(id: string, patch: Partial<NewLoop>): Promise<Loop | undefined> {
  return db.transaction(async (tx) => {
    const extra: Partial<NewLoop> = {};
    if (patch.goal === null) {
      extra.completedAt = null;
      extra.completionReason = null;
    }
    if (patch.enabled === true && patch.completedAt === undefined) {
      const current = (await tx.select().from(loops).where(eq(loops.id, id)))[0];
      if (current?.completedAt) {
        extra.completedAt = null;
        extra.completionReason = null;
      }
    }
    await tx
      .update(loops)
      .set({ ...patch, ...extra, updatedAt: nowIso() })
      .where(eq(loops.id, id));
    return (await tx.select().from(loops).where(eq(loops.id, id)))[0];
  });
}

export async function deleteLoop(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(loops).where(eq(loops.id, id)).returning({ id: loops.id });
    if (deleted.length > 0) {
      // Cascade the loop's execution + artifact metadata. Leaving these rows behind
      // would pin their blob hashes in the GC keep-set FOREVER (liveBlobRefs unions
      // every artifact_files hash + every retained snapshot manifest), so a deleted
      // loop's R2 bytes would never be reclaimed. The bytes themselves fall out on
      // the next periodic GC pass once nothing references them.
      await tx.delete(runs).where(eq(runs.loopId, id));
      // A live lease for a deleted loop would otherwise linger forever (active
      // leases have no expiry, so the prune never collects them).
      await tx.delete(runLeases).where(eq(runLeases.loopId, id));
      await tx.delete(artifactFiles).where(eq(artifactFiles.loopId, id));
      await tx.delete(runSnapshots).where(eq(runSnapshots.loopId, id));
    }
    return deleted.length > 0;
  });
}

// ---- runs ----

export async function addRun(input: Omit<NewRun, "id"> & { id?: string }): Promise<Run> {
  const row: NewRun = { ...input, id: input.id ?? randomUUID() };
  return (await db.insert(runs).values(row).returning())[0]!;
}

export async function getRun(id: string): Promise<Run | undefined> {
  return (await db.select().from(runs).where(eq(runs.id, id)))[0];
}

export async function updateRun(id: string, patch: Partial<NewRun>): Promise<Run | undefined> {
  await db.update(runs).set(patch).where(eq(runs.id, id));
  return getRun(id);
}

/** ATOMICALLY claim a PENDING run for delivery (pending -> running, stamping ts).
 *  Conditional on the current phase, so two concurrent claimers can never both win:
 *  the async session opened a read-check -> write window in poll() that the old
 *  sync-SQLite handler never had. Returns the claimed row, or undefined when the
 *  run is gone / already claimed / no longer pending (the caller skips delivery). */
export async function claimPendingRun(id: string): Promise<Run | undefined> {
  return (
    await db
      .update(runs)
      .set({ phase: "running", ts: nowIso() })
      .where(and(eq(runs.id, id), eq(runs.phase, "pending")))
      .returning()
  )[0];
}

/** Newest-last run history for a loop (chronological), capped. */
export async function listRuns(loopId: string, limit = 30): Promise<Run[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(eq(runs.loopId, loopId))
    .orderBy(desc(runs.ts))
    .limit(limit);
  return rows.reverse();
}

/** One older page: runs strictly before `beforeTs`, newest-first then capped,
 *  returned chronological (oldest-first) to match listRuns. Cursor-based (by ts,
 *  not offset) so it's stable while new runs land at the head. */
export async function listRunsBefore(loopId: string, beforeTs: string, limit = 16): Promise<Run[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.loopId, loopId), lt(runs.ts, beforeTs)))
    .orderBy(desc(runs.ts))
    .limit(limit);
  return rows.reverse();
}

export async function lastRun(loopId: string): Promise<Run | undefined> {
  return (await db.select().from(runs).where(eq(runs.loopId, loopId)).orderBy(desc(runs.ts)).limit(1))[0];
}

/** Newest scheduled (exec) run for a loop — the last-outcome anchor that a later
 *  evolve/edit must never mask. Null ⇒ no exec run yet. */
export async function lastExecRun(loopId: string): Promise<Run | undefined> {
  return (
    await db
      .select()
      .from(runs)
      .where(and(eq(runs.loopId, loopId), eq(runs.role, "exec")))
      .orderBy(desc(runs.ts))
      .limit(1)
  )[0];
}

/** Timestamp of this loop's most recent evolve run (any phase) — gates the
 *  once-per-day auto-evolve cap. Null ⇒ never evolved. */
export async function lastEvolveAt(loopId: string): Promise<string | null> {
  const r = (
    await db
      .select({ ts: runs.ts })
      .from(runs)
      .where(and(eq(runs.loopId, loopId), eq(runs.role, "evolve")))
      .orderBy(desc(runs.ts))
      .limit(1)
  )[0];
  return r?.ts ?? null;
}

export async function countRuns(loopId: string): Promise<number> {
  const r = (await db.select({ n: sql<number>`count(*)` }).from(runs).where(eq(runs.loopId, loopId)))[0];
  return Number(r?.n ?? 0);
}

/** Total claude-reported spend across ALL of a loop's runs (one SUM over the
 *  real cost column). Null ⇒ no run has reported a cost yet. */
export async function sumRunCost(loopId: string): Promise<number | null> {
  const r = (
    await db
      .select({ total: sql<number | null>`sum(${runs.costUsd})` })
      .from(runs)
      .where(eq(runs.loopId, loopId))
  )[0];
  // Preserve the real-null (no rows / all null) vs 0 distinction: an empty-set sum
  // is null under pg, which must NOT collapse to 0.
  const total = r?.total ?? null;
  return total == null ? null : Number(total);
}

/**
 * Count consecutive FAILED exec runs ending at the loop's most recent finalized
 * exec run. Drives the failure-alert anti-spam cadence (`shouldNotifyFailure`)
 * entirely from persisted state — no in-memory counter to reset on deploy. Only
 * `exec` runs count: evolve/edit are internal and never produce user-facing
 * failure noise. Canceled / still-open runs are ignored (neither success nor
 * failure), so a user-stopped run doesn't break or extend the streak.
 *
 * EXACT, not a capped scan: one indexed query for the newest successful (done)
 * exec run, then a COUNT of the error exec runs after it. A capped newest-N scan
 * would pin the streak at the cap once a loop failed past it, and the every-Nth
 * "still broken" reminder (streak % FAILURE_NOTIFY_EVERY) would then never fire
 * again — reminders must keep pacing however long the failure streak grows.
 */
export async function execFailureStreak(loopId: string): Promise<number> {
  const lastOk = (
    await db
      .select({ ts: runs.ts })
      .from(runs)
      .where(and(eq(runs.loopId, loopId), eq(runs.role, "exec"), eq(runs.phase, "done")))
      .orderBy(desc(runs.ts))
      .limit(1)
  )[0];
  const conds = [eq(runs.loopId, loopId), eq(runs.role, "exec"), eq(runs.phase, "error")];
  if (lastOk) conds.push(gt(runs.ts, lastOk.ts));
  const r = (await db.select({ n: sql<number>`count(*)` }).from(runs).where(and(...conds)))[0];
  return Number(r?.n ?? 0);
}

/** Open runs (pending/running) — used by the timeout-reclaim sweep. */
export async function openRuns(): Promise<Run[]> {
  return db.select().from(runs).where(inArray(runs.phase, ["pending", "running"]));
}

/** Pending runs queued for ONE machine — the poll's claim query. Hot path (every
 *  poll from every machine), so it stays a targeted indexed lookup
 *  (`runs_phase_idx`; pending rows are always a handful), never an all-open scan. */
export async function pendingRunsForMachine(machineId: string): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.machineId, machineId), eq(runs.phase, "pending")));
}

/** Is a run for this loop still open (drives the "skip overlapping tick" guard)? */
export async function openRunsForLoop(loopId: string): Promise<Run[]> {
  return db.select().from(runs).where(and(eq(runs.loopId, loopId), inArray(runs.phase, ["pending", "running"])));
}

/** Atomically retire a still-PENDING run as superseded (`skipped`): the
 *  phase-guard means a run the daemon claimed in the same instant is left
 *  alone (the caller then backs off — never two agents on one loop). Returns
 *  whether the run was actually superseded. */
export async function supersedePendingRun(runId: string, message: string): Promise<boolean> {
  const updated = await db
    .update(runs)
    .set({ phase: "canceled", outcome: "skipped", message, ts: nowIso() })
    .where(and(eq(runs.id, runId), eq(runs.phase, "pending")))
    .returning({ id: runs.id });
  return updated.length > 0;
}

export async function hasOpenRun(loopId: string): Promise<boolean> {
  const r = (
    await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.loopId, loopId), inArray(runs.phase, ["pending", "running"])))
      .limit(1)
  )[0];
  return !!r;
}

// ---- machines ----

export async function listMachines(teamId?: string): Promise<Machine[]> {
  const q = db.select().from(machines);
  return teamId ? await q.where(eq(machines.teamId, teamId)) : await q;
}

/**
 * Machines usable/visible in a team, MEMBERSHIP-scoped: every machine whose owner
 * belongs to the team (join `machines.userId` → a `team_members` row for this
 * team). One machine therefore appears in every team its owner is a member of —
 * the decoupling that lets a single daemon serve multiple teams (report §2.3).
 * A user has at most one membership row per team, so no machine is duplicated.
 */
export async function listMachinesForTeam(teamId: string): Promise<Machine[]> {
  const rows = await db
    .select({ m: machines })
    .from(machines)
    .innerJoin(teamMembers, eq(machines.userId, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId));
  return rows.map((r) => r.m);
}

export async function getMachine(id: string): Promise<Machine | undefined> {
  return (await db.select().from(machines).where(eq(machines.id, id)))[0];
}

export async function createMachine(input: Omit<NewMachine, "createdAt"> & { id: string }): Promise<Machine> {
  return (await db.insert(machines).values({ ...input, createdAt: nowIso() }).returning())[0]!;
}

export async function updateMachine(id: string, patch: Partial<NewMachine>): Promise<Machine | undefined> {
  await db.update(machines).set(patch).where(eq(machines.id, id));
  return getMachine(id);
}

export async function deleteMachine(id: string): Promise<boolean> {
  const deleted = await db.delete(machines).where(eq(machines.id, id)).returning({ id: machines.id });
  return deleted.length > 0;
}

export async function setMachineOnline(id: string, online: boolean): Promise<void> {
  await db.update(machines).set({ online, lastSeen: nowIso() }).where(eq(machines.id, id));
}

// ---- teams ----

/** Deterministic personal-team id for a user (open mode ⇒ the shared "team-shared"). */
export function teamIdForUser(userId: string | null | undefined): string {
  return `team-${userId ?? "shared"}`;
}

// Per-process memo so the hot path (every requestScope) doesn't re-issue an
// INSERT OR IGNORE once a team is known to exist.
const ensuredTeams = new Set<string>();

/** Idempotently create a team (+ owner membership) if absent, and keep an owned
 *  team's name in sync with `name` (renames pre-existing teams to the current
 *  email-derived default). Memoized ⇒ at most one reconcile per team per process.
 *  The team insert + membership insert + rename are one atomic transaction. */
export async function ensureTeam(id: string, name: string, ownerUserId: string | null): Promise<void> {
  if (ensuredTeams.has(id)) return;
  const ts = nowIso();
  await db.transaction(async (tx) => {
    await tx.insert(teams).values({ id, name, ownerUserId, createdAt: ts }).onConflictDoNothing();
    if (ownerUserId) {
      await tx
        .insert(teamMembers)
        .values({ id: `${id}:${ownerUserId}`, teamId: id, userId: ownerUserId, role: "owner", createdAt: ts })
        .onConflictDoNothing();
      // Rename to the current default when it drifted (no-op once it matches).
      await tx.update(teams).set({ name }).where(and(eq(teams.id, id), ne(teams.name, name)));
    }
  });
  ensuredTeams.add(id);
}

export async function getTeam(id: string): Promise<Team | undefined> {
  return (await db.select().from(teams).where(eq(teams.id, id)))[0];
}

/** Teams the user belongs to (membership join), newest first. Drives the team
 *  switcher — a regular user has just their personal team (no dropdown). */
export async function listTeamsForUser(userId: string): Promise<Team[]> {
  const rows = await db
    .select({ t: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(desc(teams.createdAt));
  return rows.map((r) => r.t);
}

/** Whether the user is a member of the team (authorizes a team-switch request). */
export async function isTeamMember(teamId: string, userId: string): Promise<boolean> {
  return !!(
    await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
  )[0];
}

// ---- notification channels ----

export async function listChannels(teamId: string): Promise<NotificationChannel[]> {
  return db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.teamId, teamId))
    .orderBy(desc(notificationChannels.createdAt));
}

export async function getChannel(id: string): Promise<NotificationChannel | undefined> {
  return (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0];
}

/** The channel a new loop auto-routes to when none is picked — the team's newest
 *  (listChannels is newest-first), or null when the team has none. */
export async function defaultChannelId(teamId: string): Promise<string | null> {
  return (await listChannels(teamId))[0]?.id ?? null;
}

export async function createChannel(input: Omit<NewNotificationChannel, "id" | "createdAt"> & { id?: string }): Promise<NotificationChannel> {
  const row: NewNotificationChannel = {
    ...input,
    id: input.id ?? `ch-${randomUUID().slice(0, 12)}`,
    createdAt: nowIso(),
  };
  return (await db.insert(notificationChannels).values(row).returning())[0]!;
}

export async function deleteChannel(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Detach any loops pointing at it so they fall back to dashboard-only (no dangling ref).
    await tx.update(loops).set({ channelId: null, updatedAt: nowIso() }).where(eq(loops.channelId, id));
    const deleted = await tx
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .returning({ id: notificationChannels.id });
    return deleted.length > 0;
  });
}

// ---- blobs (content-addressed artifact bytes; metadata only — bytes live in R2) ----

/** Does the server already have metadata for this blob hash? (drives needHashes). */
export async function blobExists(hash: string): Promise<boolean> {
  return !!(await db.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.hash, hash)))[0];
}

/** Record a blob's metadata (idempotent — same hash ⇒ same bytes, so a no-op on
 *  conflict). `meta` is the parsed front-matter subset for a non-binary product
 *  (null for binary / unparsed); computed once at ingress and reused on every
 *  content-addressed re-reference (the conflict no-op keeps the first-parsed meta). */
export async function recordBlob(hash: string, size: number, binary: boolean, meta: ArtifactMeta | null = null): Promise<void> {
  await db.insert(blobs).values({ hash, size, binary, meta, createdAt: nowIso() }).onConflictDoNothing();
}

/** Does any LIVE artifact_files row on a loop bound to `machineId` point at `hash`?
 *  Gates putBlob: a device may only upload bytes the sync handshake actually asked
 *  it for (a row a prior sync wrote for one of ITS loops), never arbitrary
 *  self-hashed blobs — otherwise any device token is an uncapped R2 write channel. */
export async function machineReferencesBlob(machineId: string, hash: string): Promise<boolean> {
  return !!(
    await db
      .select({ id: artifactFiles.id })
      .from(artifactFiles)
      .innerJoin(loops, eq(artifactFiles.loopId, loops.id))
      .where(and(eq(loops.machineId, machineId), eq(artifactFiles.hash, hash), eq(artifactFiles.deleted, false)))
      .limit(1)
  )[0];
}

// ---- artifact_files (the current file set of each loop) ----

export interface ArtifactFileInput {
  loopId: string;
  path: string;
  hash: string | null;
  size: number | null;
  binary: boolean;
  oversize: boolean;
  lastRunId: string | null;
}

/** Upsert one live file row (keyed by loopId+path); clears any prior tombstone. */
export async function upsertArtifactFile(input: ArtifactFileInput): Promise<void> {
  const ts = nowIso();
  await db
    .insert(artifactFiles)
    .values({
      id: randomUUID(),
      loopId: input.loopId,
      path: input.path,
      hash: input.hash,
      size: input.size,
      binary: input.binary,
      oversize: input.oversize,
      deleted: false,
      updatedAt: ts,
      lastRunId: input.lastRunId,
    })
    .onConflictDoUpdate({
      target: [artifactFiles.loopId, artifactFiles.path],
      set: {
        hash: input.hash,
        size: input.size,
        binary: input.binary,
        oversize: input.oversize,
        deleted: false,
        updatedAt: ts,
        lastRunId: input.lastRunId,
      },
    });
}

/** Tombstone the paths that vanished from a loop's manifest (keep != in `keepPaths`). */
export async function tombstoneMissingArtifacts(loopId: string, keepPaths: string[], lastRunId: string | null): Promise<number> {
  const keep = new Set(keepPaths);
  const live = await db
    .select()
    .from(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)));
  const ts = nowIso();
  let tombstoned = 0;
  for (const row of live) {
    if (keep.has(row.path)) continue;
    await db
      .update(artifactFiles)
      .set({ hash: null, deleted: true, updatedAt: ts, lastRunId })
      .where(eq(artifactFiles.id, row.id));
    tombstoned++;
  }
  return tombstoned;
}

/** The loop's current (non-deleted) file set, path-sorted. */
export async function listArtifacts(loopId: string): Promise<ArtifactFile[]> {
  return db
    .select()
    .from(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)))
    .orderBy(artifactFiles.path);
}

/** One live artifact row joined with its blob's parsed front-matter meta (null for
 *  a binary / oversize / not-yet-stored / untyped file). Read path only — the list
 *  view surfaces the type/title/date without a per-file blob byte fetch. */
export interface ArtifactFileWithMeta extends ArtifactFile {
  meta: ArtifactMeta | null;
}

/** The loop's current (non-deleted) file set with each file's blob meta joined
 *  out, path-sorted. One indexed join (artifact_files ⋈ blobs on hash), not a
 *  point query per file. */
export async function listArtifactsWithMeta(loopId: string): Promise<ArtifactFileWithMeta[]> {
  const rows = await db
    .select({
      id: artifactFiles.id,
      loopId: artifactFiles.loopId,
      path: artifactFiles.path,
      hash: artifactFiles.hash,
      size: artifactFiles.size,
      binary: artifactFiles.binary,
      oversize: artifactFiles.oversize,
      deleted: artifactFiles.deleted,
      updatedAt: artifactFiles.updatedAt,
      lastRunId: artifactFiles.lastRunId,
      meta: blobs.meta,
    })
    .from(artifactFiles)
    .leftJoin(blobs, eq(artifactFiles.hash, blobs.hash))
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)))
    .orderBy(artifactFiles.path);
  return rows.map((r) => ({ ...r, meta: r.meta ?? null }));
}

/** Every artifact_files row for a loop, including tombstones (Phase 3 diff seam). */
export async function listAllArtifactFiles(loopId: string): Promise<ArtifactFile[]> {
  return db.select().from(artifactFiles).where(eq(artifactFiles.loopId, loopId)).orderBy(artifactFiles.path);
}

/** One file row by loop + path (live or tombstoned). */
export async function getArtifactFile(loopId: string, path: string): Promise<ArtifactFile | undefined> {
  return (
    await db
      .select()
      .from(artifactFiles)
      .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.path, path)))
  )[0];
}

/** The loop's CURRENT live file set as a snapshot manifest (path → metadata) —
 *  what report() captures as the finishing run's end-state. */
export async function buildLoopManifest(loopId: string): Promise<SnapshotManifest> {
  const manifest: SnapshotManifest = {};
  for (const f of await listArtifacts(loopId)) {
    manifest[f.path] = { hash: f.hash, size: f.size, binary: f.binary, oversize: f.oversize };
  }
  return manifest;
}

// ---- run_snapshots (the loop's full manifest at each run boundary; Phase 3 diff) ----

/** Write/overwrite a run's snapshot (path → file metadata). Idempotent on runId
 *  so a re-report of the same run just refreshes the captured end-state. */
export async function putRunSnapshot(runId: string, loopId: string, manifest: SnapshotManifest): Promise<void> {
  await db
    .insert(runSnapshots)
    .values({ runId, loopId, manifest, createdAt: nowIso() })
    .onConflictDoUpdate({ target: runSnapshots.runId, set: { loopId, manifest, createdAt: nowIso() } });
}

/** A run's captured snapshot, or undefined when the run predates the feature. */
export async function getRunSnapshot(runId: string): Promise<RunSnapshot | undefined> {
  return (await db.select().from(runSnapshots).where(eq(runSnapshots.runId, runId)))[0];
}

/** The most recent snapshot for this loop strictly before `beforeTs` (the prior
 *  run's end-state — the diff baseline). Joins run_snapshots to runs for the ts
 *  ordering; undefined when there is no earlier snapshotted run. */
export async function prevRunSnapshot(loopId: string, beforeTs: string): Promise<RunSnapshot | undefined> {
  const row = (
    await db
      .select({ snap: runSnapshots })
      .from(runSnapshots)
      .innerJoin(runs, eq(runSnapshots.runId, runs.id))
      .where(and(eq(runSnapshots.loopId, loopId), lt(runs.ts, beforeTs)))
      .orderBy(desc(runs.ts))
      .limit(1)
  )[0];
  return row?.snap;
}

// ---- retention / GC accounting (see gateway/retention.ts) ----

/**
 * Prune a loop's run snapshots down to the `keep` most recent (by createdAt),
 * deleting the rest. Returns the number deleted. This is what makes an old
 * snapshot's now-unreferenced blobs collectable by the blob GC. `keep <= 0`
 * means "keep none" (still bounded). Safe to call repeatedly (idempotent once
 * at/under the window).
 */
export async function pruneRunSnapshots(loopId: string, keep: number): Promise<number> {
  const survivors = keep > 0
    ? (
        await db
          .select({ runId: runSnapshots.runId })
          .from(runSnapshots)
          .where(eq(runSnapshots.loopId, loopId))
          .orderBy(desc(runSnapshots.createdAt), desc(runSnapshots.runId))
          .limit(keep)
      ).map((r) => r.runId)
    : [];
  // Delete by the loop + NOT-IN-survivors predicate directly, NOT by an inArray of
  // every victim runId: survivors is bounded by `keep` (≤20), so this binds a small,
  // fixed number of variables even when a pre-feature backlog leaves thousands of
  // snapshots to prune in one pass — no "too many SQL variables" on the first prune.
  const pred = survivors.length
    ? and(eq(runSnapshots.loopId, loopId), notInArray(runSnapshots.runId, survivors))
    : eq(runSnapshots.loopId, loopId);
  const deleted = await db.delete(runSnapshots).where(pred).returning({ id: runSnapshots.runId });
  return deleted.length;
}

/** Distinct loop ids that currently have at least one run snapshot. */
export async function loopIdsWithSnapshots(): Promise<string[]> {
  return (
    await db.selectDistinct({ loopId: runSnapshots.loopId }).from(runSnapshots)
  ).map((r) => r.loopId);
}

/**
 * The full set of blob hashes still referenced by a LIVE row — the GC's keep
 * set. A hash is live if ANY artifact_files row points at it (deleted tombstones
 * carry hash=null, so they don't pin a blob) OR ANY retained run_snapshot's
 * manifest references it. Computed in one pass so the GC never deletes a blob a
 * snapshot still needs for its diff.
 */
export async function liveBlobRefs(): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const r of await db
    .selectDistinct({ hash: artifactFiles.hash })
    .from(artifactFiles)
    .where(isNotNull(artifactFiles.hash))) {
    if (r.hash) refs.add(r.hash);
  }
  for (const r of await db.select({ manifest: runSnapshots.manifest }).from(runSnapshots)) {
    for (const entry of Object.values(r.manifest)) {
      if (entry?.hash) refs.add(entry.hash);
    }
  }
  return refs;
}

/** Blob hashes whose metadata row predates `cutoffIso` (GC candidates — the grace
 *  window excludes freshly-written blobs a concurrent sync may be referencing). */
export async function blobHashesOlderThan(cutoffIso: string): Promise<string[]> {
  return (
    await db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(lt(blobs.createdAt, cutoffIso))
  ).map((r) => r.hash);
}

/** Delete a blob's metadata row (the bytes are reclaimed separately via the
 *  BlobStore). Idempotent. */
export async function deleteBlob(hash: string): Promise<void> {
  await db.delete(blobs).where(eq(blobs.hash, hash));
}

/** Indexed point check: does any LIVE artifact_files row still point at this hash?
 *  The GC's cheap, always-fresh per-candidate guard (the common re-reference path) —
 *  uses the artifact_files_hash index, so it stays O(1) even as candidates pile up. */
export async function artifactFileReferencesHash(hash: string): Promise<boolean> {
  return !!(await db.select({ id: artifactFiles.id }).from(artifactFiles).where(eq(artifactFiles.hash, hash)))[0];
}

/** Every blob hash referenced by ANY retained run_snapshot's manifest — the full
 *  snapshot scan deserialized ONCE into a Set so the GC can answer per-candidate
 *  snapshot membership in O(1) instead of re-scanning the whole table per garbage
 *  hash. The GC rebuilds this only when the snapshot row count changes (a report()
 *  raced the pass), so a snapshot that comes to reference a hash mid-pass is still
 *  caught — closing the GC-check-time gap where a snapshot references a hash no live
 *  file row does — without paying O(garbage × snapshots). */
export async function snapshotBlobRefs(): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const r of await db.select({ manifest: runSnapshots.manifest }).from(runSnapshots)) {
    for (const entry of Object.values(r.manifest)) {
      if (entry?.hash) refs.add(entry.hash);
    }
  }
  return refs;
}

/** Count of retained run_snapshot rows — the GC's cheap change-detector for deciding
 *  whether to rebuild its precomputed snapshotBlobRefs() set mid-pass. */
export async function countRunSnapshots(): Promise<number> {
  const r = (await db.select({ n: sql<number>`count(*)` }).from(runSnapshots))[0];
  return Number(r?.n ?? 0);
}

/** Distinct loop ids with a LIVE (non-deleted) file row pointing at this hash.
 *  Drives the per-loop cap re-check at putBlob, where the only loop context is
 *  the artifact_files rows a prior sync already wrote for the requested hash. */
export async function loopsReferencingHash(hash: string): Promise<string[]> {
  return (
    await db
      .selectDistinct({ loopId: artifactFiles.loopId })
      .from(artifactFiles)
      .where(and(eq(artifactFiles.hash, hash), eq(artifactFiles.deleted, false)))
  ).map((r) => r.loopId);
}

/** A loop's live byte footprint EXCLUDING any rows pointing at `hash` — the base
 *  the putBlob cap guard adds the blob's REAL byte length to (the placeholder row
 *  a sync wrote for `hash` carries a client-reported size we must not trust). Sums
 *  the VERIFIED blobs.size where the bytes are stored, falling back to the reported
 *  artifact_files.size only for not-yet-stored (pending) rows, so a daemon that
 *  under-reports sizes can't keep the base artificially low. */
export async function loopStoredBytesExcludingHash(loopId: string, hash: string): Promise<number> {
  const row = (
    await db
      .select({ total: sql<number>`coalesce(sum(coalesce(${blobs.size}, ${artifactFiles.size})), 0)` })
      .from(artifactFiles)
      .leftJoin(blobs, eq(artifactFiles.hash, blobs.hash))
      .where(
        and(
          eq(artifactFiles.loopId, loopId),
          eq(artifactFiles.deleted, false),
          eq(artifactFiles.oversize, false),
          isNotNull(artifactFiles.hash),
          ne(artifactFiles.hash, hash),
        ),
      )
  )[0];
  return Number(row?.total ?? 0);
}

/** Hard-delete a loop's file rows pointing at `hash` — used when putBlob refuses
 *  the bytes (per-loop cap), so nothing dangles pointing at a blob never stored.
 *  Returns the number removed. */
export async function dropArtifactFilesForHash(loopId: string, hash: string): Promise<number> {
  const deleted = await db
    .delete(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.hash, hash)))
    .returning({ id: artifactFiles.id });
  return deleted.length;
}

/** A loop's current live (non-deleted) byte footprint: sum of sizes over files
 *  that actually have bytes stored (hash non-null, not oversize). Prefers the
 *  VERIFIED blobs.size (real length recorded at recordBlob) and only falls back to
 *  the client-reported artifact_files.size for a row whose blob isn't stored yet
 *  (pending), so an under-reporting daemon can't creep past the cap. This is the
 *  figure the per-loop storage cap is enforced against. */
export async function loopStoredBytes(loopId: string): Promise<number> {
  const row = (
    await db
      .select({ total: sql<number>`coalesce(sum(coalesce(${blobs.size}, ${artifactFiles.size})), 0)` })
      .from(artifactFiles)
      .leftJoin(blobs, eq(artifactFiles.hash, blobs.hash))
      .where(
        and(
          eq(artifactFiles.loopId, loopId),
          eq(artifactFiles.deleted, false),
          eq(artifactFiles.oversize, false),
          isNotNull(artifactFiles.hash),
        ),
      )
  )[0];
  return Number(row?.total ?? 0);
}

/** The PER-PATH breakdown of loopStoredBytes: each live, byte-backed file row's
 *  counted size (verified blobs.size, falling back to the client-reported
 *  artifact_files.size for a pending row — the exact per-row basis
 *  loopStoredBytes sums). One query per sync so the overwrite "freed" credit
 *  doesn't cost two point queries per manifest file on the ~1.5s flush path. */
export async function liveArtifactSizes(loopId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ path: artifactFiles.path, size: sql<number | null>`coalesce(${blobs.size}, ${artifactFiles.size})` })
    .from(artifactFiles)
    .leftJoin(blobs, eq(artifactFiles.hash, blobs.hash))
    .where(
      and(
        eq(artifactFiles.loopId, loopId),
        eq(artifactFiles.deleted, false),
        eq(artifactFiles.oversize, false),
        isNotNull(artifactFiles.hash),
      ),
    );
  return new Map(rows.map((r) => [r.path, Number(r.size ?? 0)]));
}
