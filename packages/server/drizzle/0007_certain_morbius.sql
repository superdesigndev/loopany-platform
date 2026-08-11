CREATE TABLE "machine_team_aliases" (
	"team_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"alias" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mta_team_alias_uq" ON "machine_team_aliases" USING btree ("team_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "mta_team_machine_uq" ON "machine_team_aliases" USING btree ("team_id","machine_id");