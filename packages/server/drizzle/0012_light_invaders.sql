ALTER TABLE "machine_team_aliases" RENAME TO "team_machine_bindings";--> statement-breakpoint
DROP INDEX "mta_team_alias_uq";--> statement-breakpoint
DROP INDEX "mta_team_machine_uq";--> statement-breakpoint
ALTER TABLE "team_machine_bindings" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "team_machine_bindings" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "team_machine_bindings" ADD COLUMN "disabled_at" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tmb_team_alias_uq" ON "team_machine_bindings" USING btree ("team_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "tmb_team_machine_uq" ON "team_machine_bindings" USING btree ("team_id","machine_id");--> statement-breakpoint
CREATE INDEX "tmb_machine_idx" ON "team_machine_bindings" USING btree ("machine_id");