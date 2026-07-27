CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"runtime" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agents_machine_idx" ON "agents" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "agents_slug_idx" ON "agents" USING btree ("slug");