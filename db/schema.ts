import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
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

export const requestRateLimits = sqliteTable("request_rate_limits", {
  rateKey: text("rate_key").primaryKey(),
  windowStartedAt: integer("window_started_at").notNull(),
  requestCount: integer("request_count").notNull(),
});
