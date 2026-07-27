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
};

export class HomecamProvisioningConflict extends Error {
  constructor() {
    super("HOMECAM_PROVISIONING_CONFLICT");
  }
}

export async function provisionHomecamDevice(
  input: HomecamProvisioningInput,
) {
  await ensureHomecamSchema();
  const before = await provisioningSnapshot(input);
  assertCompatible(before, input);

  const d1 = getD1();
  const nowIso = new Date().toISOString();
  const statements = [];
  if (!before.deviceById) {
    statements.push(
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
    );
  }
  if (!before.membership) {
    statements.push(
      d1
        .prepare(
          `INSERT INTO device_memberships
           (device_id, user_email, role, created_at)
           VALUES (?, ?, 'owner', ?)`,
        )
        .bind(input.deviceId, input.ownerEmail, nowIso),
    );
  }
  if (!before.state) {
    statements.push(
      d1
        .prepare(
          `INSERT INTO device_state
           (device_id, monitoring_enabled, camera_enabled, microphone_enabled,
            source_profile, active_stream_mode, media_healthy,
            detector_healthy, updated_at)
           VALUES (?, 0, 1, 1, ?, 'idle', 0, 0, ?)`,
        )
        .bind(input.deviceId, input.sourceProfile, nowIso),
    );
  }
  if (!before.credentialById) {
    statements.push(
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
    );
  }

  const created = statements.length > 0;
  if (created) {
    statements.push(
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
    );
    try {
      await d1.batch(statements);
    } catch (error) {
      const afterRace = await provisioningSnapshot(input);
      if (!isCompleteAndCompatible(afterRace, input)) {
        if (!isCompatible(afterRace, input)) {
          throw new HomecamProvisioningConflict();
        }
        throw error;
      }
      return { deviceId: input.deviceId, created: false };
    }
  }

  const after = await provisioningSnapshot(input);
  if (!isCompleteAndCompatible(after, input)) {
    throw new HomecamProvisioningConflict();
  }
  return { deviceId: input.deviceId, created };
}

async function provisioningSnapshot(
  input: HomecamProvisioningInput,
): Promise<ProvisioningSnapshot> {
  const d1 = getD1();
  const [
    deviceById,
    deviceByChannel,
    membership,
    state,
    credentialById,
    credentialByDigest,
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
  ]);
  return {
    deviceById,
    deviceByChannel,
    membership,
    state,
    credentialById,
    credentialByDigest,
  };
}

function assertCompatible(
  snapshot: ProvisioningSnapshot,
  input: HomecamProvisioningInput,
) {
  if (!isCompatible(snapshot, input)) {
    throw new HomecamProvisioningConflict();
  }
}

function isCompleteAndCompatible(
  snapshot: ProvisioningSnapshot,
  input: HomecamProvisioningInput,
) {
  return (
    Boolean(
      snapshot.deviceById &&
        snapshot.membership &&
        snapshot.state &&
        snapshot.credentialById,
    ) && isCompatible(snapshot, input)
  );
}

function isCompatible(
  snapshot: ProvisioningSnapshot,
  input: HomecamProvisioningInput,
) {
  const deviceMatches =
    !snapshot.deviceById ||
    (snapshot.deviceById.display_name === input.displayName &&
      snapshot.deviceById.kvs_channel_arn === input.kvsChannelArn);
  const channelMatches =
    !snapshot.deviceByChannel ||
    snapshot.deviceByChannel.id === input.deviceId;
  const membershipMatches =
    !snapshot.membership || snapshot.membership.role === "owner";
  const credentialMatches =
    !snapshot.credentialById ||
    (snapshot.credentialById.device_id === input.deviceId &&
      snapshot.credentialById.label === input.credential.label &&
      snapshot.credentialById.token_digest ===
        input.credential.tokenDigest &&
      snapshot.credentialById.expires_at === input.credential.expiresAt &&
      snapshot.credentialById.revoked_at === null);
  const digestMatches =
    !snapshot.credentialByDigest ||
    snapshot.credentialByDigest.id === input.credential.id;
  return (
    deviceMatches &&
    channelMatches &&
    membershipMatches &&
    credentialMatches &&
    digestMatches
  );
}
