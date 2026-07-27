CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"run_id" text,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"at" text NOT NULL,
	"text" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE INDEX "events_loop_at_idx" ON "events" USING btree ("loop_id","at");--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "events" USING btree ("run_id");