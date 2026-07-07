CREATE TABLE "artifact_files" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"path" text NOT NULL,
	"hash" text,
	"size" integer,
	"binary" boolean DEFAULT false NOT NULL,
	"oversize" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL,
	"last_run_id" text
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"size" integer NOT NULL,
	"binary" boolean DEFAULT false NOT NULL,
	"meta" jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loops" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text,
	"channel_id" text,
	"machine_id" text NOT NULL,
	"name" text,
	"cron" text NOT NULL,
	"timezone" text,
	"workdir" text,
	"task_file" text,
	"task_file_content" text,
	"task_file_synced_at" text,
	"workflow" text,
	"ui" text,
	"state_schema" jsonb,
	"notify" text DEFAULT 'auto' NOT NULL,
	"allow_control" boolean DEFAULT true NOT NULL,
	"goal" text,
	"completed_at" text,
	"completion_reason" text,
	"model" text,
	"agent" text DEFAULT 'claude-code' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" text,
	"state" jsonb,
	"evolved_run_count" integer,
	"evolve_due" boolean,
	"edit_request" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text,
	"name" text NOT NULL,
	"hostname" text,
	"platform" text,
	"arch" text,
	"daemon_version" text,
	"token_hash" text NOT NULL,
	"token" text,
	"roots" jsonb,
	"last_seen" text,
	"online" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_snapshots" (
	"run_id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"user_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"phase" text NOT NULL,
	"role" text NOT NULL,
	"ts" text NOT NULL,
	"outcome" text,
	"status" text,
	"message" text,
	"duration_ms" integer,
	"error" text,
	"state" jsonb,
	"control" jsonb,
	"session_id" text,
	"cost_usd" double precision,
	"usage" jsonb,
	"artifacts" jsonb,
	"transcript" jsonb,
	"progress" jsonb
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_files_loop_idx" ON "artifact_files" USING btree ("loop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_files_loop_path_idx" ON "artifact_files" USING btree ("loop_id","path");--> statement-breakpoint
CREATE INDEX "artifact_files_hash_idx" ON "artifact_files" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "loops_user_idx" ON "loops" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "loops_team_idx" ON "loops" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "loops_machine_idx" ON "loops" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "machines_user_idx" ON "machines" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "machines_team_idx" ON "machines" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "notification_channels_team_idx" ON "notification_channels" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "run_snapshots_loop_idx" ON "run_snapshots" USING btree ("loop_id");--> statement-breakpoint
CREATE INDEX "runs_loop_idx" ON "runs" USING btree ("loop_id");--> statement-breakpoint
CREATE INDEX "runs_phase_idx" ON "runs" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "runs_loop_ts_idx" ON "runs" USING btree ("loop_id","ts");--> statement-breakpoint
CREATE INDEX "team_members_team_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");