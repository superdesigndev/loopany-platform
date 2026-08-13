TRUNCATE TABLE "notification_channels";--> statement-breakpoint
DROP INDEX "notification_channels_team_idx";--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_channels_user_idx" ON "notification_channels" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "notification_channels" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "notification_channels" DROP COLUMN "user_email";
