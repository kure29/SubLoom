CREATE TABLE `fetch_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`at` integer NOT NULL,
	`status` text NOT NULL,
	`bytes` integer,
	`duration_ms` integer,
	`error` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fetch_logs_source_id_idx` ON `fetch_logs` (`source_id`,`id`);--> statement-breakpoint
CREATE TABLE `outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`target` text NOT NULL,
	`token` text NOT NULL,
	`options_json` text NOT NULL,
	`last_access_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outputs_token_unique` ON `outputs` (`token`);--> statement-breakpoint
CREATE INDEX `outputs_profile_id_idx` ON `outputs` (`profile_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ir_json` text NOT NULL,
	`pipeline_json` text NOT NULL,
	`source_ids_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`url_enc` text,
	`content` text,
	`user_agent` text,
	`ttl_sec` integer NOT NULL,
	`last_fetched_at` integer,
	`last_status` text,
	`last_error` text,
	`userinfo_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
