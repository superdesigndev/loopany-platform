/**
 * Loopany business schema (Drizzle, Postgres `pg-core` dialect).
 *
 * Three tables — machines / loops / runs — keyed off the Better Auth `user`
 * table (added in the auth step; `userId` here is the owning user's id). We use
 * Drizzle (not raw SQL) so the store is single-sourced across the driver tiers
 * (postgres-js on Supabase; embedded pglite for local/self-host + tests) — the
 * query-builder API is identical, only `db/index.ts` branches the driver.
 *
 * Timestamps are ISO strings (`text`) for portability + to match the carried-over
 * c0 types (no db-side defaults). JSON columns use `jsonb().$type<>()` for typed
 * (de)serialization. Booleans use native `boolean()`. The per-run USD figure is a
 * `doublePrecision` column so per-loop totals are one SUM.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, integer, doublePrecision, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

import type { ArtifactMeta } from "../server/frontmatter.js";

export type { ArtifactMeta } from "../server/frontmatter.js";

// ---- shared value shapes (mirror the carried-over scheduler types) ----

/** Declares a loop's per-run numeric observation metrics (chart legend + validation). */
export interface StateField {
  key: string;
  label?: string;
  unit?: string;
}

/** One control command an exec/evolve run issued via the `loopany` shim (audit). */
export interface ControlAction {
  ts: string;
  command: string;
  args: Record<string, string>;
  result: "ok" | "rejected";
  detail?: string;
}

/** A file this run's claude session created or edited (transcript-derived, path relative to workdir). */
export interface RunArtifact {
  path: string;
  kind: "created" | "edited";
}

/** Token-usage breakdown reported alongside a run's cost (all optional — an
 *  older daemon / a timed-out run reports none). Rides in a JSON column; the
 *  aggregable USD figure gets its own real column (`runs.costUsd`). */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  numTurns?: number;
}

/** One slimmed step of a claude run's execution trace (daemon parses it from the
 *  machine's transcript and pushes it up; the run-detail view renders the list). */
export interface TranscriptStep {
  kind: "text" | "tool" | "result";
  text?: string;
  /** Tool name (kind === "tool"). */
  name?: string;
  /** Compact JSON of the tool input (kind === "tool"). */
  input?: string;
}

export type NotifyPolicy = "always" | "auto" | "never";
export type RunPhase = "pending" | "running" | "done" | "error" | "canceled";
export type RunRole = "exec" | "evolve" | "edit";
export type RunOutcome = "silent" | "direct" | "exec" | "error" | "evolve";
export type RunStatus = "new" | "resolved" | "nothing-new";

export type ChannelType = "telegram" | "slack" | "feishu";

/** The coding agent a loop is bound to / recorded as its host (see `loops.agent`). */
export type CodingAgent = "claude-code" | "codex";

/** A push channel's transport secrets (one shape per type; only the relevant keys set). */
export interface ChannelConfig {
  /** telegram: bot token (`123456:ABC…`) + target chat id (user/group/channel). */
  botToken?: string;
  chatId?: string;
  /** slack: bot token (`xoxb-…`) + target channel (`#name` or id). */
  token?: string;
  channel?: string;
  /** feishu: custom-bot webhook URL + optional signing secret (签名校验). */
  webhookUrl?: string;
  secret?: string;
}

// ---- machines: a teammate's daemon (machine == identity unit) ----

export const machines = pgTable(
  "machines",
  {
    /** m-sha256(deviceToken)[:16] */
    id: text("id").primaryKey(),
    /** Owning user (Better Auth user.id) — creator attribution. */
    userId: text("user_id").notNull(),
    /** Owning team — the scope machines/loops/channels are listed by. Backfilled
     *  from userId for pre-team rows (`team-<userId>`); see migration. */
    teamId: text("team_id"),
    /** Friendly name (set AFTER the daemon connects; empty string = pending/unnamed). */
    name: text("name").notNull(),
    /** Daemon-reported machine identity (captured on first connect). */
    hostname: text("hostname"),
    platform: text("platform"),
    arch: text("arch"),
    /** Daemon package version reported on poll (e.g. "0.8.0"). Null for older
     *  daemons that don't report it (and until the first poll). Drives the web's
     *  "update available" hint against the cached npm latest. */
    daemonVersion: text("daemon_version"),
    /** Hash of the device token (machine identity derives from the token). */
    tokenHash: text("token_hash").notNull(),
    /**
     * Plaintext device token. Stored so the UI can re-show the connect command
     * anytime (MVP convenience — deviates from "store only the hash"; acceptable
     * for a self-hosted team tool where the DB is already the trust root).
     */
    token: text("token"),
    /** Workdir allowlist the daemon enforces as cwd jail; null/[] = unrestricted. */
    roots: jsonb("roots").$type<string[]>(),
    /** Last WS contact (ISO). */
    lastSeen: text("last_seen"),
    /** Live WS connection state. */
    online: boolean("online").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("machines_user_idx").on(t.userId), index("machines_team_idx").on(t.teamId)],
);

// ---- loops: a scheduled behavior bound to one machine ----

export const loops = pgTable(
  "loops",
  {
    id: text("id").primaryKey(),
    /** Owning user (creator attribution). */
    userId: text("user_id").notNull(),
    /** Owning team — the scope loops are listed/authorized by. Backfilled from
     *  userId for pre-team rows (`team-<userId>`); see migration. */
    teamId: text("team_id"),
    /** Push channel this loop notifies through (notification_channels.id). Null ⇒
     *  no external push (dashboard only) regardless of `notify` policy. */
    channelId: text("channel_id"),
    /** Execution machine (set at creation; no cross-machine fallback). */
    machineId: text("machine_id").notNull(),
    name: text("name"),
    cron: text("cron").notNull(),
    /** IANA tz the cron is interpreted in (e.g. "Asia/Shanghai"). Null ⇒ server local (UTC in prod). */
    timezone: text("timezone"),
    /** Absolute project dir ON THE MACHINE the agent runs in (cwd). Null ⇒ daemon scratch dir. */
    workdir: text("workdir"),
    /** Path ON THE MACHINE to the loop's durable context+log doc. */
    taskFile: text("task_file"),
    /** Latest synced snapshot of `taskFile`'s content — the daemon pushes it on
     *  report (capped; tail if huge). Null ⇒ never synced (no run yet / no file). */
    taskFileContent: text("task_file_content"),
    /** When `taskFileContent` was last synced from the machine (ISO). */
    taskFileSyncedAt: text("task_file_synced_at"),
    /** Zero-LLM pre-filter JS (authored by human / evolve). Runs on the machine. */
    workflow: text("workflow"),
    /** Generative-UI template (authored by evolve; sanitized at render). */
    ui: text("ui"),
    /** Per-run metric schema. */
    stateSchema: jsonb("state_schema").$type<StateField[]>(),
    notify: text("notify", { enum: ["always", "auto", "never"] }).notNull().default("auto"),
    /** May a run change its own schedule (reschedule/set-cron)? Default TRUE — a
     *  loop self-adjusts unless the owner PINS the schedule (allowControl=false =
     *  "don't self-adjust"). Run-path self-schedule is floor-guarded (see the
     *  cadence floors in gateway); the owner's edit path is unlimited. */
    allowControl: boolean("allow_control").notNull().default(true),
    /** CLOSED-loop setpoint: a one-line, checkable goal. Null ⇒ OPEN loop
     *  (monitor/digest — never self-terminates; "finish" is not a concept for it).
     *  Non-null ⇒ CLOSED loop: each exec run is the comparator (judges state vs the
     *  goal) and calls `loopany finish` when it's met. Open↔closed conversion = set/
     *  clear this. */
    goal: text("goal"),
    /** Terminal stamp: when the loop's goal was declared met (ISO). Null ⇒ still
     *  running / never completed. Completing forces enabled=false (the scheduler
     *  skips it for free). Structural invariant: non-null implies goal != null. */
    completedAt: text("completed_at"),
    /** One-line reason recorded at completion (the finishing run's summary). */
    completionReason: text("completion_reason"),
    model: text("model"),
    /** Coding agent this loop is BOUND TO / was created by (the harness recorded
     *  as its host). Recording-only today: the daemon still executes every loop via
     *  Claude regardless of this value (Codex execution is a later phase). Measured
     *  from the creating CLI's env when detectable, else the declared/selected value;
     *  TS-only enum (stored as plain text), so widening the set later is a type
     *  change with no migration. Existing rows backfill to `claude-code` via default. */
    agent: text("agent", { enum: ["claude-code", "codex"] }).notNull().default("claude-code"),
    enabled: boolean("enabled").notNull().default(true),
    /** One-shot override: run once at this time, then resume cron (ISO). */
    nextRunAt: text("next_run_at"),
    /** Workflow cursor: last returned state, passed back as `prev`. */
    state: jsonb("state").$type<unknown>(),
    /** runs count at last evolution (drives the periodic evolve trigger). */
    evolvedRunCount: integer("evolved_run_count"),
    /** Marker: next tick runs the evolution pass as its sole work. */
    evolveDue: boolean("evolve_due"),
    /** Pending owner edit: the next tick runs an `edit` agent that applies this
     *  instruction (schedule via `loopany edit`, content via the loop's README.md) then clears it. */
    editRequest: text("edit_request"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("loops_user_idx").on(t.userId),
    index("loops_team_idx").on(t.teamId),
    index("loops_machine_idx").on(t.machineId),
  ],
);

// ---- runs: one execution record (own table, not embedded) ----

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id").notNull(),
    userId: text("user_id").notNull(),
    machineId: text("machine_id").notNull(),
    phase: text("phase", { enum: ["pending", "running", "done", "error", "canceled"] }).notNull(),
    role: text("role", { enum: ["exec", "evolve", "edit"] }).notNull(),
    ts: text("ts").notNull(),
    outcome: text("outcome", { enum: ["silent", "direct", "exec", "error", "evolve"] }),
    status: text("status", { enum: ["new", "resolved", "nothing-new"] }),
    message: text("message"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    /** This run's observation snapshot — numeric metrics (chart points) plus scalar
     *  values the generative UI binds via {{latest.*}} (strings ok; chart ignores them). */
    state: jsonb("state").$type<Record<string, number | string>>(),
    /** Control actions this run issued (audit). */
    control: jsonb("control").$type<ControlAction[]>(),
    /** claude session id on the machine (locates the transcript; MVP doesn't read it). */
    sessionId: text("session_id"),
    /** Claude's own USD estimate for this run (the CLI's `total_cost_usd`). A real
     *  column (not JSON) so per-loop totals are one SUM. Null: workflow-only run,
     *  older daemon, or the run never reached a terminal result event. */
    costUsd: doublePrecision("cost_usd"),
    /** Token-count breakdown reported with the cost (display-only detail). */
    usage: jsonb("usage").$type<RunUsage>(),
    /** Files the run's claude session created/edited (parsed from its transcript). */
    artifacts: jsonb("artifacts").$type<RunArtifact[]>(),
    /** Slimmed execution trace (text/tool/result steps the daemon parsed from the
     *  machine's claude transcript). Null for workflow-only runs (no claude). */
    transcript: jsonb("transcript").$type<TranscriptStep[]>(),
    /** Live "what's it doing" signal while running — a slim current-activity line
     *  the daemon pushes on its poll heartbeat (NOT the full transcript). Cleared
     *  when the run finalizes (the complete transcript supersedes it). `at` is the
     *  freshness stamp the sweep reads as last-heard-from (optional: rows written
     *  by older daemons lack it). TS-only shape; no migration. */
    progress: jsonb("progress").$type<{ step: number; label: string; at?: string }>(),
  },
  (t) => [
    index("runs_loop_idx").on(t.loopId),
    index("runs_phase_idx").on(t.phase),
    index("runs_loop_ts_idx").on(t.loopId, t.ts),
  ],
);

// ---- teams: the ownership/scope unit (every user gets a personal team) ----

export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The user whose personal team this is (null for the open-mode shared team). */
  ownerUserId: text("owner_user_id"),
  createdAt: text("created_at").notNull(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("team_members_team_idx").on(t.teamId), index("team_members_user_idx").on(t.userId)],
);

// ---- notification channels: per-team push targets a loop can route to ----

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: text("id").primaryKey(),
    /** Owning team (channels are listed/selected within a team). */
    teamId: text("team_id").notNull(),
    type: text("type", { enum: ["telegram", "slack", "feishu"] }).notNull(),
    name: text("name").notNull(),
    /** Transport secrets (shape per `type`). Stored as JSON; never sent to the client raw. */
    config: jsonb("config").$type<ChannelConfig>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("notification_channels_team_idx").on(t.teamId)],
);

// ---- artifacts: content-addressed live-synced loop files (Phase 1 foundation) ----
//
// The daemon watches each loop's folder and live-syncs changed files. Blob BYTES
// live in external object storage (Cloudflare R2), keyed by sha256 content hash —
// NOT in the DB (no `content` column), keeping the business DB lean and preserving
// the server's zero-exec invariant (it only stores/reads bytes, never interprets
// them). These two tables hold only metadata.

/**
 * One content-addressed blob (deduped across every loop/run). The bytes live in
 * R2 under the hash; this row records that the server has them + their shape.
 */
export const blobs = pgTable("blobs", {
  /** sha256 hex of the bytes (the R2 object key). */
  hash: text("hash").primaryKey(),
  size: integer("size").notNull(),
  /** Heuristic: the bytes contain a NUL (download-only; no inline text render). */
  binary: boolean("binary").notNull().default(false),
  /** Parsed front-matter subset ({type?,title?,date?}) for a non-binary markdown
   *  product, or null (untyped / binary / no usable front matter). Front matter is
   *  a pure function of content, so this is parsed ONCE where the bytes first
   *  arrive (sync inline / putBlob) and reused on every content-addressed dedup
   *  re-reference. Old blobs keep it null — zero migration/backfill. */
  meta: jsonb("meta").$type<ArtifactMeta>(),
  createdAt: text("created_at").notNull(),
});

/**
 * The CURRENT file set of each loop — one row per live (or tombstoned) path,
 * relative to the loop's watch folder. `hash` → `blobs.hash`; null when the file
 * is deleted (tombstone) or oversize (metadata-only, no bytes synced). The
 * unique (loopId, path) index is the upsert key the sync reconciliation drives.
 */
export const artifactFiles = pgTable(
  "artifact_files",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id").notNull(),
    /** Normalized, loop-folder-relative (never absolute, never escaping the dir). */
    path: text("path").notNull(),
    /** → blobs.hash. Null when deleted or oversize (no bytes stored). */
    hash: text("hash"),
    size: integer("size"),
    /** Bytes contain a NUL (mirrors blobs.binary; set even for oversize files). */
    binary: boolean("binary").notNull().default(false),
    /** File exceeds the per-file byte cap → metadata-only (path + size), no blob. */
    oversize: boolean("oversize").notNull().default(false),
    /** Tombstone: the file vanished from the loop's manifest (kept for future diffs). */
    deleted: boolean("deleted").notNull().default(false),
    updatedAt: text("updated_at").notNull(),
    /** The run in-flight when this change synced (null for idle-time human edits). */
    lastRunId: text("last_run_id"),
  },
  (t) => [
    index("artifact_files_loop_idx").on(t.loopId),
    uniqueIndex("artifact_files_loop_path_idx").on(t.loopId, t.path),
    // The blob GC's per-candidate referenced re-check + the putBlob cap guard both
    // do a point lookup by hash; without this they full-scan artifact_files.
    index("artifact_files_hash_idx").on(t.hash),
  ],
);

/**
 * One file's metadata in a run snapshot (path → this). Richer than a bare
 * path→hash map so the per-run diff can compute a size delta and pick a render
 * mode (text diff vs "binary changed ±KB") without re-reading artifact_files.
 */
export interface SnapshotEntry {
  /** → blobs.hash; null for an oversize (metadata-only) file. */
  hash: string | null;
  size: number | null;
  binary: boolean;
  oversize: boolean;
}

/** A loop's full file set at a run boundary: path → {hash,size,binary,oversize}. */
export type SnapshotManifest = Record<string, SnapshotEntry>;

/**
 * The loop's full artifact manifest captured at each run's finalize — the input
 * to the per-run diff (Phase 3). Written cheaply on report (no diff computed on
 * write); `getRunDiff` lazily diffs run N's snapshot against the prior run's.
 * One row per run (runId PK); runs predating the feature simply have no row
 * (the diff view degrades to its "no recorded changes" copy).
 */
export const runSnapshots = pgTable(
  "run_snapshots",
  {
    runId: text("run_id").primaryKey(),
    loopId: text("loop_id").notNull(),
    manifest: jsonb("manifest").$type<SnapshotManifest>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("run_snapshots_loop_idx").on(t.loopId)],
);

export type Machine = typeof machines.$inferSelect;
export type NewMachine = typeof machines.$inferInsert;
export type Loop = typeof loops.$inferSelect;
export type NewLoop = typeof loops.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NewNotificationChannel = typeof notificationChannels.$inferInsert;
export type Blob = typeof blobs.$inferSelect;
export type NewBlob = typeof blobs.$inferInsert;
export type ArtifactFile = typeof artifactFiles.$inferSelect;
export type NewArtifactFile = typeof artifactFiles.$inferInsert;
export type RunSnapshot = typeof runSnapshots.$inferSelect;
export type NewRunSnapshot = typeof runSnapshots.$inferInsert;

/** Drizzle table bag (also used by the Better Auth drizzle adapter once auth lands). */
export const businessSchema = { machines, loops, runs, teams, teamMembers, notificationChannels, blobs, artifactFiles, runSnapshots };

// Keep a default no-op SQL reference so `sql` import isn't flagged before use.
export const _schemaVersion = sql`1`;
