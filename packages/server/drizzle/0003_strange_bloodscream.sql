CREATE TABLE "todo_items" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"loop_id" text NOT NULL,
	"run_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"role" text NOT NULL,
	"outcome" text,
	"run_status" text,
	"failed" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"produced_at" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"assignee_user_id" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "todo_items_team_idx" ON "todo_items" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "todo_items_run_idx" ON "todo_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "todo_items_loop_idx" ON "todo_items" USING btree ("loop_id");