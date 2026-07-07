CREATE TABLE "connect_keys" (
	"machine_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text,
	"minted_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_leases" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"role" text NOT NULL,
	"allow_control" boolean DEFAULT false NOT NULL,
	"can_set_ui" boolean DEFAULT false NOT NULL,
	"can_set_schema" boolean DEFAULT false NOT NULL,
	"can_set_workflow" boolean DEFAULT false NOT NULL,
	"can_finish" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"expires_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "run_leases_run_idx" ON "run_leases" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_leases_loop_idx" ON "run_leases" USING btree ("loop_id");