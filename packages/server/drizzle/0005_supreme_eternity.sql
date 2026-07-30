CREATE TABLE "effect_directives" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"action_id" text NOT NULL,
	"event_id" text NOT NULL,
	"object_id" text,
	"kind" text NOT NULL,
	"target_source" text NOT NULL,
	"target_external_id" text NOT NULL,
	"target_machine" text,
	"payload" jsonb,
	"approval_event" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" text,
	"claimed_by" text,
	"lease_expires_at" text,
	"heartbeat_at" text,
	"result" jsonb,
	"refusal_code" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"settled_at" text,
	CONSTRAINT "effect_directives_failure_reason" CHECK (("effect_directives"."state" = 'failed') = ("effect_directives"."refusal_code" IS NOT NULL)),
	CONSTRAINT "effect_directives_claim_has_lease" CHECK ("effect_directives"."state" <> 'claimed' OR "effect_directives"."lease_expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "effect_directives_claim_idx" ON "effect_directives" USING btree ("created_at") WHERE "effect_directives"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "effect_directives_lease_idx" ON "effect_directives" USING btree ("lease_expires_at") WHERE "effect_directives"."state" = 'claimed';--> statement-breakpoint
CREATE INDEX "effect_directives_failed_idx" ON "effect_directives" USING btree ("team_id","settled_at") WHERE "effect_directives"."state" = 'failed';--> statement-breakpoint
CREATE INDEX "effect_directives_team_idx" ON "effect_directives" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "effect_directives_object_idx" ON "effect_directives" USING btree ("object_id");