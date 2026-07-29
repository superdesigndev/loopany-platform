CREATE TABLE "edges" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"src_id" text NOT NULL,
	"dst_id" text NOT NULL,
	"meta" jsonb,
	"created_by_event" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"object_id" text,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"transition" text,
	"diff" jsonb,
	"payload" jsonb,
	"entrance" text NOT NULL,
	"actor_id" text NOT NULL,
	"ts" text NOT NULL,
	CONSTRAINT "events_state_change_payload_sufficient" CHECK ("events"."kind" <> 'status-changed' OR ("events"."transition" IS NOT NULL AND "events"."diff" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gate_obligations" (
	"object_id" text NOT NULL,
	"key" text NOT NULL,
	"team_id" text NOT NULL,
	"class" text NOT NULL,
	"label" text,
	"opened_by_event" text NOT NULL,
	"opened_at" text NOT NULL,
	"closed_by_event" text,
	"closed_at" text,
	"next_reminder_at" text,
	CONSTRAINT "gate_obligations_object_id_key_pk" PRIMARY KEY("object_id","key"),
	CONSTRAINT "gate_obligations_closed_pair" CHECK (("gate_obligations"."closed_by_event" IS NULL) = ("gate_obligations"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"archetype" text NOT NULL,
	"type" text NOT NULL,
	"type_version" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"status_changed_at" text NOT NULL,
	"title" text,
	"payload" jsonb,
	"owner_user_id" text,
	"assignee_user_id" text,
	"cron" text,
	"timezone" text,
	"next_run_at" text,
	"external_source" text,
	"external_id" text,
	"external_observed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "objects_mirror_identity_complete" CHECK ("objects"."archetype" <> 'mirror' OR ("objects"."external_source" IS NOT NULL AND "objects"."external_id" IS NOT NULL)),
	CONSTRAINT "objects_mirror_not_schedulable" CHECK ("objects"."archetype" <> 'mirror' OR ("objects"."cron" IS NULL AND "objects"."assignee_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "outbox_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"seq" integer NOT NULL,
	"team_id" text NOT NULL,
	"object_id" text,
	"kind" text NOT NULL,
	"consequence_class" text NOT NULL,
	"approval_event" text,
	"chain_depth" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" text NOT NULL,
	"delivered_at" text,
	CONSTRAINT "outbox_actions_approval_required" CHECK ("outbox_actions"."consequence_class" NOT IN ('R3','R4') OR "outbox_actions"."approval_event" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "type_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"archetype" text NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"spec" jsonb NOT NULL,
	"rationale" text,
	"proposed_by_event" text,
	"proposed_at" text NOT NULL,
	"armed_by_event" text,
	"armed_at" text,
	"retired_at" text,
	CONSTRAINT "type_registry_effective_armed" CHECK ("type_registry"."state" <> 'effective' OR "type_registry"."armed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "edges_src_idx" ON "edges" USING btree ("src_id","kind");--> statement-breakpoint
CREATE INDEX "edges_dst_idx" ON "edges" USING btree ("dst_id","kind");--> statement-breakpoint
CREATE INDEX "edges_team_idx" ON "edges" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "events_object_ts_idx" ON "events" USING btree ("object_id","ts");--> statement-breakpoint
CREATE INDEX "events_team_ts_idx" ON "events" USING btree ("team_id","ts");--> statement-breakpoint
CREATE INDEX "events_kind_idx" ON "events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("entrance","actor_id");--> statement-breakpoint
CREATE INDEX "gate_obligations_open_idx" ON "gate_obligations" USING btree ("team_id","class") WHERE "gate_obligations"."closed_by_event" IS NULL;--> statement-breakpoint
CREATE INDEX "gate_obligations_object_idx" ON "gate_obligations" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "objects_team_idx" ON "objects" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "objects_team_type_idx" ON "objects" USING btree ("team_id","type");--> statement-breakpoint
CREATE INDEX "objects_team_status_idx" ON "objects" USING btree ("team_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "objects_mirror_identity_idx" ON "objects" USING btree ("team_id","external_source","external_id") WHERE "objects"."archetype" = 'mirror';--> statement-breakpoint
CREATE INDEX "outbox_actions_pending_idx" ON "outbox_actions" USING btree ("created_at") WHERE "outbox_actions"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_actions_event_idx" ON "outbox_actions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "outbox_actions_object_idx" ON "outbox_actions" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "type_registry_version_idx" ON "type_registry" USING btree ("team_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "type_registry_effective_idx" ON "type_registry" USING btree ("team_id","name") WHERE "type_registry"."state" = 'effective';--> statement-breakpoint
CREATE INDEX "type_registry_team_idx" ON "type_registry" USING btree ("team_id");