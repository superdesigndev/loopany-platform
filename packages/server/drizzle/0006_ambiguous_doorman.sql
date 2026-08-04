ALTER TABLE "runs" ADD COLUMN "trigger_event_id" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "mirror_kind" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "mirror_coords" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "attached_to" jsonb;--> statement-breakpoint
CREATE INDEX "objects_mirror_kind_idx" ON "objects" USING btree ("team_id","mirror_kind") WHERE "objects"."kind" = 'mirror';--> statement-breakpoint
CREATE INDEX "objects_mirror_coords_idx" ON "objects" USING btree ("team_id","mirror_coords") WHERE "objects"."kind" = 'mirror';--> statement-breakpoint
CREATE INDEX "objects_mirror_attached_idx" ON "objects" USING gin ("attached_to") WHERE "objects"."kind" = 'mirror';--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_mirror_facets_only" CHECK ("objects"."kind" = 'mirror' OR ("objects"."mirror_kind" IS NULL AND "objects"."mirror_coords" IS NULL AND "objects"."attached_to" IS NULL));--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_mirror_pointer" CHECK ("objects"."kind" <> 'mirror' OR ("objects"."mirror_kind" IS NOT NULL AND "objects"."mirror_coords" IS NOT NULL AND "objects"."attached_to" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_mirror_stateless" CHECK ("objects"."kind" <> 'mirror' OR ("objects"."payload" IS NULL AND "objects"."body" IS NULL));