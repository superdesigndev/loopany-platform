CREATE TABLE `run_snapshots` (
	`run_id` text PRIMARY KEY NOT NULL,
	`loop_id` text NOT NULL,
	`manifest` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_snapshots_loop_idx` ON `run_snapshots` (`loop_id`);