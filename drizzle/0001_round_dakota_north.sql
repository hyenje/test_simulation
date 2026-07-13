CREATE TABLE `stream_session_access` (
	`session_id` text PRIMARY KEY NOT NULL,
	`secret_digest` text NOT NULL,
	`auth_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `stream_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
