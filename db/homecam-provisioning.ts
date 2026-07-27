import { getD1 } from ".";
import { ensureHomecamSchema } from "./homecam";
import type { HomecamProvisioningRequest } from "./homecam-provisioning-input";

type HomecamProvisioningInput = HomecamProvisioningRequest & {
  kvsChannelArn: string;
};

type ProvisioningSnapshot = {
  deviceById: {
    id: string;
    display_name: string;
    kvs_channel_arn: string;
  } | null;
  deviceByChannel: { id: string } | null;
  membership: { role: string } | null;
  membershipSummary: {
    total: number;
    exact_count: number;
  };
  state: { device_id: string } | null;
  credentialById: {
    id: string;
    device_id: string;
    label: string;
    token_digest: string;
    expires_at: string | null;
    revoked_at: string | null;
  } | null;
  credentialByDigest: { id: string } | null;
  credentialSummary: {
    total: number;
    exact_count: number;
  };
  channelOwnerSummary: {
    display_name: string;
    membership_count: number;
    requested_owner_count: number;
    credential_count: number;
    session_count: number;
    active_session_count: number;
    recording_count: number;
    event_count: number;
    last_seen_at: string | null;
  } | null;
};

export class HomecamProvisioningConflict extends Error {
  readonly details: ReturnType<typeof provisioningConflictDetails>;

  constructor(
    snapshot: ProvisioningSnapshot,
    input: HomecamProvisioningInput,
  ) {
    super("HOMECAM_PROVISIONING_CONFLICT");
    this.details = provisioningConflictDetails(snapshot, input);
  }
}

export async function provisionHomecamDevice(
  input: HomecamProvisioningInput,
) {
  await ensureHomecamSchema();
  const before = await provisioningSnapshot(input);
  if (isCompleteAndCompatible(before, input)) {
    return { deviceId: input.deviceId, created: false };
  }
  if (!isEmpty(before)) {
    throw new HomecamProvisioningConflict(before, input);
  }

  const d1 = getD1();
  const nowIso = new Date().toISOString();
  const statements = [
    d1
      .prepare(
        `INSERT INTO devices (id, display_name, kvs_channel_arn, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(
        input.deviceId,
        input.displayName,
        input.kvsChannelArn,
        nowIso,
      ),
    d1
      .prepare(
        `INSERT INTO device_memberships
         (device_id, user_email, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .bind(input.deviceId, input.ownerEmail, nowIso),
    d1
      .prepare(
        `INSERT INTO device_state
         (device_id, monitoring_enabled, camera_enabled, microphone_enabled,
          source_profile, active_stream_mode, media_healthy,
          detector_healthy, updated_at)
         VALUES (?, 0, 1, 1, ?, 'idle', 0, 0, ?)`,
      )
      .bind(input.deviceId, input.sourceProfile, nowIso),
    d1
      .prepare(
        `INSERT INTO device_credentials
         (id, device_id, label, token_digest, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.credential.id,
        input.deviceId,
        input.credential.label,
        input.credential.tokenDigest,
        nowIso,
        input.credential.expiresAt,
      ),
    d1
      .prepare(
        `INSERT INTO access_audit_log
         (id, device_id, actor_type, actor_id, action, metadata_json, created_at)
         VALUES (?, ?, 'system', 'internal-provisioner',
                 'device.provision', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.deviceId,
        JSON.stringify({
          credentialId: input.credential.id,
          sourceProfile: input.sourceProfile,
        }),
        nowIso,
      ),
  ];
  try {
    await d1.batch(statements);
  } catch (error) {
    const afterRace = await provisioningSnapshot(input);
    if (isCompleteAndCompatible(afterRace, input)) {
      return { deviceId: input.deviceId, created: false };
    }
    if (!isEmpty(afterRace)) {
      throw new HomecamProvisioningConflict(afterRace, input);
    }
    throw error;
  }

  const after = await provisioningSnapshot(input);
  if (!isCompleteAndCompatible(after, input)) {
    throw new HomecamProvisioningConflict(after, input);
  }
  return { deviceId: input.deviceId, created: true };
}

async function provisioningSnapshot(
  input: HomecamProvisioningInput,
): Promise<ProvisioningSnapshot> {
  const d1 = getD1();
  const [
    deviceById,
    deviceByChannel,
    membership,
    membershipSummary,
    state,
    credentialById,
    credentialByDigest,
    credentialSummary,
  ] = await Promise.all([
    d1
      .prepare(
        "SELECT id, display_name, kvs_channel_arn FROM devices WHERE id = ?",
      )
      .bind(input.deviceId)
      .first<ProvisioningSnapshot["deviceById"]>(),
    d1
      .prepare("SELECT id FROM devices WHERE kvs_channel_arn = ?")
      .bind(input.kvsChannelArn)
      .first<ProvisioningSnapshot["deviceByChannel"]>(),
    d1
      .prepare(
        `SELECT role FROM device_memberships
         WHERE device_id = ? AND user_email = ?`,
      )
      .bind(input.deviceId, input.ownerEmail)
      .first<ProvisioningSnapshot["membership"]>(),
    d1
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE
             WHEN user_email = ? AND role = 'owner' THEN 1 ELSE 0
           END), 0) AS exact_count
         FROM device_memberships WHERE device_id = ?`,
      )
      .bind(input.ownerEmail, input.deviceId)
      .first<ProvisioningSnapshot["membershipSummary"]>(),
    d1
      .prepare("SELECT device_id FROM device_state WHERE device_id = ?")
      .bind(input.deviceId)
      .first<ProvisioningSnapshot["state"]>(),
    d1
      .prepare(
        `SELECT id, device_id, label, token_digest, expires_at, revoked_at
         FROM device_credentials WHERE id = ?`,
      )
      .bind(input.credential.id)
      .first<ProvisioningSnapshot["credentialById"]>(),
    d1
      .prepare("SELECT id FROM device_credentials WHERE token_digest = ?")
      .bind(input.credential.tokenDigest)
      .first<ProvisioningSnapshot["credentialByDigest"]>(),
    d1
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE
             WHEN id = ? AND label = ? AND token_digest = ?
              AND expires_at = ? AND revoked_at IS NULL
             THEN 1 ELSE 0
           END), 0) AS exact_count
         FROM device_credentials WHERE device_id = ?`,
      )
      .bind(
        input.credential.id,
        input.credential.label,
        input.credential.tokenDigest,
        input.credential.expiresAt,
        input.deviceId,
      )
      .first<ProvisioningSnapshot["credentialSummary"]>(),
  ]);
  const channelOwnerSummary =
    deviceByChannel && deviceByChannel.id !== input.deviceId
      ? await d1
          .prepare(
            `SELECT
               devices.display_name,
               (SELECT COUNT(*) FROM device_memberships
                WHERE device_id = devices.id) AS membership_count,
               (SELECT COUNT(*) FROM device_memberships
                WHERE device_id = devices.id
                  AND user_email = ? AND role = 'owner')
                 AS requested_owner_count,
               (SELECT COUNT(*) FROM device_credentials
                WHERE device_id = devices.id) AS credential_count,
               (SELECT COUNT(*) FROM stream_sessions
                WHERE device_id = devices.id) AS session_count,
               (SELECT COUNT(*) FROM stream_sessions
                WHERE device_id = devices.id AND status = 'active'
                  AND expires_at > ?) AS active_session_count,
               (SELECT COUNT(*) FROM recording_sessions
                INNER JOIN stream_sessions
                  ON stream_sessions.id = recording_sessions.session_id
                WHERE stream_sessions.device_id = devices.id)
                 AS recording_count,
               (SELECT COUNT(*) FROM homecam_events
                WHERE device_id = devices.id) AS event_count,
               (SELECT last_seen_at FROM device_state
                WHERE device_id = devices.id) AS last_seen_at
             FROM devices WHERE devices.id = ?`,
          )
          .bind(input.ownerEmail, new Date().toISOString(), deviceByChannel.id)
          .first<ProvisioningSnapshot["channelOwnerSummary"]>()
      : null;
  return {
    deviceById,
    deviceByChannel,
    membership,
    membershipSummary: membershipSummary ?? { total: 0, exact_count: 0 },
    state,
    credentialById,
    credentialByDigest,
    credentialSummary: credentialSummary ?? { total: 0, exact_count: 0 },
    channelOwnerSummary,
  };
}

function isEmpty(snapshot: ProvisioningSnapshot) {
  return (
    !snapshot.deviceById &&
    !snapshot.deviceByChannel &&
    !snapshot.membership &&
    snapshot.membershipSummary.total === 0 &&
    !snapshot.state &&
    !snapshot.credentialById &&
    !snapshot.credentialByDigest &&
    snapshot.credentialSummary.total === 0
  );
}

function isCompleteAndCompatible(
  snapshot: ProvisioningSnapshot,
  input: HomecamProvisioningInput,
) {
  return (
    Boolean(
      snapshot.deviceById &&
        snapshot.deviceByChannel &&
        snapshot.membership &&
        snapshot.state &&
        snapshot.credentialById &&
        snapshot.credentialByDigest,
    ) &&
    snapshot.membershipSummary.total === 1 &&
    snapshot.membershipSummary.exact_count === 1 &&
    snapshot.credentialSummary.total === 1 &&
    snapshot.credentialSummary.exact_count === 1 &&
    isCompatible(snapshot, input)
  );
}

function isCompatible(
  snapshot: ProvisioningSnapshot,
  input: HomecamProvisioningInput,
) {
  return (
    snapshot.deviceById?.display_name === input.displayName &&
    snapshot.deviceById.kvs_channel_arn === input.kvsChannelArn &&
    snapshot.deviceByChannel?.id === input.deviceId &&
    snapshot.membership?.role === "owner" &&
    snapshot.credentialById?.device_id === input.deviceId &&
    snapshot.credentialById.label === input.credential.label &&
    snapshot.credentialById.token_digest === input.credential.tokenDigest &&
    snapshot.credentialById.expires_at === input.credential.expiresAt &&
    snapshot.credentialById.revoked_at === null &&
    snapshot.credentialByDigest?.id === input.credential.id
  );
}

function provisioningConflictDetails(
  snapshot: ProvisioningSnapshot,
  input: HomecamProvisioningInput,
) {
  const targetDevice = !snapshot.deviceById
    ? "absent"
    : snapshot.deviceById.display_name === input.displayName &&
        snapshot.deviceById.kvs_channel_arn === input.kvsChannelArn
      ? "exact"
      : "mismatch";
  const channelOwner = !snapshot.deviceByChannel
    ? "free"
    : snapshot.deviceByChannel.id === input.deviceId
      ? "target"
      : "other";
  return {
    targetDevice,
    channelOwner,
    channelOwnerDeviceId:
      channelOwner === "other" ? snapshot.deviceByChannel?.id : undefined,
    membershipCount: snapshot.membershipSummary.total,
    exactMembershipCount: snapshot.membershipSummary.exact_count,
    stateExists: Boolean(snapshot.state),
    credentialCount: snapshot.credentialSummary.total,
    exactCredentialCount: snapshot.credentialSummary.exact_count,
    credentialIdMatches:
      !snapshot.credentialById ||
      snapshot.credentialById.device_id === input.deviceId,
    credentialDigestMatches:
      !snapshot.credentialByDigest ||
      snapshot.credentialByDigest.id === input.credential.id,
    channelOwnerSummary: snapshot.channelOwnerSummary
      ? {
          displayName: snapshot.channelOwnerSummary.display_name,
          membershipCount: snapshot.channelOwnerSummary.membership_count,
          requestedOwnerCount:
            snapshot.channelOwnerSummary.requested_owner_count,
          credentialCount: snapshot.channelOwnerSummary.credential_count,
          sessionCount: snapshot.channelOwnerSummary.session_count,
          activeSessionCount:
            snapshot.channelOwnerSummary.active_session_count,
          recordingCount: snapshot.channelOwnerSummary.recording_count,
          eventCount: snapshot.channelOwnerSummary.event_count,
          lastSeenAt: snapshot.channelOwnerSummary.last_seen_at,
        }
      : undefined,
  };
}
