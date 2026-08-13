ALTER TABLE "teams" ADD COLUMN "slug" text;--> statement-breakpoint
WITH normalized AS (
  SELECT "id", COALESCE(NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(CASE WHEN "owner_user_id" IS NOT NULL AND "id" = 'team-' || "owner_user_id" THEN REGEXP_REPLACE("name", '[''’]s[[:space:]]+team$', '', 'i') ELSE "name" END), '[^a-z0-9]+', '-', 'g')), ''), 'team') AS base
  FROM "teams"
), ranked AS (
  SELECT "id", base, ROW_NUMBER() OVER (PARTITION BY base ORDER BY "created_at", "id") AS n
  FROM normalized JOIN "teams" USING ("id")
)
UPDATE "teams" SET "slug" = CASE WHEN ranked.n = 1 THEN ranked.base ELSE ranked.base || '-' || ranked.n END
FROM ranked WHERE "teams"."id" = ranked."id";--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_slug_unique" UNIQUE("slug");
