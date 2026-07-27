import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const P2P_ARN =
  "arn:aws:kinesisvideo:ap-northeast-2:000000000000:channel/homecam-p2p/1783859169461";
const STORAGE_ARN =
  "arn:aws:kinesisvideo:ap-northeast-2:000000000000:channel/homecam-storage/1784012796922";

class D1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1Statement(this.database, this.sql, bindings);
  }

  first() {
    return this.database.prepare(this.sql).get(...this.bindings) ?? null;
  }

  execute() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { meta: { changes: Number(result.changes) } };
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
    this.failBatchAt = null;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.failBatchAt === index) {
          throw new Error("FORCED_BATCH_FAILURE");
        }
        results.push(statements[index].execute());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function createHarness() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0000_mature_vulcan.sql",
    "0001_round_dakota_north.sql",
    "0002_right_spacker_dave.sql",
    "0003_recording_sessions.sql",
    "0004_homecam_platform.sql",
  ]) {
    const sql = await readFile(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    );
    database.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }
  const d1 = new D1Database(database);
  const source = await readFile(
    new URL("../db/homecam-provisioning.ts", import.meta.url),
    "utf8",
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const commonJsModule = { exports: {} };
  runInNewContext(javascript, {
    module: commonJsModule,
    exports: commonJsModule.exports,
    require(specifier) {
      if (specifier === ".") return { getD1: () => d1 };
      if (specifier === "./homecam") {
        return { ensureHomecamSchema: async () => {} };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
    crypto: globalThis.crypto,
  });
  return {
    database,
    d1,
    provisionHomecamDevice:
      commonJsModule.exports.provisionHomecamDevice,
  };
}

function seedLegacyDevice(database) {
  database
    .prepare(
      `INSERT INTO devices (id, display_name, kvs_channel_arn)
       VALUES (?, ?, ?)`,
    )
    .run("laptop-camera-01", "노트북 카메라 01", P2P_ARN);
  database
    .prepare(
      `INSERT INTO device_memberships (device_id, user_email, role)
       VALUES (?, ?, 'owner')`,
    )
    .run("laptop-camera-01", "owner@example.com");
  for (let index = 0; index < 12; index += 1) {
    const sessionId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    database
      .prepare(
        `INSERT INTO stream_sessions
         (id, room_code, device_id, started_by, status, started_at, expires_at)
         VALUES (?, ?, ?, ?, 'expired', ?, ?)`,
      )
      .run(
        sessionId,
        `R${String(index).padStart(5, "0")}`,
        "laptop-camera-01",
        "owner@example.com",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T01:00:00.000Z",
      );
    if (index < 6) {
      database
        .prepare(
          `INSERT INTO recording_sessions
           (session_id, kvs_stream_arn, kvs_channel_arn)
           VALUES (?, ?, ?)`,
        )
        .run(
          sessionId,
          `arn:aws:kinesisvideo:ap-northeast-2:000000000000:stream/archive-${index}/1784012797641`,
          STORAGE_ARN,
        );
    }
  }
}

function provisioningInput() {
  return {
    deviceId: "gazebo-homecam",
    displayName: "Gazebo 홈캠",
    ownerEmail: "owner@example.com",
    sourceProfile: "sim",
    kvsChannelArn: P2P_ARN,
    migrationChannelArn: STORAGE_ARN,
    legacyDeviceId: "laptop-camera-01",
    credential: {
      id: "a1bf0d3d-d84c-49e1-aaed-533328473dfb",
      label: "Production credential",
      tokenDigest:
        "e4a6776a63f7c9d33b819c7452fd903a9c128a442d06b649324bfeec4130a575",
      expiresAt: "2026-10-25T11:37:26.020Z",
    },
  };
}

test("legacy device migration preserves ownership, sessions, and recordings", async () => {
  const harness = await createHarness();
  seedLegacyDevice(harness.database);

  const result = await harness.provisionHomecamDevice(provisioningInput());
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    deviceId: "gazebo-homecam",
    created: true,
    migrated: true,
  });
  assert.equal(
    harness.database
      .prepare("SELECT COUNT(*) AS count FROM devices WHERE id = ?")
      .get("laptop-camera-01").count,
    0,
  );
  assert.equal(
    harness.database
      .prepare(
        "SELECT COUNT(*) AS count FROM device_memberships WHERE device_id = ? AND user_email = ? AND role = 'owner'",
      )
      .get("gazebo-homecam", "owner@example.com").count,
    1,
  );
  assert.equal(
    harness.database
      .prepare(
        "SELECT COUNT(*) AS count FROM stream_sessions WHERE device_id = ?",
      )
      .get("gazebo-homecam").count,
    12,
  );
  assert.equal(
    harness.database
      .prepare("SELECT COUNT(*) AS count FROM recording_sessions")
      .get().count,
    6,
  );
  assert.equal(
    harness.database
      .prepare(
        "SELECT COUNT(*) AS count FROM device_credentials WHERE device_id = ?",
      )
      .get("gazebo-homecam").count,
    1,
  );
  assert.equal(
    harness.database
      .prepare("SELECT COUNT(*) AS count FROM device_state WHERE device_id = ?")
      .get("gazebo-homecam").count,
    1,
  );
});

test("a failed migration batch rolls back every legacy device change", async () => {
  const harness = await createHarness();
  seedLegacyDevice(harness.database);
  harness.d1.failBatchAt = 6;

  await assert.rejects(
    harness.provisionHomecamDevice(provisioningInput()),
    /FORCED_BATCH_FAILURE/,
  );
  assert.equal(
    harness.database
      .prepare("SELECT kvs_channel_arn FROM devices WHERE id = ?")
      .get("laptop-camera-01").kvs_channel_arn,
    P2P_ARN,
  );
  assert.equal(
    harness.database
      .prepare("SELECT COUNT(*) AS count FROM devices WHERE id = ?")
      .get("gazebo-homecam").count,
    0,
  );
  assert.equal(
    harness.database
      .prepare(
        "SELECT COUNT(*) AS count FROM stream_sessions WHERE device_id = ?",
      )
      .get("laptop-camera-01").count,
    12,
  );
  assert.equal(
    harness.database
      .prepare("SELECT COUNT(*) AS count FROM recording_sessions")
      .get().count,
    6,
  );
});
