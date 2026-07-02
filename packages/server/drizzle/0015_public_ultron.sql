PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_loops` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`team_id` text,
	`channel_id` text,
	`machine_id` text NOT NULL,
	`name` text,
	`cron` text NOT NULL,
	`timezone` text,
	`task` text,
	`workdir` text,
	`task_file` text,
	`task_file_content` text,
	`task_file_synced_at` text,
	`workflow` text,
	`ui` text,
	`state_schema` text,
	`notify` text DEFAULT 'auto' NOT NULL,
	`allow_control` integer DEFAULT true NOT NULL,
	`goal` text,
	`completed_at` text,
	`completion_reason` text,
	`model` text,
	`agent` text DEFAULT 'claude-code' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` text,
	`state` text,
	`evolved_run_count` integer,
	`evolve_due` integer,
	`edit_request` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
-- The three new columns (goal/completed_at/completion_reason) don't exist on the
-- OLD loops table, so they're omitted from the copy and take their NULL defaults.
INSERT INTO `__new_loops`("id", "user_id", "team_id", "channel_id", "machine_id", "name", "cron", "timezone", "task", "workdir", "task_file", "task_file_content", "task_file_synced_at", "workflow", "ui", "state_schema", "notify", "allow_control", "model", "agent", "enabled", "next_run_at", "state", "evolved_run_count", "evolve_due", "edit_request", "created_at", "updated_at") SELECT "id", "user_id", "team_id", "channel_id", "machine_id", "name", "cron", "timezone", "task", "workdir", "task_file", "task_file_content", "task_file_synced_at", "workflow", "ui", "state_schema", "notify", "allow_control", "model", "agent", "enabled", "next_run_at", "state", "evolved_run_count", "evolve_due", "edit_request", "created_at", "updated_at" FROM `loops`;--> statement-breakpoint
DROP TABLE `loops`;--> statement-breakpoint
ALTER TABLE `__new_loops` RENAME TO `loops`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `loops_user_idx` ON `loops` (`user_id`);--> statement-breakpoint
CREATE INDEX `loops_team_idx` ON `loops` (`team_id`);--> statement-breakpoint
CREATE INDEX `loops_machine_idx` ON `loops` (`machine_id`);--> statement-breakpoint
-- allowControl default flips to TRUE; flip existing rows too (no users → no compat concern).
UPDATE `loops` SET `allow_control` = true;