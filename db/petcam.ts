import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { getD1, getDb } from ".";
import {
  deviceMemberships,
  devices,
  recordingSessions,
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
const RECORDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BROADCAST_ROLES = ["owner", "broadcaster"];
const RECORDING_VIEW_ROLES = ["owner", "family", "broadcaster"];

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

export type RecordingSessionItem = {
  id: string;
  deviceId: string;
  displayName: string;
  startedAt: string;
  endedAt: string | null;
  status: "recording" | "ready";
};

export type AuthorizedRecordingSession = {
  id: string;
  deviceId: string;
  streamArn: string;
  startedAt: string;
  endedAt: string | null;
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
        d1.prepare(`CREATE TABLE IF NOT EXISTS recording_sessions (
          session_id TEXT PRIMARY KEY NOT NULL,
          kvs_stream_arn TEXT NOT NULL,
          kvs_channel_arn TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
          FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE CASCADE
        )`),
        d1.prepare(
          "CREATE INDEX IF NOT EXISTS recording_sessions_started_at_idx ON recording_sessions (started_at)",
        ),
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
  streamArn?: string;
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
    if (!input.streamArn && existingDevice.channelArn !== input.channelArn) {
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
      const statements = [
        d1
          .prepare(
            `UPDATE recording_sessions SET ended_at = ?
             WHERE ended_at IS NULL AND session_id IN (
               SELECT id FROM stream_sessions WHERE device_id = ? AND status = 'active'
             )`,
          )
          .bind(nowIso, input.deviceId),
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
      ];
      if (input.streamArn) {
        statements.push(
          d1
            .prepare(
              "INSERT INTO recording_sessions (session_id, kvs_stream_arn, kvs_channel_arn) VALUES (?, ?, ?)",
            )
            .bind(sessionId, input.streamArn, input.channelArn),
        );
      }
      await d1.batch(statements);
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
      channelArn:
        sql<string>`COALESCE(${recordingSessions.kvsChannelArn}, ${devices.kvsChannelArn})`.as(
          "channel_arn",
        ),
      expiresAt: streamSessions.expiresAt,
    })
    .from(streamSessions)
    .innerJoin(devices, eq(devices.id, streamSessions.deviceId))
    .leftJoin(recordingSessions, eq(recordingSessions.sessionId, streamSessions.id))
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

export async function extendAuthorizedMasterSession(
  userEmail: string,
  roomCode: string,
) {
  await finalizeExpiredSessions();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE stream_sessions SET expires_at = ?
       WHERE room_code = ? AND started_by = ? AND status = 'active'
         AND expires_at > ? AND EXISTS (
           SELECT 1 FROM device_memberships
           WHERE device_memberships.device_id = stream_sessions.device_id
             AND device_memberships.user_email = ?
             AND device_memberships.role IN ('owner', 'broadcaster')
         )`,
    )
    .bind(expiresAt, roomCode, userEmail, nowIso, userEmail)
    .run();

  return result.meta.changes > 0;
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
      channelArn:
        sql<string>`COALESCE(${recordingSessions.kvsChannelArn}, ${devices.kvsChannelArn})`.as(
          "channel_arn",
        ),
      expiresAt: streamSessions.expiresAt,
      secretDigest: streamSessionAccess.secretDigest,
      authVersion: streamSessionAccess.authVersion,
    })
    .from(streamSessions)
    .innerJoin(devices, eq(devices.id, streamSessions.deviceId))
    .leftJoin(recordingSessions, eq(recordingSessions.sessionId, streamSessions.id))
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

export async function markRecordingStarted(input: {
  userEmail: string;
  roomCode: string;
  streamArn: string;
}) {
  await finalizeExpiredSessions();
  const db = getDb();
  const [recording] = await db
    .select({
      sessionId: recordingSessions.sessionId,
      startedAt: recordingSessions.startedAt,
    })
    .from(recordingSessions)
    .innerJoin(streamSessions, eq(streamSessions.id, recordingSessions.sessionId))
    .innerJoin(
      deviceMemberships,
      and(
        eq(deviceMemberships.deviceId, streamSessions.deviceId),
        eq(deviceMemberships.userEmail, input.userEmail),
      ),
    )
    .where(
      and(
        eq(streamSessions.roomCode, input.roomCode),
        eq(streamSessions.startedBy, input.userEmail),
        eq(streamSessions.status, "active"),
        gt(streamSessions.expiresAt, new Date().toISOString()),
        eq(recordingSessions.kvsStreamArn, input.streamArn),
        inArray(deviceMemberships.role, BROADCAST_ROLES),
      ),
    )
    .limit(1);

  if (!recording) return false;
  if (recording.startedAt) return true;

  const nowIso = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE recording_sessions SET started_at = COALESCE(started_at, ?)
       WHERE session_id = ? AND kvs_stream_arn = ? AND EXISTS (
         SELECT 1 FROM stream_sessions
         WHERE id = ? AND status = 'active' AND expires_at > ?
       )`,
    )
    .bind(
      nowIso,
      recording.sessionId,
      input.streamArn,
      recording.sessionId,
      nowIso,
    )
    .run();

  return result.meta.changes > 0;
}

export async function listAuthorizedRecordingSessions(
  userEmail: string,
): Promise<RecordingSessionItem[]> {
  await finalizeExpiredSessions();
  const db = getDb();
  const retentionCutoff = new Date(Date.now() - RECORDING_RETENTION_MS).toISOString();
  const rows = await db
    .select({
      id: recordingSessions.sessionId,
      deviceId: streamSessions.deviceId,
      displayName: devices.displayName,
      startedAt: recordingSessions.startedAt,
      endedAt: recordingSessions.endedAt,
    })
    .from(recordingSessions)
    .innerJoin(streamSessions, eq(streamSessions.id, recordingSessions.sessionId))
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
        isNotNull(recordingSessions.startedAt),
        or(
          isNull(recordingSessions.endedAt),
          gte(recordingSessions.endedAt, retentionCutoff),
        ),
        inArray(deviceMemberships.role, RECORDING_VIEW_ROLES),
      ),
    )
    .orderBy(desc(recordingSessions.startedAt))
    .limit(100);

  return rows.map((row) => ({
    id: row.id,
    deviceId: row.deviceId,
    displayName: row.displayName,
    startedAt: row.startedAt!,
    endedAt: row.endedAt,
    status: row.endedAt ? "ready" : "recording",
  }));
}

export async function getAuthorizedRecordingSession(
  userEmail: string,
  recordingId: string,
): Promise<AuthorizedRecordingSession | null> {
  await finalizeExpiredSessions();
  const db = getDb();
  const retentionCutoff = new Date(Date.now() - RECORDING_RETENTION_MS).toISOString();
  const [recording] = await db
    .select({
      id: recordingSessions.sessionId,
      deviceId: streamSessions.deviceId,
      streamArn: recordingSessions.kvsStreamArn,
      startedAt: recordingSessions.startedAt,
      endedAt: recordingSessions.endedAt,
    })
    .from(recordingSessions)
    .innerJoin(streamSessions, eq(streamSessions.id, recordingSessions.sessionId))
    .innerJoin(
      deviceMemberships,
      and(
        eq(deviceMemberships.deviceId, streamSessions.deviceId),
        eq(deviceMemberships.userEmail, userEmail),
      ),
    )
    .where(
      and(
        eq(recordingSessions.sessionId, recordingId),
        isNotNull(recordingSessions.startedAt),
        or(
          isNull(recordingSessions.endedAt),
          gte(recordingSessions.endedAt, retentionCutoff),
        ),
        inArray(deviceMemberships.role, RECORDING_VIEW_ROLES),
      ),
    )
    .limit(1);

  if (!recording?.startedAt) return null;
  return {
    id: recording.id,
    deviceId: recording.deviceId,
    streamArn: recording.streamArn,
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
  };
}

export async function finalizeExpiredSessions(nowIso = new Date().toISOString()) {
  await ensurePetcamSchema();
  const d1 = getD1();
  await d1.batch([
    d1
      .prepare(
        `UPDATE recording_sessions
         SET ended_at = (
           SELECT expires_at FROM stream_sessions
           WHERE stream_sessions.id = recording_sessions.session_id
         )
         WHERE ended_at IS NULL AND EXISTS (
           SELECT 1 FROM stream_sessions
           WHERE stream_sessions.id = recording_sessions.session_id
             AND stream_sessions.status = 'active'
             AND stream_sessions.expires_at <= ?
         )`,
      )
      .bind(nowIso),
    d1
      .prepare(
        `UPDATE stream_sessions SET status = 'expired', ended_at = expires_at
         WHERE status = 'active' AND expires_at <= ?`,
      )
      .bind(nowIso),
  ]);
}

export async function endLiveSession(ownerEmail: string, roomCode: string) {
  await ensurePetcamSchema();
  const nowIso = new Date().toISOString();
  const d1 = getD1();
  const results = await d1.batch([
    d1
      .prepare(
        `UPDATE recording_sessions SET ended_at = ?
         WHERE ended_at IS NULL AND session_id IN (
           SELECT id FROM stream_sessions
           WHERE room_code = ? AND started_by = ? AND status = 'active'
         )`,
      )
      .bind(nowIso, roomCode, ownerEmail),
    d1
      .prepare(
        `UPDATE stream_sessions SET status = 'ended', ended_at = ?
         WHERE room_code = ? AND started_by = ? AND status = 'active'`,
      )
      .bind(nowIso, roomCode, ownerEmail),
  ]);

  return results[1].meta.changes > 0;
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
