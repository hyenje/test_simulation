CREATE TABLE `device_memberships` (
	`device_id` text NOT NULL,
	`user_email` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`device_id`, `user_email`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_memberships_user_email_idx` ON `device_memberships` (`user_email`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`kvs_channel_arn` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_kvs_channel_arn_idx` ON `devices` (`kvs_channel_arn`);--> statement-breakpoint
CREATE TABLE `stream_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`device_id` text NOT NULL,
	`started_by` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stream_sessions_room_code_idx` ON `stream_sessions` (`room_code`);--> statement-breakpoint
CREATE INDEX `stream_sessions_device_status_idx` ON `stream_sessions` (`device_id`,`status`);