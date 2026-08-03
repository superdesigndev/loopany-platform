CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"team_id" text NOT NULL,
	"object_id" text,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"entrance" text NOT NULL,
	"actor_id" text NOT NULL,
	"transition" text,
	"diff" jsonb,
	"note" text,
	"payload" jsonb,
	"ts" text NOT NULL,
	CONSTRAINT "events_state_change_sufficient" CHECK ("events"."diff" IS NULL OR "events"."transition" IS NOT NULL OR NOT jsonb_exists("events"."diff", 'status'))
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"cron" text,
	"timezone" text,
	"next_fire" text,
	"follow_up_at" text,
	"pending_question" text,
	"watcher" text,
	"format" text,
	"key" text,
	"payload" jsonb,
	"body" text,
	"created_by_run" text,
	"created_by_loop" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"closed_at" text,
	CONSTRAINT "objects_cron_loop_only" CHECK ("objects"."kind" = 'loop' OR ("objects"."cron" IS NULL AND "objects"."timezone" IS NULL AND "objects"."next_fire" IS NULL)),
	CONSTRAINT "objects_task_facets_only" CHECK ("objects"."kind" = 'task' OR ("objects"."follow_up_at" IS NULL AND "objects"."pending_question" IS NULL AND "objects"."watcher" IS NULL)),
	CONSTRAINT "objects_format_doc_only" CHECK ("objects"."kind" = 'doc' OR "objects"."format" IS NULL),
	CONSTRAINT "objects_closed_pair" CHECK ("objects"."kind" <> 'task' OR (("objects"."status" = 'closed') = ("objects"."closed_at" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "queue_state" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "entrance" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "scheduled_for" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "claimed_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_expires_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_state" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "report_doc_id" text;--> statement-breakpoint
CREATE INDEX "events_team_seq_idx" ON "events" USING btree ("team_id","seq");--> statement-breakpoint
CREATE INDEX "events_object_ts_idx" ON "events" USING btree ("object_id","ts");--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("entrance","actor_id");--> statement-breakpoint
CREATE INDEX "events_kind_idx" ON "events" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "objects_key_idx" ON "objects" USING btree ("team_id","key") WHERE "objects"."key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "objects_due_fire_idx" ON "objects" USING btree ("next_fire") WHERE "objects"."kind" = 'loop' AND "objects"."next_fire" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "objects_question_idx" ON "objects" USING btree ("team_id","created_at") WHERE "objects"."kind" = 'task' AND "objects"."status" = 'open' AND "objects"."pending_question" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "objects_due_task_idx" ON "objects" USING btree ("team_id","follow_up_at") WHERE "objects"."kind" = 'task' AND "objects"."status" = 'open' AND "objects"."follow_up_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "objects_unwatched_idx" ON "objects" USING btree ("team_id","created_at") WHERE "objects"."kind" = 'task' AND "objects"."status" = 'open' AND "objects"."watcher" IS NULL;--> statement-breakpoint
CREATE INDEX "objects_orphan_idx" ON "objects" USING btree ("team_id","created_at") WHERE "objects"."kind" = 'task' AND "objects"."status" = 'open' AND "objects"."watcher" IS NULL AND "objects"."follow_up_at" IS NULL;--> statement-breakpoint
CREATE INDEX "objects_watcher_idx" ON "objects" USING btree ("watcher","follow_up_at") WHERE "objects"."kind" = 'task' AND "objects"."status" = 'open';--> statement-breakpoint
CREATE INDEX "objects_creator_idx" ON "objects" USING btree ("created_by_loop","created_at");--> statement-breakpoint
CREATE INDEX "objects_team_kind_status_idx" ON "objects" USING btree ("team_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_queued_idx" ON "runs" USING btree ("loop_id") WHERE "runs"."queue_state" = 'queued';--> statement-breakpoint
CREATE INDEX "runs_claim_idx" ON "runs" USING btree ("ts") WHERE "runs"."queue_state" = 'queued';--> statement-breakpoint
CREATE INDEX "runs_lease_idx" ON "runs" USING btree ("lease_expires_at") WHERE "runs"."queue_state" = 'claimed';--> statement-breakpoint
CREATE INDEX "runs_scope_idx" ON "runs" USING btree ("scope") WHERE "runs"."scope" IS NOT NULL AND "runs"."scope" <> 'routine';