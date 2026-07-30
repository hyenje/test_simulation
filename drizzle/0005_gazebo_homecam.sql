INSERT OR IGNORE INTO `devices` (
	`id`,
	`display_name`,
	`kvs_channel_arn`
) VALUES (
	'gazebo-homecam',
	'Gazebo 홈캠',
	'arn:aws:kinesisvideo:ap-northeast-2:882872688996:channel/soma-aiot-pet-laptop-01/1783859169461'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `device_memberships` (
	`device_id`,
	`user_email`,
	`role`
)
SELECT
	'gazebo-homecam',
	'hyenje29@gmail.com',
	'owner'
WHERE EXISTS (
	SELECT 1 FROM `devices` WHERE `id` = 'gazebo-homecam'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `device_state` (
	`device_id`,
	`monitoring_enabled`,
	`camera_enabled`,
	`microphone_enabled`,
	`source_profile`,
	`active_stream_mode`,
	`media_healthy`,
	`detector_healthy`
)
SELECT
	'gazebo-homecam',
	false,
	true,
	true,
	'sim',
	'idle',
	false,
	false
WHERE EXISTS (
	SELECT 1 FROM `devices` WHERE `id` = 'gazebo-homecam'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `device_credentials` (
	`id`,
	`device_id`,
	`label`,
	`token_digest`,
	`expires_at`
)
SELECT
	'a1bf0d3d-d84c-49e1-aaed-533328473dfb',
	'gazebo-homecam',
	'Gazebo production 2026-07-27',
	'e4a6776a63f7c9d33b819c7452fd903a9c128a442d06b649324bfeec4130a575',
	'2026-10-25T11:37:26.020Z'
WHERE EXISTS (
	SELECT 1 FROM `devices` WHERE `id` = 'gazebo-homecam'
);
