ALTER TABLE "loops" ALTER COLUMN "cron" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "task_meta" jsonb;