DROP INDEX "machines_user_idx";--> statement-breakpoint
CREATE INDEX "machines_enrolled_by_idx" ON "machines" USING btree ("enrolled_by");--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "user_id";