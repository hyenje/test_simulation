import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    kvsChannelArn: text("kvs_channel_arn").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("devices_kvs_channel_arn_idx").on(table.kvsChannelArn)],
);

export const deviceMemberships = sqliteTable(
  "device_memberships",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    role: text("role").notNull().default("owner"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.userEmail] }),
    index("device_memberships_user_email_idx").on(table.userEmail),
  ],
);

export const streamSessions = sqliteTable(
  "stream_sessions",
  {
    id: text("id").primaryKey(),
    roomCode: text("room_code").notNull(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    startedBy: text("started_by").notNull(),
    status: text("status").notNull().default("active"),
    startedAt: text("started_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    endedAt: text("ended_at"),
  },
  (table) => [
    uniqueIndex("stream_sessions_room_code_idx").on(table.roomCode),
    index("stream_sessions_device_status_idx").on(table.deviceId, table.status),
  ],
);

export const streamSessionAccess = sqliteTable("stream_session_access", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => streamSessions.id, { onDelete: "cascade" }),
  secretDigest: text("secret_digest").notNull(),
  authVersion: text("auth_version").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const recordingSessions = sqliteTable(
  "recording_sessions",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => streamSessions.id, { onDelete: "cascade" }),
    kvsStreamArn: text("kvs_stream_arn").notNull(),
    kvsChannelArn: text("kvs_channel_arn").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("recording_sessions_started_at_idx").on(table.startedAt)],
);

export const requestRateLimits = sqliteTable("request_rate_limits", {
  rateKey: text("rate_key").primaryKey(),
  windowStartedAt: integer("window_started_at").notNull(),
  requestCount: integer("request_count").notNull(),
});

export const deviceCredentials = sqliteTable(
  "device_credentials",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenDigest: text("token_digest").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("device_credentials_token_digest_idx").on(table.tokenDigest),
    index("device_credentials_device_id_idx").on(table.deviceId),
  ],
);

export const deviceState = sqliteTable("device_state", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "cascade" }),
  monitoringEnabled: integer("monitoring_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  cameraEnabled: integer("camera_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  microphoneEnabled: integer("microphone_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  sourceProfile: text("source_profile").notNull().default("unknown"),
  imageTopic: text("image_topic"),
  activeStreamMode: text("active_stream_mode").notNull().default("idle"),
  activeSessionId: text("active_session_id").references(() => streamSessions.id, {
    onDelete: "set null",
  }),
  mediaHealthy: integer("media_healthy", { mode: "boolean" })
    .notNull()
    .default(false),
  detectorHealthy: integer("detector_healthy", { mode: "boolean" })
    .notNull()
    .default(false),
  lastSeenAt: text("last_seen_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const homecamEvents = sqliteTable(
  "homecam_events",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    confidence: real("confidence"),
    occurredAt: text("occurred_at").notNull(),
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    recordingSessionId: text("recording_session_id").references(
      () => streamSessions.id,
      { onDelete: "set null" },
    ),
    recordingOffsetMs: integer("recording_offset_ms"),
  },
  (table) => [
    uniqueIndex("homecam_events_device_idempotency_idx").on(
      table.deviceId,
      table.idempotencyKey,
    ),
    index("homecam_events_device_occurred_idx").on(
      table.deviceId,
      table.occurredAt,
    ),
  ],
);

export const homecamPushOutbox = sqliteTable(
  "homecam_push_outbox",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => homecamEvents.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deliveredAt: text("delivered_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("homecam_push_outbox_due_idx").on(
      table.deviceId,
      table.deliveredAt,
      table.nextAttemptAt,
    ),
  ],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("push_subscriptions_user_device_endpoint_idx").on(
      table.userEmail,
      table.deviceId,
      table.endpoint,
    ),
    index("push_subscriptions_device_id_idx").on(table.deviceId),
  ],
);

export const accessAuditLog = sqliteTable(
  "access_audit_log",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("access_audit_log_device_created_idx").on(table.deviceId, table.createdAt),
  ],
);

export const talkLeases = sqliteTable("talk_leases", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "cascade" }),
  leaseId: text("lease_id").notNull(),
  userEmail: text("user_email").notNull(),
  clientId: text("client_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
