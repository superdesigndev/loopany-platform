-- ===========================================================================
-- CONVERGENCE S5 - the kernel's retired run queue and loop kind are deleted.
--
-- THE TWO DATA STEPS BELOW RUN BEFORE ANY DROP, and both are here rather than
-- in application code on purpose: the code that used to do them is going away
-- in this same change, and a stack that never booted an S3.1+ build still owes
-- the disposal. A migration is the one chokepoint every stack passes exactly
-- once, in order, before anything reads the new schema.
-- ===========================================================================

-- 1. DISPOSE OF EVERY STRANDED KERNEL QUEUE ROW (the S3.1 boot pass, moved into
--    the migration that removes its columns).
--
--    `queued`/`claimed` are the only two OPEN states of the retired lifecycle.
--    Nothing mints, claims, renews or finishes such a row any more, so it can
--    never execute again - and a stranded `claimed` one keeps its loop
--    permanently "running" (the poll guard holds every future pending run and
--    the sweep stands down), silently. Terminalizing is the only honest
--    disposal. It touches ONLY those two states, so a production row
--    (`queue_state IS NULL`) and completed kernel history are structurally
--    unreachable from here. The row keeps its historical `ts`: this is a
--    disposal, not a fresh event.
--
--    The kernel timeline gets the SAME frozen derived `run-finished` fact the
--    S3.1 pass appended, for exactly the rows that carry kernel provenance
--    (`reason`/`scope`) - a provenance-free row stays event-silent, like all
--    ordinary cron/edit/evolve history. The id is the frozen seed verbatim:
--    `ev-` + sha256(canonicalJson({kind, outcome, runId}))[:12].
INSERT INTO "events" ("id", "team_id", "object_id", "kind", "origin", "entrance", "actor_id", "payload", "ts")
SELECT
  'ev-' || substr(encode(sha256(convert_to(
    '{"kind":"run-finished","outcome":"failure","runId":' || to_json(r."id")::text || '}', 'UTF8')), 'hex'), 1, 12),
  COALESCE(l."team_id", 'team-' || l."user_id"),
  l."id",
  'run-finished',
  'derived',
  'agent',
  r."id",
  jsonb_build_object(
    'outcome', 'failure',
    'reason', r."reason",
    'scope', r."scope",
    'summary', 'stranded at the S3 cutover - the kernel run queue was retired while this run was still open'),
  to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "runs" r
JOIN "loops" l ON l."id" = r."loop_id"
WHERE r."queue_state" IN ('queued', 'claimed')
  AND (r."reason" IS NOT NULL OR r."scope" IS NOT NULL)
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "runs" SET
  "phase" = 'error',
  "outcome" = 'error',
  "error" = 'stranded at the S3 cutover - the kernel run queue was retired while this run was still open',
  "lease_state" = NULL,
  "lease_expires_at" = NULL
WHERE "queue_state" IN ('queued', 'claimed');--> statement-breakpoint

-- 2. REMOVE THE KERNEL LOOP OBJECTS OF MIGRATED LOOPS.
--
--    A converged loop kept its kernel id VERBATIM, so the production `loops`
--    row and the kernel `objects` row named ONE loop through S3/S4 - the object
--    row was retained only so the loop's event history stayed addressable. It
--    still is: `events.object_id` is free text and every event keeps pointing
--    at the same id, which now names the production loop. So the duplicate row
--    goes and nothing is lost.
--
--    The `IN (SELECT id FROM loops)` fence is the whole safety of this: an
--    UNCONVERGED kernel loop (one with no production twin) is the only record
--    of itself, so it is deliberately LEFT IN PLACE rather than deleted. It
--    becomes inert - no kind in `OBJECT_KINDS` matches it and no read selects
--    it - which is a great deal better than silently destroying a loop nobody
--    migrated.
DELETE FROM "objects"
WHERE "kind" = 'loop' AND "id" IN (SELECT "id" FROM "loops");--> statement-breakpoint

ALTER TABLE "objects" DROP CONSTRAINT "objects_cron_loop_only";--> statement-breakpoint
ALTER TABLE "objects" DROP CONSTRAINT "objects_workdir_loop_only";--> statement-breakpoint
DROP INDEX "runs_claim_idx";--> statement-breakpoint
DROP INDEX "runs_lease_idx";--> statement-breakpoint
DROP INDEX "objects_due_fire_idx";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "queue_state";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "lease_expires_at";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "lease_state";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "report_doc_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "outcome_summary";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "run_cost";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "started_at";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "finished_at";--> statement-breakpoint
ALTER TABLE "objects" DROP COLUMN "cron";--> statement-breakpoint
ALTER TABLE "objects" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "objects" DROP COLUMN "next_fire";--> statement-breakpoint
ALTER TABLE "objects" DROP COLUMN "workdir";