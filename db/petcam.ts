import { and, eq, gt } from "drizzle-orm";
import { getD1, getDb } from ".";
import { deviceMemberships, devices, streamSessions } from "./schema";

const SESSION_TTL_MS = 60 * 60 * 1000;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let schemaReady: Promise<void> | null = null;

export type ActiveSession = {
  roomCode: string;
  deviceId: string;
  channelArn: string;
  expiresAt: string;
};

export async function ensurePetcamSchema() {
  if (!schemaReady) {
    const d1 = getD1();
    schemaReady = d1
      .batch([
        d1.prepare(`CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY NOT NULL,
          display_name TEXT NOT NULL,
          kvs_channel_arn TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
        )`),
        d1.prepare(
          "CREATE UNIQUE INDEX IF NOT EXISTS devices_kvs_channel_arn_idx ON devices (kvs_channel_arn)",
        ),
        d1.prepare(`CREATE TABLE IF NOT EXISTS device_memberships (
          device_id TEXT NOT NULL,
          user_email TEXT NOT NULL,
          role TEXT DEFAULT 'owner' NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
          PRIMARY KEY (device_id, user_email),
          FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
        )`),
        d1.prepare(
          "CREATE INDEX IF NOT EXISTS device_memberships_user_email_idx ON device_memberships (user_email)",
        ),
        d1.prepare(`CREATE TABLE IF NOT EXISTS stream_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          room_code TEXT NOT NULL,
          device_id TEXT NOT NULL,
          started_by TEXT NOT NULL,
          status TEXT DEFAULT 'active' NOT NULL,
          started_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          ended_at TEXT,
          FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
        )`),
        d1.prepare(
          "CREATE UNIQUE INDEX IF NOT EXISTS stream_sessions_room_code_idx ON stream_sessions (room_code)",
        ),
        d1.prepare(
          "CREATE INDEX IF NOT EXISTS stream_sessions_device_status_idx ON stream_sessions (device_id, status)",
        ),
      ])
      .then(() => undefined)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }

  await schemaReady;
}

export async function createLiveSession(input: {
  ownerEmail: string;
  deviceId: string;
  displayName: string;
  channelArn: string;
}): Promise<ActiveSession> {
  await ensurePetcamSchema();
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  const [existingDevice] = await db
    .select({ id: devices.id, channelArn: devices.kvsChannelArn })
    .from(devices)
    .where(eq(devices.id, input.deviceId))
    .limit(1);

  if (!existingDevice) {
    await db.insert(devices).values({
      id: input.deviceId,
      displayName: input.displayName,
      kvsChannelArn: input.channelArn,
    });
    await db.insert(deviceMemberships).values({
      deviceId: input.deviceId,
      userEmail: input.ownerEmail,
      role: "owner",
    });
  } else {
    const [membership] = await db
      .select({ role: deviceMemberships.role })
      .from(deviceMemberships)
      .where(
        and(
          eq(deviceMemberships.deviceId, input.deviceId),
          eq(deviceMemberships.userEmail, input.ownerEmail),
        ),
      )
      .limit(1);
    if (!membership || existingDevice.channelArn !== input.channelArn) {
      throw new Error("DEVICE_FORBIDDEN");
    }
  }

  await db
    .update(streamSessions)
    .set({ status: "expired", endedAt: now.toISOString() })
    .where(
      and(
        eq(streamSessions.deviceId, input.deviceId),
        eq(streamSessions.status, "active"),
      ),
    );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const roomCode = createRoomCode();
    try {
      await db.insert(streamSessions).values({
        id: crypto.randomUUID(),
        roomCode,
        deviceId: input.deviceId,
        startedBy: input.ownerEmail,
        status: "active",
        startedAt: now.toISOString(),
        expiresAt,
      });
      return { roomCode, deviceId: input.deviceId, channelArn: input.channelArn, expiresAt };
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
    }
  }

  throw new Error("ROOM_CODE_EXHAUSTED");
}

export async function getAuthorizedSession(
  userEmail: string,
  roomCode: string,
): Promise<ActiveSession | null> {
  await ensurePetcamSchema();
  const db = getDb();
  const [session] = await db
    .select({
      roomCode: streamSessions.roomCode,
      deviceId: streamSessions.deviceId,
      channelArn: devices.kvsChannelArn,
      expiresAt: streamSessions.expiresAt,
    })
    .from(streamSessions)
    .innerJoin(devices, eq(devices.id, streamSessions.deviceId))
    .innerJoin(
      deviceMemberships,
      and(
        eq(deviceMemberships.deviceId, streamSessions.deviceId),
        eq(deviceMemberships.userEmail, userEmail),
      ),
    )
    .where(
      and(
        eq(streamSessions.roomCode, roomCode),
        eq(streamSessions.status, "active"),
        gt(streamSessions.expiresAt, new Date().toISOString()),
      ),
    )
    .limit(1);

  return session ?? null;
}

export async function endLiveSession(ownerEmail: string, roomCode: string) {
  await ensurePetcamSchema();
  const db = getDb();
  const result = await db
    .update(streamSessions)
    .set({ status: "ended", endedAt: new Date().toISOString() })
    .where(
      and(
        eq(streamSessions.roomCode, roomCode),
        eq(streamSessions.startedBy, ownerEmail),
        eq(streamSessions.status, "active"),
      ),
    );

  return result.meta.changes > 0;
}

function createRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join("");
}
