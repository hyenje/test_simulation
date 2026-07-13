import { and, eq, gt, inArray } from "drizzle-orm";
import { getD1, getDb } from ".";
import {
  deviceMemberships,
  devices,
  streamSessionAccess,
  streamSessions,
} from "./schema";
import {
  createViewerPassword,
  createViewerPasswordVerifier,
  SESSION_AUTH_VERSION,
  verifyViewerPassword,
} from "./session-secret";

const SESSION_TTL_MS = 60 * 60 * 1000;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BROADCAST_ROLES = ["owner", "broadcaster"];

let schemaReady: Promise<void> | null = null;

export type ActiveSession = {
  roomCode: string;
  deviceId: string;
  channelArn: string;
  expiresAt: string;
};

export type CreatedSession = ActiveSession & {
  viewerPassword: string;
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
        d1.prepare(`CREATE TABLE IF NOT EXISTS stream_session_access (
          session_id TEXT PRIMARY KEY NOT NULL,
          secret_digest TEXT NOT NULL,
          auth_version TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
          FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE CASCADE
        )`),
        d1.prepare(`CREATE TABLE IF NOT EXISTS request_rate_limits (
          rate_key TEXT PRIMARY KEY NOT NULL,
          window_started_at INTEGER NOT NULL,
          request_count INTEGER NOT NULL
        )`),
      ])
      .then(() => undefined)
      .catch((error: unknown) => {
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
  shareSecret: string;
}): Promise<CreatedSession> {
  await ensurePetcamSchema();
  const db = getDb();
  const d1 = getD1();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  const [existingDevice] = await db
    .select({ id: devices.id, channelArn: devices.kvsChannelArn })
    .from(devices)
    .where(eq(devices.id, input.deviceId))
    .limit(1);

  if (!existingDevice) {
    throw new Error("DEVICE_FORBIDDEN");
  } else {
    if (existingDevice.channelArn !== input.channelArn) {
      throw new Error("DEVICE_FORBIDDEN");
    }

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

    if (!membership || !BROADCAST_ROLES.includes(membership.role)) {
      throw new Error("DEVICE_FORBIDDEN");
    }
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const sessionId = crypto.randomUUID();
    const roomCode = createRoomCode();
    const viewerPassword = createViewerPassword();
    const secretDigest = await createViewerPasswordVerifier(
      sessionId,
      viewerPassword,
      input.shareSecret,
    );

    try {
      await d1.batch([
        d1
          .prepare(
            "UPDATE stream_sessions SET status = 'expired', ended_at = ? WHERE device_id = ? AND status = 'active'",
          )
          .bind(nowIso, input.deviceId),
        d1
          .prepare(
            "INSERT INTO stream_sessions (id, room_code, device_id, started_by, status, started_at, expires_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
          )
          .bind(
            sessionId,
            roomCode,
            input.deviceId,
            input.ownerEmail,
            nowIso,
            expiresAt,
          ),
        d1
          .prepare(
            "INSERT INTO stream_session_access (session_id, secret_digest, auth_version) VALUES (?, ?, ?)",
          )
          .bind(sessionId, secretDigest, SESSION_AUTH_VERSION),
      ]);
      return {
        roomCode,
        deviceId: input.deviceId,
        channelArn: input.channelArn,
        expiresAt,
        viewerPassword,
      };
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
    }
  }

  throw new Error("ROOM_CODE_EXHAUSTED");
}

export async function getAuthorizedMasterSession(
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
        eq(streamSessions.startedBy, userEmail),
        eq(streamSessions.status, "active"),
        gt(streamSessions.expiresAt, new Date().toISOString()),
        inArray(deviceMemberships.role, BROADCAST_ROLES),
      ),
    )
    .limit(1);

  return session ?? null;
}

export async function getPasswordAuthorizedViewerSession(
  roomCode: string,
  viewerPassword: string,
  shareSecret: string,
): Promise<ActiveSession | null> {
  await ensurePetcamSchema();
  const db = getDb();
  const [session] = await db
    .select({
      id: streamSessions.id,
      roomCode: streamSessions.roomCode,
      deviceId: streamSessions.deviceId,
      channelArn: devices.kvsChannelArn,
      expiresAt: streamSessions.expiresAt,
      secretDigest: streamSessionAccess.secretDigest,
      authVersion: streamSessionAccess.authVersion,
    })
    .from(streamSessions)
    .innerJoin(devices, eq(devices.id, streamSessions.deviceId))
    .innerJoin(streamSessionAccess, eq(streamSessionAccess.sessionId, streamSessions.id))
    .where(
      and(
        eq(streamSessions.roomCode, roomCode),
        eq(streamSessions.status, "active"),
        gt(streamSessions.expiresAt, new Date().toISOString()),
      ),
    )
    .limit(1);

  if (!session || session.authVersion !== SESSION_AUTH_VERSION) return null;
  const allowed = await verifyViewerPassword(
    session.id,
    viewerPassword,
    session.secretDigest,
    shareSecret,
  );
  if (!allowed) return null;

  return {
    roomCode: session.roomCode,
    deviceId: session.deviceId,
    channelArn: session.channelArn,
    expiresAt: session.expiresAt,
  };
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

export async function consumeRequestRateLimit(input: {
  userEmail: string;
  roomCode: string;
  scope: string;
  limit: number;
}) {
  await ensurePetcamSchema();
  const windowStartedAt = Math.floor(Date.now() / 60_000) * 60_000;
  const result = await getD1()
    .prepare(`INSERT INTO request_rate_limits (rate_key, window_started_at, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(rate_key) DO UPDATE SET
        window_started_at = CASE
          WHEN request_rate_limits.window_started_at < excluded.window_started_at
          THEN excluded.window_started_at
          ELSE request_rate_limits.window_started_at
        END,
        request_count = CASE
          WHEN request_rate_limits.window_started_at < excluded.window_started_at
          THEN 1
          ELSE request_rate_limits.request_count + 1
        END
      RETURNING request_count`)
    .bind(rateLimitKey(input), windowStartedAt)
    .first<{ request_count: number }>();

  return Boolean(result && result.request_count <= input.limit);
}

export async function clearRequestRateLimit(input: {
  userEmail: string;
  roomCode: string;
  scope: string;
}) {
  await ensurePetcamSchema();
  await getD1()
    .prepare("DELETE FROM request_rate_limits WHERE rate_key = ?")
    .bind(rateLimitKey(input))
    .run();
}

function rateLimitKey(input: { userEmail: string; roomCode: string; scope: string }) {
  return `${input.scope}:${input.userEmail}:${input.roomCode}`;
}

function createRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join("");
}
