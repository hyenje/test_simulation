CREATE TABLE `request_rate_limits` (
	`rate_key` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer NOT NULL
);
