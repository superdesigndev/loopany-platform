CREATE TABLE "review_marks" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"path" text NOT NULL,
	"hash" text NOT NULL,
	"actor" text NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "review_marks_loop_path_hash_idx" ON "review_marks" USING btree ("loop_id","path","hash");