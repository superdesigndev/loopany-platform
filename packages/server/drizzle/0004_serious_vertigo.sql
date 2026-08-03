ALTER TABLE "runs" ADD COLUMN "outcome_summary" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_cost" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "started_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "finished_at" text;