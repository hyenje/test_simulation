// Intentionally empty by default.
// Add Drizzle tables here when the site actually needs a database.
// See examples/d1/db/schema.ts for an opt-in example.
export {};
import { sql } from "drizzle-orm";
import {
  index,
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
