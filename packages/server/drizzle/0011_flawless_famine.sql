ALTER TABLE "objects" DROP CONSTRAINT "objects_format_doc_only";--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "doc_kind" text;--> statement-breakpoint
UPDATE "objects" SET "doc_kind" = 'product' WHERE "kind" = 'doc';--> statement-breakpoint
CREATE UNIQUE INDEX "objects_one_charter_per_loop_idx" ON "objects" USING btree ("team_id","created_by_loop") WHERE "objects"."kind" = 'doc' AND "objects"."doc_kind" = 'charter';--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_doc_kind_required" CHECK ("objects"."kind" <> 'doc' OR ("objects"."doc_kind" IS NOT NULL AND "objects"."doc_kind" IN ('product', 'charter')));--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_charter_shape" CHECK ("objects"."doc_kind" <> 'charter' OR ("objects"."kind" = 'doc' AND "objects"."format" = 'markdown' AND "objects"."key" IS NOT NULL AND "objects"."created_by_loop" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_format_doc_only" CHECK ("objects"."kind" = 'doc' OR ("objects"."format" IS NULL AND "objects"."doc_kind" IS NULL));
