/**
 * Data-access layer over Drizzle — replaces c0's file-per-job store. Keeps the
 * synchronous, function-style API c0's scheduler expects (better-sqlite3 is
 * synchronous), but persistence is now relational: loops and runs are separate
 * tables, and `owner: PeerRef` is gone (→ `userId` + `machineId`).
 *
 * Using Drizzle (not raw SQL) keeps a future Supabase/Postgres switch a dialect
 * swap, not a rewrite.
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
import { user } from "./auth-schema.js";

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

export function listLoops(teamId?: string): Loop[] {
  const q = db.select().from(loops);
  return (teamId ? q.where(eq(loops.teamId, teamId)) : q).all();
}

export function listEnabledLoops(): Loop[] {
  return db.select().from(loops).where(eq(loops.enabled, true)).all();
}

export function getLoop(id: string): Loop | undefined {
  return db.select().from(loops).where(eq(loops.id, id)).get();
}

/** Loops bound to a machine — gates machine deletion (must be empty first). */
export function loopsForMachine(machineId: string): Loop[] {
  return db.select().from(loops).where(eq(loops.machineId, machineId)).all();
}

export function createLoop(input: Omit<NewLoop, "id" | "createdAt" | "updatedAt"> & { id?: string }): Loop {
  const ts = nowIso();
  const row: NewLoop = { ...input, id: input.id ?? newLoopId(), createdAt: ts, updatedAt: ts };
  return db.insert(loops).values(row).returning().get();
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
 */
export function updateLoop(id: string, patch: Partial<NewLoop>): Loop | undefined {
  const extra: Partial<NewLoop> = {};
  if (patch.goal === null) {
    extra.completedAt = null;
    extra.completionReason = null;
  }
  if (patch.enabled === true && patch.completedAt === undefined && getLoop(id)?.completedAt) {
    extra.completedAt = null;
    extra.completionReason = null;
  }
  db.update(loops)
    .set({ ...patch, ...extra, updatedAt: nowIso() })
    .where(eq(loops.id, id))
    .run();
  return getLoop(id);
}

export function deleteLoop(id: string): boolean {
  const r = db.delete(loops).where(eq(loops.id, id)).run();
  if (r.changes > 0) {
    // Cascade the loop's execution + artifact metadata. Leaving these rows behind
    // would pin their blob hashes in the GC keep-set FOREVER (liveBlobRefs unions
    // every artifact_files hash + every retained snapshot manifest), so a deleted
    // loop's R2 bytes would never be reclaimed. The bytes themselves fall out on
    // the next periodic GC pass once nothing references them.
    db.delete(runs).where(eq(runs.loopId, id)).run();
    db.delete(artifactFiles).where(eq(artifactFiles.loopId, id)).run();
    db.delete(runSnapshots).where(eq(runSnapshots.loopId, id)).run();
  }
  return r.changes > 0;
}

// ---- runs ----

export function addRun(input: Omit<NewRun, "id"> & { id?: string }): Run {
  const row: NewRun = { ...input, id: input.id ?? randomUUID() };
  return db.insert(runs).values(row).returning().get();
}

export function getRun(id: string): Run | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

export function updateRun(id: string, patch: Partial<NewRun>): Run | undefined {
  db.update(runs).set(patch).where(eq(runs.id, id)).run();
  return getRun(id);
}

/** Newest-last run history for a loop (chronological), capped. */
export function listRuns(loopId: string, limit = 30): Run[] {
  const rows = db
    .select()
    .from(runs)
    .where(eq(runs.loopId, loopId))
    .orderBy(desc(runs.ts))
    .limit(limit)
    .all();
  return rows.reverse();
}

/** One older page: runs strictly before `beforeTs`, newest-first then capped,
 *  returned chronological (oldest-first) to match listRuns. Cursor-based (by ts,
 *  not offset) so it's stable while new runs land at the head. */
export function listRunsBefore(loopId: string, beforeTs: string, limit = 16): Run[] {
  const rows = db
    .select()
    .from(runs)
    .where(and(eq(runs.loopId, loopId), lt(runs.ts, beforeTs)))
    .orderBy(desc(runs.ts))
    .limit(limit)
    .all();
  return rows.reverse();
}

export function lastRun(loopId: string): Run | undefined {
  return db.select().from(runs).where(eq(runs.loopId, loopId)).orderBy(desc(runs.ts)).limit(1).get();
}

/** Newest scheduled (exec) run for a loop — the last-outcome anchor that a later
 *  evolve/edit must never mask. Null ⇒ no exec run yet. */
export function lastExecRun(loopId: string): Run | undefined {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.loopId, loopId), eq(runs.role, "exec")))
    .orderBy(desc(runs.ts))
    .limit(1)
    .get();
}

/** Timestamp of this loop's most recent evolve run (any phase) — gates the
 *  once-per-day auto-evolve cap. Null ⇒ never evolved. */
export function lastEvolveAt(loopId: string): string | null {
  const r = db
    .select({ ts: runs.ts })
    .from(runs)
    .where(and(eq(runs.loopId, loopId), eq(runs.role, "evolve")))
    .orderBy(desc(runs.ts))
    .limit(1)
    .get();
  return r?.ts ?? null;
}

export function countRuns(loopId: string): number {
  const r = db.select({ n: sql<number>`count(*)` }).from(runs).where(eq(runs.loopId, loopId)).get();
  return r?.n ?? 0;
}

/** Total claude-reported spend across ALL of a loop's runs (one SUM over the
 *  real cost column). Null ⇒ no run has reported a cost yet. */
export function sumRunCost(loopId: string): number | null {
  const r = db
    .select({ total: sql<number | null>`sum(${runs.costUsd})` })
    .from(runs)
    .where(eq(runs.loopId, loopId))
    .get();
  return r?.total ?? null;
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
export function execFailureStreak(loopId: string): number {
  const lastOk = db
    .select({ ts: runs.ts })
    .from(runs)
    .where(and(eq(runs.loopId, loopId), eq(runs.role, "exec"), eq(runs.phase, "done")))
    .orderBy(desc(runs.ts))
    .limit(1)
    .get();
  const conds = [eq(runs.loopId, loopId), eq(runs.role, "exec"), eq(runs.phase, "error")];
  if (lastOk) conds.push(gt(runs.ts, lastOk.ts));
  const r = db.select({ n: sql<number>`count(*)` }).from(runs).where(and(...conds)).get();
  return r?.n ?? 0;
}

/** Open runs (pending/running) — used by the timeout-reclaim sweep. */
export function openRuns(): Run[] {
  return db.select().from(runs).where(inArray(runs.phase, ["pending", "running"])).all();
}

/** Is a run for this loop still open (drives the "skip overlapping tick" guard)? */
export function hasOpenRun(loopId: string): boolean {
  const r = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.loopId, loopId), inArray(runs.phase, ["pending", "running"])))
    .limit(1)
    .get();
  return !!r;
}

// ---- machines ----

export function listMachines(teamId?: string): Machine[] {
  const q = db.select().from(machines);
  return (teamId ? q.where(eq(machines.teamId, teamId)) : q).all();
}

/**
 * Machines usable/visible in a team, MEMBERSHIP-scoped: every machine whose owner
 * belongs to the team (join `machines.userId` → a `team_members` row for this
 * team). One machine therefore appears in every team its owner is a member of —
 * the decoupling that lets a single daemon serve multiple teams (report §2.3).
 * A user has at most one membership row per team, so no machine is duplicated.
 */
export function listMachinesForTeam(teamId: string): Machine[] {
  return db
    .select({ m: machines })
    .from(machines)
    .innerJoin(teamMembers, eq(machines.userId, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .all()
    .map((r) => r.m);
}

export function getMachine(id: string): Machine | undefined {
  return db.select().from(machines).where(eq(machines.id, id)).get();
}

export function createMachine(input: Omit<NewMachine, "createdAt"> & { id: string }): Machine {
  return db.insert(machines).values({ ...input, createdAt: nowIso() }).returning().get();
}

export function updateMachine(id: string, patch: Partial<NewMachine>): Machine | undefined {
  db.update(machines).set(patch).where(eq(machines.id, id)).run();
  return getMachine(id);
}

export function deleteMachine(id: string): boolean {
  const r = db.delete(machines).where(eq(machines.id, id)).run();
  return r.changes > 0;
}

export function setMachineOnline(id: string, online: boolean): void {
  db.update(machines).set({ online, lastSeen: nowIso() }).where(eq(machines.id, id)).run();
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
 *  email-derived default). Memoized ⇒ at most one reconcile per team per process. */
export function ensureTeam(id: string, name: string, ownerUserId: string | null): void {
  if (ensuredTeams.has(id)) return;
  const ts = nowIso();
  db.insert(teams).values({ id, name, ownerUserId, createdAt: ts }).onConflictDoNothing().run();
  if (ownerUserId) {
    db.insert(teamMembers)
      .values({ id: `${id}:${ownerUserId}`, teamId: id, userId: ownerUserId, role: "owner", createdAt: ts })
      .onConflictDoNothing()
      .run();
    // Rename to the current default when it drifted (no-op once it matches).
    db.update(teams).set({ name }).where(and(eq(teams.id, id), ne(teams.name, name))).run();
  }
  ensuredTeams.add(id);
}

export function getTeam(id: string): Team | undefined {
  return db.select().from(teams).where(eq(teams.id, id)).get();
}

/** Teams the user belongs to (membership join), newest first. Drives the team
 *  switcher — a regular user has just their personal team (no dropdown). */
export function listTeamsForUser(userId: string): Team[] {
  return db
    .select({ t: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(desc(teams.createdAt))
    .all()
    .map((r) => r.t);
}

/** Every team — superadmin-only cross-team visibility. */
export function listAllTeams(): Team[] {
  return db.select().from(teams).orderBy(desc(teams.createdAt)).all();
}

/** A user's email (Better Auth `user` row), or null. Used by the gateway to
 *  re-check superadmin authorization at loop-create time without an auth import. */
export function userEmail(userId: string): string | null {
  return db.select({ email: user.email }).from(user).where(eq(user.id, userId)).get()?.email ?? null;
}

/** Whether the user is a member of the team (authorizes a team-switch request). */
export function isTeamMember(teamId: string, userId: string): boolean {
  return !!db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
}

// ---- notification channels ----

export function listChannels(teamId: string): NotificationChannel[] {
  return db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.teamId, teamId))
    .orderBy(desc(notificationChannels.createdAt))
    .all();
}

export function getChannel(id: string): NotificationChannel | undefined {
  return db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
}

/** The channel a new loop auto-routes to when none is picked — the team's newest
 *  (listChannels is newest-first), or null when the team has none. */
export function defaultChannelId(teamId: string): string | null {
  return listChannels(teamId)[0]?.id ?? null;
}

export function createChannel(input: Omit<NewNotificationChannel, "id" | "createdAt"> & { id?: string }): NotificationChannel {
  const row: NewNotificationChannel = {
    ...input,
    id: input.id ?? `ch-${randomUUID().slice(0, 12)}`,
    createdAt: nowIso(),
  };
  return db.insert(notificationChannels).values(row).returning().get();
}

export function deleteChannel(id: string): boolean {
  // Detach any loops pointing at it so they fall back to dashboard-only (no dangling ref).
  db.update(loops).set({ channelId: null, updatedAt: nowIso() }).where(eq(loops.channelId, id)).run();
  const r = db.delete(notificationChannels).where(eq(notificationChannels.id, id)).run();
  return r.changes > 0;
}

// ---- blobs (content-addressed artifact bytes; metadata only — bytes live in R2) ----

/** Does the server already have metadata for this blob hash? (drives needHashes). */
export function blobExists(hash: string): boolean {
  return !!db.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.hash, hash)).get();
}

/** Record a blob's metadata (idempotent — same hash ⇒ same bytes, so a no-op on
 *  conflict). `meta` is the parsed front-matter subset for a non-binary product
 *  (null for binary / unparsed); computed once at ingress and reused on every
 *  content-addressed re-reference (the conflict no-op keeps the first-parsed meta). */
export function recordBlob(hash: string, size: number, binary: boolean, meta: ArtifactMeta | null = null): void {
  db.insert(blobs).values({ hash, size, binary, meta, createdAt: nowIso() }).onConflictDoNothing().run();
}

/** Does any LIVE artifact_files row on a loop bound to `machineId` point at `hash`?
 *  Gates putBlob: a device may only upload bytes the sync handshake actually asked
 *  it for (a row a prior sync wrote for one of ITS loops), never arbitrary
 *  self-hashed blobs — otherwise any device token is an uncapped R2 write channel. */
export function machineReferencesBlob(machineId: string, hash: string): boolean {
  return !!db
    .select({ id: artifactFiles.id })
    .from(artifactFiles)
    .innerJoin(loops, eq(artifactFiles.loopId, loops.id))
    .where(and(eq(loops.machineId, machineId), eq(artifactFiles.hash, hash), eq(artifactFiles.deleted, false)))
    .limit(1)
    .get();
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
export function upsertArtifactFile(input: ArtifactFileInput): void {
  const ts = nowIso();
  db.insert(artifactFiles)
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
    })
    .run();
}

/** Tombstone the paths that vanished from a loop's manifest (keep != in `keepPaths`). */
export function tombstoneMissingArtifacts(loopId: string, keepPaths: string[], lastRunId: string | null): number {
  const keep = new Set(keepPaths);
  const live = db
    .select()
    .from(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)))
    .all();
  const ts = nowIso();
  let tombstoned = 0;
  for (const row of live) {
    if (keep.has(row.path)) continue;
    db.update(artifactFiles)
      .set({ hash: null, deleted: true, updatedAt: ts, lastRunId })
      .where(eq(artifactFiles.id, row.id))
      .run();
    tombstoned++;
  }
  return tombstoned;
}

/** The loop's current (non-deleted) file set, path-sorted. */
export function listArtifacts(loopId: string): ArtifactFile[] {
  return db
    .select()
    .from(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)))
    .orderBy(artifactFiles.path)
    .all();
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
export function listArtifactsWithMeta(loopId: string): ArtifactFileWithMeta[] {
  return db
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
    .orderBy(artifactFiles.path)
    .all()
    .map((r) => ({ ...r, meta: r.meta ?? null }));
}

/** Every artifact_files row for a loop, including tombstones (Phase 3 diff seam). */
export function listAllArtifactFiles(loopId: string): ArtifactFile[] {
  return db.select().from(artifactFiles).where(eq(artifactFiles.loopId, loopId)).orderBy(artifactFiles.path).all();
}

/** One file row by loop + path (live or tombstoned). */
export function getArtifactFile(loopId: string, path: string): ArtifactFile | undefined {
  return db
    .select()
    .from(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.path, path)))
    .get();
}

/** The loop's CURRENT live file set as a snapshot manifest (path → metadata) —
 *  what report() captures as the finishing run's end-state. */
export function buildLoopManifest(loopId: string): SnapshotManifest {
  const manifest: SnapshotManifest = {};
  for (const f of listArtifacts(loopId)) {
    manifest[f.path] = { hash: f.hash, size: f.size, binary: f.binary, oversize: f.oversize };
  }
  return manifest;
}

// ---- run_snapshots (the loop's full manifest at each run boundary; Phase 3 diff) ----

/** Write/overwrite a run's snapshot (path → file metadata). Idempotent on runId
 *  so a re-report of the same run just refreshes the captured end-state. */
export function putRunSnapshot(runId: string, loopId: string, manifest: SnapshotManifest): void {
  db.insert(runSnapshots)
    .values({ runId, loopId, manifest, createdAt: nowIso() })
    .onConflictDoUpdate({ target: runSnapshots.runId, set: { loopId, manifest, createdAt: nowIso() } })
    .run();
}

/** A run's captured snapshot, or undefined when the run predates the feature. */
export function getRunSnapshot(runId: string): RunSnapshot | undefined {
  return db.select().from(runSnapshots).where(eq(runSnapshots.runId, runId)).get();
}

/** The most recent snapshot for this loop strictly before `beforeTs` (the prior
 *  run's end-state — the diff baseline). Joins run_snapshots to runs for the ts
 *  ordering; undefined when there is no earlier snapshotted run. */
export function prevRunSnapshot(loopId: string, beforeTs: string): RunSnapshot | undefined {
  const row = db
    .select({ snap: runSnapshots })
    .from(runSnapshots)
    .innerJoin(runs, eq(runSnapshots.runId, runs.id))
    .where(and(eq(runSnapshots.loopId, loopId), lt(runs.ts, beforeTs)))
    .orderBy(desc(runs.ts))
    .limit(1)
    .get();
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
export function pruneRunSnapshots(loopId: string, keep: number): number {
  const survivors = keep > 0
    ? db
        .select({ runId: runSnapshots.runId })
        .from(runSnapshots)
        .where(eq(runSnapshots.loopId, loopId))
        .orderBy(desc(runSnapshots.createdAt), desc(runSnapshots.runId))
        .limit(keep)
        .all()
        .map((r) => r.runId)
    : [];
  // Delete by the loop + NOT-IN-survivors predicate directly, NOT by an inArray of
  // every victim runId: survivors is bounded by `keep` (≤20), so this binds a small,
  // fixed number of variables even when a pre-feature backlog leaves thousands of
  // snapshots to prune in one pass — no "too many SQL variables" on the first prune.
  const pred = survivors.length
    ? and(eq(runSnapshots.loopId, loopId), notInArray(runSnapshots.runId, survivors))
    : eq(runSnapshots.loopId, loopId);
  const r = db.delete(runSnapshots).where(pred).run();
  return r.changes;
}

/** Distinct loop ids that currently have at least one run snapshot. */
export function loopIdsWithSnapshots(): string[] {
  return db
    .selectDistinct({ loopId: runSnapshots.loopId })
    .from(runSnapshots)
    .all()
    .map((r) => r.loopId);
}

/**
 * The full set of blob hashes still referenced by a LIVE row — the GC's keep
 * set. A hash is live if ANY artifact_files row points at it (deleted tombstones
 * carry hash=null, so they don't pin a blob) OR ANY retained run_snapshot's
 * manifest references it. Computed in one pass so the GC never deletes a blob a
 * snapshot still needs for its diff.
 */
export function liveBlobRefs(): Set<string> {
  const refs = new Set<string>();
  for (const r of db
    .selectDistinct({ hash: artifactFiles.hash })
    .from(artifactFiles)
    .where(isNotNull(artifactFiles.hash))
    .all()) {
    if (r.hash) refs.add(r.hash);
  }
  for (const r of db.select({ manifest: runSnapshots.manifest }).from(runSnapshots).all()) {
    for (const entry of Object.values(r.manifest)) {
      if (entry?.hash) refs.add(entry.hash);
    }
  }
  return refs;
}

/** Blob hashes whose metadata row predates `cutoffIso` (GC candidates — the grace
 *  window excludes freshly-written blobs a concurrent sync may be referencing). */
export function blobHashesOlderThan(cutoffIso: string): string[] {
  return db
    .select({ hash: blobs.hash })
    .from(blobs)
    .where(lt(blobs.createdAt, cutoffIso))
    .all()
    .map((r) => r.hash);
}

/** Delete a blob's metadata row (the bytes are reclaimed separately via the
 *  BlobStore). Idempotent. */
export function deleteBlob(hash: string): void {
  db.delete(blobs).where(eq(blobs.hash, hash)).run();
}

/** Indexed point check: does any LIVE artifact_files row still point at this hash?
 *  The GC's cheap, always-fresh per-candidate guard (the common re-reference path) —
 *  uses the artifact_files_hash index, so it stays O(1) even as candidates pile up. */
export function artifactFileReferencesHash(hash: string): boolean {
  return !!db.select({ id: artifactFiles.id }).from(artifactFiles).where(eq(artifactFiles.hash, hash)).get();
}

/** Every blob hash referenced by ANY retained run_snapshot's manifest — the full
 *  snapshot scan deserialized ONCE into a Set so the GC can answer per-candidate
 *  snapshot membership in O(1) instead of re-scanning the whole table per garbage
 *  hash. The GC rebuilds this only when the snapshot row count changes (a report()
 *  raced the pass), so a snapshot that comes to reference a hash mid-pass is still
 *  caught — closing the GC-check-time gap where a snapshot references a hash no live
 *  file row does — without paying O(garbage × snapshots). */
export function snapshotBlobRefs(): Set<string> {
  const refs = new Set<string>();
  for (const r of db.select({ manifest: runSnapshots.manifest }).from(runSnapshots).all()) {
    for (const entry of Object.values(r.manifest)) {
      if (entry?.hash) refs.add(entry.hash);
    }
  }
  return refs;
}

/** Count of retained run_snapshot rows — the GC's cheap change-detector for deciding
 *  whether to rebuild its precomputed snapshotBlobRefs() set mid-pass. */
export function countRunSnapshots(): number {
  return db.select({ n: sql<number>`count(*)` }).from(runSnapshots).get()?.n ?? 0;
}

/** Distinct loop ids with a LIVE (non-deleted) file row pointing at this hash.
 *  Drives the per-loop cap re-check at putBlob, where the only loop context is
 *  the artifact_files rows a prior sync already wrote for the requested hash. */
export function loopsReferencingHash(hash: string): string[] {
  return db
    .selectDistinct({ loopId: artifactFiles.loopId })
    .from(artifactFiles)
    .where(and(eq(artifactFiles.hash, hash), eq(artifactFiles.deleted, false)))
    .all()
    .map((r) => r.loopId);
}

/** A loop's live byte footprint EXCLUDING any rows pointing at `hash` — the base
 *  the putBlob cap guard adds the blob's REAL byte length to (the placeholder row
 *  a sync wrote for `hash` carries a client-reported size we must not trust). Sums
 *  the VERIFIED blobs.size where the bytes are stored, falling back to the reported
 *  artifact_files.size only for not-yet-stored (pending) rows, so a daemon that
 *  under-reports sizes can't keep the base artificially low. */
export function loopStoredBytesExcludingHash(loopId: string, hash: string): number {
  const row = db
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
    .get();
  return row?.total ?? 0;
}

/** Hard-delete a loop's file rows pointing at `hash` — used when putBlob refuses
 *  the bytes (per-loop cap), so nothing dangles pointing at a blob never stored.
 *  Returns the number removed. */
export function dropArtifactFilesForHash(loopId: string, hash: string): number {
  const r = db
    .delete(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.hash, hash)))
    .run();
  return r.changes;
}

/** A loop's current live (non-deleted) byte footprint: sum of sizes over files
 *  that actually have bytes stored (hash non-null, not oversize). Prefers the
 *  VERIFIED blobs.size (real length recorded at recordBlob) and only falls back to
 *  the client-reported artifact_files.size for a row whose blob isn't stored yet
 *  (pending), so an under-reporting daemon can't creep past the cap. This is the
 *  figure the per-loop storage cap is enforced against. */
export function loopStoredBytes(loopId: string): number {
  const row = db
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
    .get();
  return row?.total ?? 0;
}

/** The PER-PATH breakdown of loopStoredBytes: each live, byte-backed file row's
 *  counted size (verified blobs.size, falling back to the client-reported
 *  artifact_files.size for a pending row — the exact per-row basis
 *  loopStoredBytes sums). One query per sync so the overwrite "freed" credit
 *  doesn't cost two point queries per manifest file on the ~1.5s flush path. */
export function liveArtifactSizes(loopId: string): Map<string, number> {
  const rows = db
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
    )
    .all();
  return new Map(rows.map((r) => [r.path, r.size ?? 0]));
}

