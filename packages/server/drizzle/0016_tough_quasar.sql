CREATE TABLE "kernel_run_transcript_chunks" (
	"team_id" text NOT NULL,
	"run_id" text NOT NULL,
	"start_seq" integer NOT NULL,
	"end_seq" integer NOT NULL,
	"received_at" text NOT NULL,
	"byte_length" integer NOT NULL,
	"entry_count" integer NOT NULL,
	"final" boolean DEFAULT false NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "kernel_run_transcript_chunks_pk" ON "kernel_run_transcript_chunks" USING btree ("team_id","run_id","start_seq");--> statement-breakpoint
CREATE INDEX "kernel_run_transcript_run_idx" ON "kernel_run_transcript_chunks" USING btree ("team_id","run_id","start_seq");--> statement-breakpoint
CREATE INDEX "kernel_run_transcript_received_idx" ON "kernel_run_transcript_chunks" USING btree ("received_at");