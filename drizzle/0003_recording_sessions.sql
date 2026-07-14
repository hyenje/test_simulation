CREATE TABLE `recording_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`kvs_stream_arn` text NOT NULL,
	`kvs_channel_arn` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `stream_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recording_sessions_started_at_idx` ON `recording_sessions` (`started_at`);
