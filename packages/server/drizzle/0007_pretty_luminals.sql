ALTER TABLE "objects" ADD COLUMN "parent_id" text;--> statement-breakpoint
CREATE INDEX "objects_parent_idx" ON "objects" USING btree ("parent_id") WHERE "objects"."kind" = 'task';--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_parent_task_only" CHECK ("objects"."kind" = 'task' OR "objects"."parent_id" IS NULL);