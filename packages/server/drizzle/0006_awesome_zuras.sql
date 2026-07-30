ALTER TABLE "objects" DROP CONSTRAINT "objects_mirror_not_schedulable";--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "interval_ms" integer;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "next_fire" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "schedule_armed_by_event" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "last_fired_at" text;--> statement-breakpoint
CREATE INDEX "objects_due_idx" ON "objects" USING btree ("next_fire") WHERE "objects"."next_fire" is not null;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_one_schedule_form" CHECK ("objects"."cron" IS NULL OR "objects"."interval_ms" IS NULL);--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_mirror_not_schedulable" CHECK ("objects"."archetype" <> 'mirror' OR ("objects"."cron" IS NULL AND "objects"."interval_ms" IS NULL AND "objects"."next_fire" IS NULL AND "objects"."assignee_user_id" IS NULL));