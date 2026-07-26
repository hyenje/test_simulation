CREATE TABLE `device_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`label` text NOT NULL,
	`token_digest` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`revoked_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_credentials_token_digest_idx` ON `device_credentials` (`token_digest`);--> statement-breakpoint
CREATE INDEX `device_credentials_device_id_idx` ON `device_credentials` (`device_id`);--> statement-breakpoint
CREATE TABLE `device_state` (
	`device_id` text PRIMARY KEY NOT NULL,
	`monitoring_enabled` integer DEFAULT false NOT NULL,
	`camera_enabled` integer DEFAULT true NOT NULL,
	`microphone_enabled` integer DEFAULT true NOT NULL,
	`source_profile` text DEFAULT 'unknown' NOT NULL,
	`image_topic` text,
	`active_stream_mode` text DEFAULT 'idle' NOT NULL,
	`active_session_id` text,
	`media_healthy` integer DEFAULT false NOT NULL,
	`detector_healthy` integer DEFAULT false NOT NULL,
	`last_seen_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_session_id`) REFERENCES `stream_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `homecam_events` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`event_type` text NOT NULL,
	`confidence` real,
	`occurred_at` text NOT NULL,
		`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
		`idempotency_key` text NOT NULL,
		`request_fingerprint` text NOT NULL,
		`recording_session_id` text,
	`recording_offset_ms` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recording_session_id`) REFERENCES `stream_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `homecam_events_device_idempotency_idx` ON `homecam_events` (`device_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `homecam_events_device_occurred_idx` ON `homecam_events` (`device_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `homecam_push_outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`delivered_at` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `homecam_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `homecam_push_outbox_due_idx` ON `homecam_push_outbox` (`device_id`,`delivered_at`,`next_attempt_at`);--> statement-breakpoint
CREATE TRIGGER `homecam_events_push_outbox`
AFTER INSERT ON `homecam_events`
BEGIN
	INSERT INTO `homecam_push_outbox` (`event_id`, `device_id`)
	VALUES (NEW.`id`, NEW.`device_id`);
END;--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`user_email` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_user_device_endpoint_idx` ON `push_subscriptions` (`user_email`,`device_id`,`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_device_id_idx` ON `push_subscriptions` (`device_id`);--> statement-breakpoint
CREATE TABLE `access_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`metadata_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `access_audit_log_device_created_idx` ON `access_audit_log` (`device_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `talk_leases` (
	`device_id` text PRIMARY KEY NOT NULL,
	`lease_id` text NOT NULL,
	`user_email` text NOT NULL,
	`client_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
