CREATE TABLE "kernel_events" (
	"id" text NOT NULL,
	"team_id" text NOT NULL,
	"object_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_objects" (
	"id" text NOT NULL,
	"team_id" text NOT NULL,
	"archetype" text NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_runs" (
	"id" text NOT NULL,
	"team_id" text NOT NULL,
	"task_id" text NOT NULL,
	"cause" text NOT NULL,
	"state" text NOT NULL,
	"scheduled_at" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_triggers" (
	"id" text NOT NULL,
	"team_id" text NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean NOT NULL,
	"next_fire_at" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "kernel_events_pk" ON "kernel_events" USING btree ("team_id","id");--> statement-breakpoint
CREATE INDEX "kernel_events_team_idx" ON "kernel_events" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "kernel_events_object_idx" ON "kernel_events" USING btree ("team_id","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kernel_objects_pk" ON "kernel_objects" USING btree ("team_id","id");--> statement-breakpoint
CREATE INDEX "kernel_objects_team_idx" ON "kernel_objects" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kernel_runs_pk" ON "kernel_runs" USING btree ("team_id","id");--> statement-breakpoint
CREATE INDEX "kernel_runs_team_idx" ON "kernel_runs" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "kernel_runs_task_idx" ON "kernel_runs" USING btree ("team_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kernel_triggers_pk" ON "kernel_triggers" USING btree ("team_id","id");--> statement-breakpoint
CREATE INDEX "kernel_triggers_team_idx" ON "kernel_triggers" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "kernel_triggers_task_idx" ON "kernel_triggers" USING btree ("team_id","task_id");