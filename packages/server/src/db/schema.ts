/**
 * LoopAny business schema (Drizzle, SQLite dialect).
 *
 * Three tables — machines / loops / runs — keyed off the Better Auth `user`
 * table (added in the auth step; `userId` here is the owning user's id). We use
 * Drizzle (not raw SQL) specifically so a later switch to Supabase/Postgres is a
 * dialect swap (`sqlite-core` → `pg-core` + driver), not a query rewrite.
 *
 * Timestamps are ISO strings (text) for portability + to match the carried-over
 * c0 types. JSON columns use `{ mode: "json" }` with `$type<>()` for typed
 * (de)serialization. Booleans use `{ mode: "boolean" }` over INTEGER.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

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
export type RunRole = "exec" | "draft" | "evolve" | "edit";
export type RunOutcome = "silent" | "direct" | "exec" | "error" | "evolve";
export type RunStatus = "new" | "resolved" | "nothing-new";

export type ChannelType = "telegram" | "slack" | "feishu";

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

export const machines = sqliteTable(
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
    /** Hash of the device token (machine identity derives from the token). */
    tokenHash: text("token_hash").notNull(),
    /**
     * Plaintext device token. Stored so the UI can re-show the connect command
     * anytime (MVP convenience — deviates from "store only the hash"; acceptable
     * for a self-hosted team tool where the DB is already the trust root).
     */
    token: text("token"),
    /** Workdir allowlist the daemon enforces as cwd jail; null/[] = unrestricted. */
    roots: text("roots", { mode: "json" }).$type<string[]>(),
    /** Last WS contact (ISO). */
    lastSeen: text("last_seen"),
    /** Live WS connection state. */
    online: integer("online", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("machines_user_idx").on(t.userId), index("machines_team_idx").on(t.teamId)],
);

// ---- loops: a scheduled behavior bound to one machine ----

export const loops = sqliteTable(
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
    /** Legacy/standing instruction handed to the exec agent. */
    task: text("task"),
    /** Absolute project dir ON THE MACHINE the agent runs in (cwd). Null ⇒ daemon scratch dir. */
    workdir: text("workdir"),
    /** Path ON THE MACHINE to the loop's durable context+log doc. */
    taskFile: text("task_file"),
    /** Latest synced snapshot of `taskFile`'s content — the daemon pushes it on
     *  report (capped; tail if huge). Null ⇒ never synced (no run yet / no file). */
    taskFileContent: text("task_file_content"),
    /** When `taskFileContent` was last synced from the machine (ISO). */
    taskFileSyncedAt: text("task_file_synced_at"),
    /** Zero-LLM pre-filter JS (authored by human / draft / evolve). Runs on the machine. */
    workflow: text("workflow"),
    /** Generative-UI template (authored by draft/evolve; sanitized at render). */
    ui: text("ui"),
    /** Per-run metric schema. */
    stateSchema: text("state_schema", { mode: "json" }).$type<StateField[]>(),
    notify: text("notify", { enum: ["always", "auto", "never"] }).notNull().default("auto"),
    /** May a run change its own schedule (reschedule/set-cron/pause/notify)? */
    allowControl: integer("allow_control", { mode: "boolean" }).notNull().default(false),
    model: text("model"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** One-shot override: run once at this time, then resume cron (ISO). */
    nextRunAt: text("next_run_at"),
    /** Workflow cursor: last returned state, passed back as `prev`. */
    state: text("state", { mode: "json" }).$type<unknown>(),
    /** runs count at last evolution (drives the periodic evolve trigger). */
    evolvedRunCount: integer("evolved_run_count"),
    /** Marker: next tick runs the evolution pass as its sole work. */
    evolveDue: integer("evolve_due", { mode: "boolean" }),
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

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id").notNull(),
    userId: text("user_id").notNull(),
    machineId: text("machine_id").notNull(),
    phase: text("phase", { enum: ["pending", "running", "done", "error", "canceled"] }).notNull(),
    role: text("role", { enum: ["exec", "draft", "evolve", "edit"] }).notNull(),
    ts: text("ts").notNull(),
    outcome: text("outcome", { enum: ["silent", "direct", "exec", "error", "evolve"] }),
    status: text("status", { enum: ["new", "resolved", "nothing-new"] }),
    message: text("message"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    sample: real("sample"),
    /** This run's observation snapshot — numeric metrics (chart points) plus scalar
     *  values the generative UI binds via {{latest.*}} (strings ok; chart ignores them). */
    state: text("state", { mode: "json" }).$type<Record<string, number | string>>(),
    /** Control actions this run issued (audit). */
    control: text("control", { mode: "json" }).$type<ControlAction[]>(),
    /** claude session id on the machine (locates the transcript; MVP doesn't read it). */
    sessionId: text("session_id"),
    /** Files the run's claude session created/edited (parsed from its transcript). */
    artifacts: text("artifacts", { mode: "json" }).$type<RunArtifact[]>(),
    /** Slimmed execution trace (text/tool/result steps the daemon parsed from the
     *  machine's claude transcript). Null for workflow-only runs (no claude). */
    transcript: text("transcript", { mode: "json" }).$type<TranscriptStep[]>(),
    /** Live "what's it doing" signal while running — a slim current-activity line
     *  the daemon pushes on its poll heartbeat (NOT the full transcript). Cleared
     *  when the run finalizes (the complete transcript supersedes it). */
    progress: text("progress", { mode: "json" }).$type<{ step: number; label: string }>(),
  },
  (t) => [
    index("runs_loop_idx").on(t.loopId),
    index("runs_phase_idx").on(t.phase),
    index("runs_loop_ts_idx").on(t.loopId, t.ts),
  ],
);

// ---- teams: the ownership/scope unit (every user gets a personal team) ----

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The user whose personal team this is (null for the open-mode shared team). */
  ownerUserId: text("owner_user_id"),
  createdAt: text("created_at").notNull(),
});

export const teamMembers = sqliteTable(
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

export const notificationChannels = sqliteTable(
  "notification_channels",
  {
    id: text("id").primaryKey(),
    /** Owning team (channels are listed/selected within a team). */
    teamId: text("team_id").notNull(),
    type: text("type", { enum: ["telegram", "slack", "feishu"] }).notNull(),
    name: text("name").notNull(),
    /** Transport secrets (shape per `type`). Stored as JSON; never sent to the client raw. */
    config: text("config", { mode: "json" }).$type<ChannelConfig>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("notification_channels_team_idx").on(t.teamId)],
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

/** Drizzle table bag (also used by the Better Auth drizzle adapter once auth lands). */
export const businessSchema = { machines, loops, runs, teams, teamMembers, notificationChannels };

// Keep a default no-op SQL reference so `sql` import isn't flagged before use.
export const _schemaVersion = sql`1`;
