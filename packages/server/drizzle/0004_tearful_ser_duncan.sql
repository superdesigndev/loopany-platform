CREATE TABLE "graph_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"object_id" text,
	"event_id" text NOT NULL,
	"channel" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"created_at" text NOT NULL,
	"read_at" text
);
--> statement-breakpoint
DROP INDEX "outbox_actions_pending_idx";--> statement-breakpoint
-- Hand-added DATA migration (drizzle-kit diffs schema, not row values): the
-- outbox row state machine renamed its terminal success state `delivered` → `done`
-- when the executor landed. Forward-only, and idempotent on a re-run.
UPDATE "outbox_actions" SET "state" = 'done' WHERE "state" = 'delivered';--> statement-breakpoint
ALTER TABLE "outbox_actions" ADD COLUMN "next_attempt_at" text;--> statement-breakpoint
ALTER TABLE "outbox_actions" ADD COLUMN "claimed_at" text;--> statement-breakpoint
ALTER TABLE "outbox_actions" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "outbox_actions" ADD COLUMN "dead_lettered_at" text;--> statement-breakpoint
ALTER TABLE "outbox_actions" ADD COLUMN "refusal_code" text;--> statement-breakpoint
CREATE INDEX "graph_notifications_team_idx" ON "graph_notifications" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "graph_notifications_unread_idx" ON "graph_notifications" USING btree ("team_id") WHERE "graph_notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "graph_notifications_object_idx" ON "graph_notifications" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "outbox_actions_claim_idx" ON "outbox_actions" USING btree ("next_attempt_at","created_at","seq") WHERE "outbox_actions"."state" in ('pending','failed');--> statement-breakpoint
CREATE INDEX "outbox_actions_executing_idx" ON "outbox_actions" USING btree ("claimed_at") WHERE "outbox_actions"."state" = 'executing';--> statement-breakpoint
CREATE INDEX "outbox_actions_dead_idx" ON "outbox_actions" USING btree ("team_id","dead_lettered_at") WHERE "outbox_actions"."state" = 'dead-letter';--> statement-breakpoint
ALTER TABLE "outbox_actions" ADD CONSTRAINT "outbox_actions_dead_letter_reason" CHECK (("outbox_actions"."state" = 'dead-letter') = ("outbox_actions"."refusal_code" IS NOT NULL));