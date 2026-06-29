CREATE TABLE `artifact_files` (
	`id` text PRIMARY KEY NOT NULL,
	`loop_id` text NOT NULL,
	`path` text NOT NULL,
	`hash` text,
	`size` integer,
	`binary` integer DEFAULT false NOT NULL,
	`oversize` integer DEFAULT false NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	`last_run_id` text
);
--> statement-breakpoint
CREATE INDEX `artifact_files_loop_idx` ON `artifact_files` (`loop_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_files_loop_path_idx` ON `artifact_files` (`loop_id`,`path`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`binary` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
